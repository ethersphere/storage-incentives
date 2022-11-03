// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./OrderStatisticsTree/HitchensOrderStatisticsTreeLib.sol";

// import "hardhat/console.sol";

// there are two concpetual variables which are kept track of and updated during various transactions
// the first is the batch normalised balance. this value is per chunk and represents
// the remaining balance for that chunk, _as if the chunk had been paid for since the beginning of time_
// when the batch is bought, the batch is credited with a remaining balance as if the chunk had
// existed since the beginning of time, all batch normalised balances are therefore absolute
// using this concept, we can simply define a single figure, the max normalised batch balance
// such that the batch is valid at any given block. this is called the "currentTotalOutpayment"

// the other variable that is kept track of is the total amount of chunks that are allowed in the swarm
// at any given time. this is called the "valid chunk count".

// both of these variables are tracked on a global and per batch basis for efficiency purposes.

// expire batch must be

/**
 * @title PostageStamp contract
 * @author The Swarm Authors
 * @dev The postage stamp contracts allows users to create and manage postage stamp batches.
 */
contract PostageStamp is AccessControl, Pausable {
    using HitchensOrderStatisticsTreeLib for HitchensOrderStatisticsTreeLib.Tree;

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

    struct Batch {
        // Owner of this batch (0 if not valid).
        address owner;
        // Current depth of this batch.
        uint8 depth;
        // Whether this batch is immutable
        bool immutableFlag;
        // Normalised balance per chunk.
        uint256 normalisedBalance;
    }

    // The role allowed to increase totalOutPayment
    bytes32 public constant PRICE_ORACLE_ROLE = keccak256("PRICE_ORACLE");
    // The role allowed to pause
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    // The role allowed to withdraw pot
    bytes32 public constant REDISTRIBUTOR_ROLE = keccak256("REDISTRIBUTOR_ROLE");
    // The role allowed to withdraw pot
    bytes32 public constant DEPTH_ORACLE_ROLE = keccak256("DEPTH_ORACLE_ROLE");

    // Associate every batch id with batch data.
    mapping(bytes32 => Batch) public batches;
    // Store every batch id ordered by normalisedBalance
    HitchensOrderStatisticsTreeLib.Tree tree;

    // The address of the BZZ ERC20 token this contract references.
    address public bzzToken;
    // The total out payment per chunk
    uint256 private totalOutPayment;

    //
    uint8 public minimumBatchDepth;

    // Combined global chunk capacity of valid batches remaining
    // at the _value of the last block expire() was called_
    uint256 public validChunkCount;

    // Lottery pot at last update
    uint256 public pot;

    // the price from the last update
    uint256 public lastPrice;
    // the block at which the last update occured
    uint256 public lastUpdatedBlock;
    // the normalised balance at which the last expiry occured
    uint256 public lastExpiryBalance;

    /**
     * @param _bzzToken The ERC20 token address to reference in this contract.
     */
    constructor(address _bzzToken) {
        bzzToken = _bzzToken;
        minimumBatchDepth = 15;
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(PAUSER_ROLE, msg.sender);
    }

    /**
     * @notice Create a new batch.
     * @dev At least `_initialBalancePerChunk*2^depth` number of tokens need to be preapproved for this contract.
     * @param _owner The owner of the new batch.
     * @param _initialBalancePerChunk The initial balance per chunk of the batch.
     * @param _depth The initial depth of the new batch.
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
        require(_owner != address(0), "owner cannot be the zero address");
        // bucket depth should be non-zero and smaller than the depth
        require(_bucketDepth != 0 && _bucketDepth < _depth && minimumBatchDepth < _bucketDepth, "invalid bucket depth");
        // Derive batchId from msg.sender to ensure another party cannot use the same batch id and frontrun us.
        bytes32 batchId = keccak256(abi.encode(msg.sender, _nonce));
        require(batches[batchId].owner == address(0), "batch already exists");

        // per chunk balance times the batch size must be transferred from the sender
        uint256 totalAmount = _initialBalancePerChunk * (1 << _depth);
        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), totalAmount), "failed transfer");

        // normalisedBalance is an absolute value, as if the batch had existed
        // since the contract was deployed, so we must supplement this batch's
        // _initialBalancePerChunk with the currentTotalOutPayment()
        uint256 normalisedBalance = currentTotalOutPayment() + (_initialBalancePerChunk);

        //expire the batches to update the validChunkCount up to this block
        expire();

        //then add the chunks this batch is responsible for
        validChunkCount += 1 << _depth;

        batches[batchId] = Batch({
            owner: _owner,
            depth: _depth,
            immutableFlag: _immutable,
            normalisedBalance: normalisedBalance
        });
        require(normalisedBalance > 0, "normalised balance cannot be zero");
        // insert into ordered statistic tree
        tree.insert(batchId, normalisedBalance);
        emit BatchCreated(batchId, totalAmount, normalisedBalance, _owner, _depth, _bucketDepth, _immutable);
    }

    /**
     * @notice Create a new batch.
     * @dev At least `_initialBalancePerChunk*2^depth` number of tokens need to be preapproved for this contract.
     * @param _owner The owner of the new batch.
     * @param _initialBalancePerChunk The initial balance per chunk of the batch.
     * @param _depth The initial depth of the new batch.
     * @param _batchId The batchId being copied (from previous version contract data).
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
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "only administrator can use copy method");
        require(_owner != address(0), "owner cannot be the zero address");
        // bucket depth should be non-zero and smaller than the depth
        require(_bucketDepth != 0 && _bucketDepth < _depth, "invalid bucket depth");
        // Derive batchId from msg.sender to ensure another party cannot use the same batch id and frontrun us.
        require(batches[_batchId].owner == address(0), "batch already exists");

        // per chunk balance times the batch size is what we need to transfer in
        uint256 totalAmount = _initialBalancePerChunk * (1 << _depth);
        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), totalAmount), "failed transfer");

        uint256 normalisedBalance = currentTotalOutPayment() + (_initialBalancePerChunk);

        validChunkCount += 1 << _depth;

        batches[_batchId] = Batch({
            owner: _owner,
            depth: _depth,
            immutableFlag: _immutable,
            normalisedBalance: normalisedBalance
        });
        require(normalisedBalance > 0, "normalised balance cannot be zero");
        // insert into ordered statistic tree
        tree.insert(_batchId, normalisedBalance);
        emit BatchCreated(_batchId, totalAmount, normalisedBalance, _owner, _depth, _bucketDepth, _immutable);
    }

    /**
     * @notice Top up an existing batch.
     * @dev At least `topupAmount*2^depth` number of tokens need to be preapproved for this contract.
     * @param _batchId The id of the existing batch.
     * @param _topupAmountPerChunk The amount of additional tokens to add per chunk.
     */
    function topUp(bytes32 _batchId, uint256 _topupAmountPerChunk) external whenNotPaused {
        Batch storage batch = batches[_batchId];
        require(batch.owner != address(0), "batch does not exist");
        require(batch.normalisedBalance > currentTotalOutPayment(), "batch already expired");
        require(batch.depth > minimumBatchDepth, "batch too small to renew");
        // per chunk topup amount times the batch size is what we need to transfer in
        uint256 totalAmount = _topupAmountPerChunk * (1 << batch.depth);
        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), totalAmount), "failed transfer");

        // updates by removing and then inserting
        // removed normalised balance in ordered tree
        tree.remove(_batchId, batch.normalisedBalance);
        batch.normalisedBalance = batch.normalisedBalance + (_topupAmountPerChunk);
        // insert normalised balance in ordered tree
        tree.insert(_batchId, batch.normalisedBalance);

        emit BatchTopUp(_batchId, totalAmount, batch.normalisedBalance);
    }

    /**
     * @notice Increase the depth of an existing batch.
     * @dev Can only be called by the owner of the batch.
     * @param _batchId the id of the existing batch
     * @param _newDepth the new (larger than the previous one) depth for this batch
     */
    function increaseDepth(bytes32 _batchId, uint8 _newDepth) external whenNotPaused {
        Batch storage batch = batches[_batchId];
        require(batch.owner == msg.sender, "not batch owner");
        require(!batch.immutableFlag, "batch is immutable");
        require(_newDepth > batch.depth && _newDepth > minimumBatchDepth, "depth not increasing");
        require(batch.normalisedBalance > currentTotalOutPayment(), "batch already expired");

        uint8 depthChange = _newDepth - batch.depth;
        // divide by the change in batch size (2^depthChange)
        uint256 newRemainingBalance = remainingBalance(_batchId) / (1 << depthChange);

        // expire batches up to current block before amending validChunkCount to include
        // the new chunks resultant from the depth increase
        expire();
        validChunkCount += (1 << _newDepth) - (1 << batch.depth);

        // updates by removing and then inserting
        // removed normalised balance in ordered tree
        tree.remove(_batchId, batch.normalisedBalance);
        batch.depth = _newDepth;
        batch.normalisedBalance = currentTotalOutPayment() + (newRemainingBalance);
        // insert normalised balance in ordered tree
        tree.insert(_batchId, batch.normalisedBalance);

        emit BatchDepthIncrease(_batchId, _newDepth, batch.normalisedBalance);
    }

    /**
     * @notice Returns the per chunk balance not used up yet
     * @param _batchId the id of the existing batch
     */
    function remainingBalance(bytes32 _batchId) public view returns (uint256) {
        Batch storage batch = batches[_batchId];
        require(batch.owner != address(0), "batch does not exist");
        if (batch.normalisedBalance <= currentTotalOutPayment()) {
            return 0;
        }
        return batch.normalisedBalance - currentTotalOutPayment();
    }

    /**
     * @notice set a new price
     * @dev can only be called by the price oracle
     * @param _price the new price
     */
    function setPrice(uint256 _price) external {
        require(hasRole(PRICE_ORACLE_ROLE, msg.sender), "only price oracle can set the price");

        // if there was a last price, charge for the time since the last update with the last price
        if (lastPrice != 0) {
            totalOutPayment = currentTotalOutPayment();
        }

        lastPrice = _price;
        lastUpdatedBlock = block.number;

        emit PriceUpdate(_price);
    }

    /**
     * @notice current minimum valid batch normalised balance
     * @dev batch normalised balance is per chunk
     */
    // this is an amount that has been normalised for calculation purposes
    // to be the amount that would have been paid out for all time
    // if all the batches had started in the block the contract was deployed in
    // the totalOutPayment figure is stored and updated when setPrice() is called
    // this is a view function which adds the outpayment that has accumulated
    // since the last price change to that updated figure
    function currentTotalOutPayment() public view returns (uint256) {
        uint256 blocks = block.number - lastUpdatedBlock;
        uint256 increaseSinceLastUpdate = lastPrice * (blocks);
        return totalOutPayment + (increaseSinceLastUpdate);
    }

    /**
     * @notice Pause the contract. The contract is provably stopped by renouncing the pauser role and the admin role after pausing
     * @dev can only be called by the pauser when not paused
     */
    function pause() public {
        require(hasRole(PAUSER_ROLE, msg.sender), "only pauser can pause the contract");
        _pause();
    }

    /**
     * @notice Unpause the contract.
     * @dev can only be called by the pauser when paused
     */
    function unPause() public {
        require(hasRole(PAUSER_ROLE, msg.sender), "only pauser can unpause the contract");
        _unpause();
    }

    /**
     * @notice Returns true if no batches
     */
    function empty() public view returns (bool) {
        return tree.count() == 0;
    }

    /**
     * @notice Gets the first batch id
     * @dev if more than one batch id, returns index at 0, if no batches, reverts
     */
    function firstBatchId() public view returns (bytes32) {
        uint256 val = tree.first();
        require(val > 0);
        return tree.valueKeyAtIndex(val, 0);
    }

    /**
     * @notice Reclaims expired batches and adds their value to pot
     */
    function expire() public {
        // remember the previous lastExpiryBalance, this is the lower bound of the
        // period during which we will check if batches have expired
        uint256 leb = lastExpiryBalance;
        // update the lastExpiryBalance for next time, this will also for the
        // upper bound of the period we will check if batches have expired during
        lastExpiryBalance = currentTotalOutPayment();
        for (;;) {
            if (empty()) break;
            // get the batch with the currently smallest normalised balance
            bytes32 fbi = firstBatchId();
            // if the batch with the smallest balance has not yet expired
            // we have already reached the end of the batches we need
            // to expire during this period, so exit the loop
            if (remainingBalance(fbi) > 0) break;
            // otherwise, the batch with the smallest balance has _not_ expired
            // so we must remove this batch's contribution to the global validChunkCount
            Batch storage batch = batches[fbi];
            uint256 batchSize = 1 << batch.depth;
            require(validChunkCount >= batchSize , "insufficient valid chunk count");
            validChunkCount -= batchSize;
            // since this batch has expired _during_ the period
            // we add this batch's contribution to the pot
            // for the period until it expired
            // this is the per-chunk outPayment of this batch for the period
            // since the last expiry, multiplied by the batch size in chunks
            pot += batchSize * (batch.normalisedBalance - leb);
            tree.remove(fbi, batch.normalisedBalance);
            delete batches[fbi];
        }

        require(lastExpiryBalance >= leb, "current total outpayment should never decrease");

        // finally, for all batches that _have not expired yet_
        // add the total normalised payout of all batches
        // multiplied by the remaining total valid chunk count
        // to the pot for the period since the last expiry
        pot += validChunkCount * (lastExpiryBalance - leb);
    }

    /**
     * @notice Reclaims a limited number of expired batches
     * @dev Might be needed if reclaiming all expired batches would exceed the block gas limit.
     */
    function expireLimited(uint256 limit) external {
        uint256 i;
        for (i = 0; i < limit; i++) {
            if (empty()) break;
            bytes32 fbi = firstBatchId();
            if (remainingBalance(fbi) > 0) break;
            Batch storage batch = batches[fbi];
            uint256 batchSize = 1 << batch.depth;
            require(validChunkCount >= batchSize , "insufficient valid chunk count");
            validChunkCount -= batchSize;
            pot += batchSize * (batch.normalisedBalance - lastExpiryBalance);
            tree.remove(fbi, batch.normalisedBalance);
            delete batches[fbi];
        }
    }

    /**
     * @notice Returns the total lottery pot so far
     */
    function totalPot() public returns (uint256) {
        expire();
        uint256 balance = ERC20(bzzToken).balanceOf(address(this));
        return pot < balance ? pot : balance;
    }

    /**
     * @notice Withdraw the pot, authorised callers only
     */

    function withdraw(address beneficiary) external {
        require(hasRole(REDISTRIBUTOR_ROLE, msg.sender), "only redistributor can withdraw from the contract");
        require(ERC20(bzzToken).transfer(beneficiary, totalPot()), "failed transfer");
        pot = 0;
    }

    /**
     * @notice Topup the pot
     */
    function topupPot(uint256 amount) external {
        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), amount), "failed transfer");
        pot += amount;
    }

    /**
     * @notice Set minimum batch depth
     */
    function setMinimumBatchDepth(uint8 min) external {
        require(hasRole(DEPTH_ORACLE_ROLE, msg.sender), "only depth oracle can set minimum batch depth");
        minimumBatchDepth = min;
    }
}
