// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./OrderStatisticsTree/HitchensOrderStatisticsTreeLib.sol";

/**
 * @title PostageStamp contract
 * @author The Swarm Authors
 * @dev The postage stamp contracts allows users to create and manage postage stamp batches.
 * The current balance for each batch is stored ordered in descending order of normalised balance.
 * Balance is normalised to be per chunk and the total spend since the contract was deployed, i.e. when a batch
 * is bought, its per-chunk balance is supplemented with the current cost of storing one chunk since the beginning of time,
 * as if the batch had existed since the contract's inception. During the _expiry_ process, each of these balances is
 * checked against the _currentTotalOutPayment_, a similarly normalised figure that represents the current cost of
 * storing one chunk since the beginning of time. A batch with a normalised balance less than _currentTotalOutPayment_
 * is treated as expired.
 *
 * The _currentTotalOutPayment_ is calculated using _totalOutPayment_ which is updated during _setPrice_ events so
 * that the applicable per-chunk prices can be charged for the relevant periods of time. This can then be multiplied
 * by the amount of chunks which are allowed to be stamped by each batch to get the actual cost of storage.
 *
 * The amount of chunks a batch can stamp is determined by the _bucketDepth_. A batch may store a maximum of 2^depth chunks.
 * The global figure for the currently allowed chunks is tracked by _validChunkCount_ and updated during batch _expiry_ events.
 */

contract PostageStamp is AccessControl, Pausable {
    using HitchensOrderStatisticsTreeLib for HitchensOrderStatisticsTreeLib.Tree;

    // ----------------------------- State variables ------------------------------

    // Address of the ERC20 token this contract references.
    address public bzzToken;

    // Minimum allowed depth of bucket.
    uint8 public minimumBucketDepth;

    // Role allowed to increase totalOutPayment.
    bytes32 public immutable PRICE_ORACLE_ROLE;

    // Role allowed to pause
    bytes32 public immutable PAUSER_ROLE;
    // Role allowed to withdraw the pot.
    bytes32 public immutable REDISTRIBUTOR_ROLE;

    // Associate every batch id with batch data.
    mapping(bytes32 => Batch) public batches;
    // Store every batch id ordered by normalisedBalance.
    HitchensOrderStatisticsTreeLib.Tree tree;

    // Total out payment per chunk, at the blockheight of the last price change.
    uint256 private totalOutPayment;

    // Combined global chunk capacity of valid batches remaining at the blockheight expire() was last called.
    uint256 public validChunkCount;

    // Lottery pot at last update.
    uint256 public pot;

    // Normalised balance at the blockheight expire() was last called.
    uint256 public lastExpiryBalance;

    // Price from the last update.
    uint64 public lastPrice;

    // blocks in 24 hours ~ 24 * 60 * 60 / 5 = 17280
    uint64 public minimumValidityBlocks = 17280;

    // Block at which the last update occured.
    uint64 public lastUpdatedBlock;

    // ----------------------------- Type declarations ------------------------------

    struct Batch {
        // Owner of this batch (0 if not valid).
        address owner;
        // Current depth of this batch.
        uint8 depth;
        // Bucket depth defined in this batch
        uint8 bucketDepth;
        // Whether this batch is immutable.
        bool immutableFlag;
        // Normalised balance per chunk.
        uint256 normalisedBalance;
        // When was this batch last updated
        uint256 lastUpdatedBlockNumber;
    }

    // ----------------------------- Events ------------------------------

    /**
     * @dev Emitted when a new batch is created.
     */
    event BatchCreated(
        bytes32 indexed batchId,
        uint256 totalAmount,
        uint256 normalisedBalance,
        address owner,
        uint8 depth,
        uint8 bucketDepth,
        bool immutableFlag
    );

    /**
     * @dev Emitted when an pot is Withdrawn.
     */
    event PotWithdrawn(address recipient, uint256 totalAmount);

    /**
     * @dev Emitted when an existing batch is topped up.
     */
    event BatchTopUp(bytes32 indexed batchId, uint256 topupAmount, uint256 normalisedBalance);

    /**
     * @dev Emitted when the depth of an existing batch increases.
     */
    event BatchDepthIncrease(bytes32 indexed batchId, uint8 newDepth, uint256 normalisedBalance);

    /**
     *@dev Emitted on every price update.
     */
    event PriceUpdate(uint256 price);

    // ----------------------------- Errors ------------------------------

    error ZeroAddress(); // Owner cannot be the zero address
    error InvalidDepth(); // Invalid bucket depth
    error BatchExists(); // Batch already exists
    error InsufficientBalance(); // Insufficient initial balance for 24h minimum validity
    error TransferFailed(); // Failed transfer of BZZ tokens
    error ZeroBalance(); // NormalisedBalance cannot be zero
    error AdministratorOnly(); // Only administrator can use copy method
    error BatchDoesNotExist(); // Batch does not exist or has expired
    error BatchExpired(); // Batch already expired
    error BatchTooSmall(); // Batch too small to renew
    error NotBatchOwner(); // Not batch owner
    error DepthNotIncreasing(); // Depth not increasing
    error PriceOracleOnly(); // Only price oracle can set the price
    error InsufficienChunkCount(); // Insufficient valid chunk count
    error TotalOutpaymentDecreased(); // Current total outpayment should never decrease
    error NoBatchesExist(); // There are no batches
    error OnlyPauser(); // Only Pauser role can pause or unpause contracts
    error OnlyRedistributor(); // Only redistributor role can withdraw from the contract

    // ----------------------------- CONSTRUCTOR ------------------------------

    /**
     * @param _bzzToken The ERC20 token address to reference in this contract.
     * @param _minimumBucketDepth The minimum bucket depth of batches that can be purchased.
     */
    constructor(address _bzzToken, uint8 _minimumBucketDepth, address multisig) {
        bzzToken = _bzzToken;
        minimumBucketDepth = _minimumBucketDepth;
        PRICE_ORACLE_ROLE = keccak256("PRICE_ORACLE_ROLE");
        PAUSER_ROLE = keccak256("PAUSER_ROLE");
        REDISTRIBUTOR_ROLE = keccak256("REDISTRIBUTOR_ROLE");
        _setupRole(DEFAULT_ADMIN_ROLE, multisig);
        _setupRole(PAUSER_ROLE, msg.sender);
    }

    ////////////////////////////////////////
    //            STATE CHANGING          //
    ////////////////////////////////////////

    /**
     * @notice Create a new batch.
     * @dev At least `_initialBalancePerChunk*2^depth` tokens must be approved in the ERC20 token contract.
     * @param _owner Owner of the new batch.
     * @param _initialBalancePerChunk Initial balance per chunk.
     * @param _depth Initial depth of the new batch.
     * @param _nonce A random value used in the batch id derivation to allow multiple batches per owner.
     * @param _immutable Whether the batch is mutable.
     */
    function createBatch(
        address _owner,
        uint256 _initialBalancePerChunk,
        uint8 _depth,
        uint8 _bucketDepth,
        bytes32 _nonce,
        bool _immutable
    ) external whenNotPaused {
        if (_owner == address(0)) {
            revert ZeroAddress();
        }

        if (_bucketDepth == 0 || _bucketDepth < minimumBucketDepth || _bucketDepth >= _depth) {
            revert InvalidDepth();
        }

        bytes32 batchId = keccak256(abi.encode(msg.sender, _nonce));
        if (batches[batchId].owner != address(0)) {
            revert BatchExists();
        }

        if (_initialBalancePerChunk < minimumInitialBalancePerChunk()) {
            revert InsufficientBalance();
        }

        uint256 totalAmount = _initialBalancePerChunk * (1 << _depth);
        if (!ERC20(bzzToken).transferFrom(msg.sender, address(this), totalAmount)) {
            revert TransferFailed();
        }

        uint256 normalisedBalance = currentTotalOutPayment() + (_initialBalancePerChunk);
        if (normalisedBalance == 0) {
            revert ZeroBalance();
        }

        expireLimited(type(uint256).max);
        validChunkCount += 1 << _depth;

        batches[batchId] = Batch({
            owner: _owner,
            depth: _depth,
            bucketDepth: _bucketDepth,
            immutableFlag: _immutable,
            normalisedBalance: normalisedBalance,
            lastUpdatedBlockNumber: block.number
        });

        tree.insert(batchId, normalisedBalance);

        emit BatchCreated(batchId, totalAmount, normalisedBalance, _owner, _depth, _bucketDepth, _immutable);
    }

    /**
     * @notice Manually create a new batch when facilitating migration, can only be called by the Admin role.
     * @dev At least `_initialBalancePerChunk*2^depth` tokens must be approved in the ERC20 token contract.
     * @param _owner Owner of the new batch.
     * @param _initialBalancePerChunk Initial balance per chunk of the batch.
     * @param _depth Initial depth of the new batch.
     * @param _batchId BatchId being copied (from previous version contract data).
     * @param _immutable Whether the batch is mutable.
     */
    function copyBatch(
        address _owner,
        uint256 _initialBalancePerChunk,
        uint8 _depth,
        uint8 _bucketDepth,
        bytes32 _batchId,
        bool _immutable
    ) external whenNotPaused {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AdministratorOnly();
        }

        if (_owner == address(0)) {
            revert ZeroAddress();
        }

        if (_bucketDepth == 0 || _bucketDepth >= _depth) {
            revert InvalidDepth();
        }

        if (batches[_batchId].owner != address(0)) {
            revert BatchExists();
        }

        uint256 totalAmount = _initialBalancePerChunk * (1 << _depth);
        uint256 normalisedBalance = currentTotalOutPayment() + (_initialBalancePerChunk);
        if (normalisedBalance == 0) {
            revert ZeroBalance();
        }

        //update validChunkCount to remove currently expired batches
        expireLimited(type(uint256).max);

        validChunkCount += 1 << _depth;

        batches[_batchId] = Batch({
            owner: _owner,
            depth: _depth,
            bucketDepth: _bucketDepth,
            immutableFlag: _immutable,
            normalisedBalance: normalisedBalance,
            lastUpdatedBlockNumber: block.number
        });

        tree.insert(_batchId, normalisedBalance);

        emit BatchCreated(_batchId, totalAmount, normalisedBalance, _owner, _depth, _bucketDepth, _immutable);
    }

    /**
     * @notice Top up an existing batch.
     * @dev At least `_topupAmountPerChunk*2^depth` tokens must be approved in the ERC20 token contract.
     * @param _batchId The id of an existing batch.
     * @param _topupAmountPerChunk The amount of additional tokens to add per chunk.
     */
    function topUp(bytes32 _batchId, uint256 _topupAmountPerChunk) external whenNotPaused {
        Batch memory batch = batches[_batchId];

        if (batch.owner == address(0)) {
            revert BatchDoesNotExist();
        }

        if (batch.normalisedBalance <= currentTotalOutPayment()) {
            revert BatchExpired();
        }

        if (batch.depth <= minimumBucketDepth) {
            revert BatchTooSmall();
        }

        if (remainingBalance(_batchId) + (_topupAmountPerChunk) < minimumInitialBalancePerChunk()) {
            revert InsufficientBalance();
        }

        // per chunk balance multiplied by the batch size in chunks must be transferred from the sender
        uint256 totalAmount = _topupAmountPerChunk * (1 << batch.depth);
        if (!ERC20(bzzToken).transferFrom(msg.sender, address(this), totalAmount)) {
            revert TransferFailed();
        }

        // update by removing batch and then reinserting
        tree.remove(_batchId, batch.normalisedBalance);
        batch.normalisedBalance = batch.normalisedBalance + (_topupAmountPerChunk);
        tree.insert(_batchId, batch.normalisedBalance);

        batches[_batchId].normalisedBalance = batch.normalisedBalance;
        emit BatchTopUp(_batchId, totalAmount, batch.normalisedBalance);
    }

    /**
     * @notice Increase the depth of an existing batch.
     * @dev Can only be called by the owner of the batch.
     * @param _batchId the id of an existing batch.
     * @param _newDepth the new (larger than the previous one) depth for this batch.
     */
    function increaseDepth(bytes32 _batchId, uint8 _newDepth) external whenNotPaused {
        Batch memory batch = batches[_batchId];

        if (batch.owner != msg.sender) {
            revert NotBatchOwner();
        }

        if (!(minimumBucketDepth < _newDepth && batch.depth < _newDepth)) {
            revert DepthNotIncreasing();
        }

        if (batch.normalisedBalance <= currentTotalOutPayment()) {
            revert BatchExpired();
        }

        uint8 depthChange = _newDepth - batch.depth;
        uint256 newRemainingBalance = remainingBalance(_batchId) / (1 << depthChange);

        if (newRemainingBalance < minimumInitialBalancePerChunk()) {
            revert InsufficientBalance();
        }

        expireLimited(type(uint256).max);
        validChunkCount += (1 << _newDepth) - (1 << batch.depth);
        tree.remove(_batchId, batch.normalisedBalance);
        batches[_batchId].depth = _newDepth;
        batches[_batchId].lastUpdatedBlockNumber = block.number;

        batch.normalisedBalance = currentTotalOutPayment() + newRemainingBalance;
        batches[_batchId].normalisedBalance = batch.normalisedBalance;
        tree.insert(_batchId, batch.normalisedBalance);

        emit BatchDepthIncrease(_batchId, _newDepth, batch.normalisedBalance);
    }

    /**
     * @notice Set a new price.
     * @dev Can only be called by the price oracle role.
     * @param _price The new price.
     */
    function setPrice(uint256 _price) external {
        if (!hasRole(PRICE_ORACLE_ROLE, msg.sender)) {
            revert PriceOracleOnly();
        }

        if (lastPrice != 0) {
            totalOutPayment = currentTotalOutPayment();
        }

        lastPrice = uint64(_price);
        lastUpdatedBlock = uint64(block.number);

        emit PriceUpdate(_price);
    }

    function setMinimumValidityBlocks(uint64 _value) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AdministratorOnly();
        }

        minimumValidityBlocks = _value;
    }

    /**
     * @notice Reclaims a limited number of expired batches
     * @dev Can be used if reclaiming all expired batches would exceed the block gas limit, causing other
     * contract method calls to fail.
     * @param limit The maximum number of batches to expire.
     */
    function expireLimited(uint256 limit) public {
        // the lower bound of the normalised balance for which we will check if batches have expired
        uint256 _lastExpiryBalance = lastExpiryBalance;
        uint256 i;
        for (i; i < limit; ) {
            if (isBatchesTreeEmpty()) {
                lastExpiryBalance = currentTotalOutPayment();
                break;
            }
            // get the batch with the smallest normalised balance
            bytes32 fbi = firstBatchId();
            // if the batch with the smallest balance has not yet expired
            // we have already reached the end of the batches we need
            // to expire, so exit the loop
            if (remainingBalance(fbi) > 0) {
                // the upper bound of the normalised balance for which we will check if batches have expired
                // value is updated when there are no expired batches left
                lastExpiryBalance = currentTotalOutPayment();
                break;
            }
            // otherwise, the batch with the smallest balance has expired,
            // so we must remove the chunks this batch contributes to the global validChunkCount
            Batch memory batch = batches[fbi];
            uint256 batchSize = 1 << batch.depth;

            if (validChunkCount < batchSize) {
                revert InsufficienChunkCount();
            }
            validChunkCount -= batchSize;
            // since the batch expired _during_ the period we must add
            // remaining normalised payout for this batch only
            pot += batchSize * (batch.normalisedBalance - _lastExpiryBalance);
            tree.remove(fbi, batch.normalisedBalance);
            delete batches[fbi];

            unchecked {
                ++i;
            }
        }
        // then, for all batches that have _not_ expired during the period
        // add the total normalised payout of all batches
        // multiplied by the remaining total valid chunk count
        // to the pot for the period since the last expiry

        if (lastExpiryBalance < _lastExpiryBalance) {
            revert TotalOutpaymentDecreased();
        }

        // then, for all batches that have _not_ expired during the period
        // add the total normalised payout of all batches
        // multiplied by the remaining total valid chunk count
        // to the pot for the period since the last expiry
        pot += validChunkCount * (lastExpiryBalance - _lastExpiryBalance);
    }

    /**
     * @notice The current pot.
     */
    function totalPot() public returns (uint256) {
        expireLimited(type(uint256).max);
        uint256 balance = ERC20(bzzToken).balanceOf(address(this));
        return pot < balance ? pot : balance;
    }

    /**
     * @notice Withdraw the pot, authorised callers only.
     * @param beneficiary Recieves the current total pot.
     */

    function withdraw(address beneficiary) external {
        if (!hasRole(REDISTRIBUTOR_ROLE, msg.sender)) {
            revert OnlyRedistributor();
        }

        uint256 totalAmount = totalPot();
        if (!ERC20(bzzToken).transfer(beneficiary, totalAmount)) {
            revert TransferFailed();
        }

        emit PotWithdrawn(beneficiary, totalAmount);
        pot = 0;
    }

    /**
     * @notice Pause the contract.
     * @dev Can only be called by the pauser when not paused.
     * The contract can be provably stopped by renouncing the pauser role and the admin role once paused.
     */
    function pause() public {
        if (!hasRole(PAUSER_ROLE, msg.sender)) {
            revert OnlyPauser();
        }
        _pause();
    }

    /**
     * @notice Unpause the contract.
     * @dev Can only be called by the pauser role while paused.
     */
    function unPause() public {
        if (!hasRole(PAUSER_ROLE, msg.sender)) {
            revert OnlyPauser();
        }

        _unpause();
    }

    ////////////////////////////////////////
    //            STATE READING           //
    ////////////////////////////////////////

    /**
     * @notice Total per-chunk cost since the contract's deployment.
     * @dev Returns the total normalised all-time per chunk payout.
     * Only Batches with a normalised balance greater than this are valid.
     */
    function currentTotalOutPayment() public view returns (uint256) {
        uint256 blocks = block.number - lastUpdatedBlock;
        uint256 increaseSinceLastUpdate = lastPrice * (blocks);
        return totalOutPayment + (increaseSinceLastUpdate);
    }

    function minimumInitialBalancePerChunk() public view returns (uint256) {
        return minimumValidityBlocks * lastPrice;
    }

    /**
     * @notice Return the per chunk balance not yet used up.
     * @param _batchId The id of an existing batch.
     */
    function remainingBalance(bytes32 _batchId) public view returns (uint256) {
        Batch memory batch = batches[_batchId];

        if (batch.owner == address(0)) {
            revert BatchDoesNotExist(); // Batch does not exist or expired
        }

        if (batch.normalisedBalance <= currentTotalOutPayment()) {
            return 0;
        }

        return batch.normalisedBalance - currentTotalOutPayment();
    }

    /**
     * @notice Indicates whether expired batches exist.
     */
    function expiredBatchesExist() public view returns (bool) {
        if (isBatchesTreeEmpty()) {
            return false;
        }
        return (remainingBalance(firstBatchId()) <= 0);
    }

    /**
     * @notice Return true if no batches exist
     */
    function isBatchesTreeEmpty() public view returns (bool) {
        return tree.count() == 0;
    }

    /**
     * @notice Get the first batch id ordered by ascending normalised balance.
     * @dev If more than one batch id, return index at 0, if no batches, revert.
     */
    function firstBatchId() public view returns (bytes32) {
        uint256 val = tree.first();
        if (val == 0) {
            revert NoBatchesExist();
        }
        return tree.valueKeyAtIndex(val, 0);
    }

    function batchOwner(bytes32 _batchId) public view returns (address) {
        return batches[_batchId].owner;
    }

    function batchDepth(bytes32 _batchId) public view returns (uint8) {
        return batches[_batchId].depth;
    }

    function batchBucketDepth(bytes32 _batchId) public view returns (uint8) {
        return batches[_batchId].bucketDepth;
    }

    function batchImmutableFlag(bytes32 _batchId) public view returns (bool) {
        return batches[_batchId].immutableFlag;
    }

    function batchNormalisedBalance(bytes32 _batchId) public view returns (uint256) {
        return batches[_batchId].normalisedBalance;
    }

    function batchLastUpdatedBlockNumber(bytes32 _batchId) public view returns (uint256) {
        return batches[_batchId].lastUpdatedBlockNumber;
    }
}
