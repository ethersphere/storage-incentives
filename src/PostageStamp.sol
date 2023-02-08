// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
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

contract PostageStamp is AccessControl, Pausable, Initializable, UUPSUpgradeable, OwnableUpgradeable {
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
        // Whether this batch is immutable.
        bool immutableFlag;
        // Normalised balance per chunk.
        uint256 normalisedBalance;
    }

    // Role allowed to increase totalOutPayment.
    bytes32 public constant PRICE_ORACLE_ROLE = keccak256("PRICE_ORACLE");
    // Role allowed to pause
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    // Role allowed to withdraw the pot.
    bytes32 public constant REDISTRIBUTOR_ROLE = keccak256("REDISTRIBUTOR_ROLE");

    // Associate every batch id with batch data.
    mapping(bytes32 => Batch) public batches;
    // Store every batch id ordered by normalisedBalance.
    HitchensOrderStatisticsTreeLib.Tree tree;

    // Address of the ERC20 token this contract references.
    address public bzzToken;

    // Total out payment per chunk, at the blockheight of the last price change.
    uint256 private totalOutPayment;

    // Minimum allowed depth of bucket.
    uint8 public minimumBucketDepth;

    // Combined global chunk capacity of valid batches remaining at the blockheight expire() was last called.
    uint256 public validChunkCount;

    // Lottery pot at last update.
    uint256 public pot;

    // Price from the last update.
    uint256 public lastPrice = 0;
    // Block at which the last update occured.
    uint256 public lastUpdatedBlock;
    // Normalised balance at the blockheight expire() was last called.
    uint256 public lastExpiryBalance;

    /**
     * @param _bzzToken The ERC20 token address to reference in this contract.
     * @param _minimumBucketDepth The minimum bucket depth of batches that can be purchased.
     */

    /// @dev no constructor in upgradable contracts. Instead we have initializers

    function initialize(uint256 _sliceCount) public initializer {
        bzzToken = _bzzToken;
        minimumBucketDepth = _minimumBucketDepth;
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(PAUSER_ROLE, msg.sender);

        ///@dev as there is no constructor, we need to initialise the OwnableUpgradeable explicitly
        __AccessControl_init();
    }

    ///@dev required by the OZ UUPS module
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

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
        require(_owner != address(0), "owner cannot be the zero address");
        // bucket depth should be non-zero and smaller than the depth
        require(
            _bucketDepth != 0 && minimumBucketDepth <= _bucketDepth && _bucketDepth < _depth,
            "invalid bucket depth"
        );
        // derive batchId from msg.sender to ensure another party cannot use the same batch id and frontrun us.
        bytes32 batchId = keccak256(abi.encode(msg.sender, _nonce));
        require(batches[batchId].owner == address(0), "batch already exists");

        // per chunk balance multiplied by the batch size in chunks must be transferred from the sender
        uint256 totalAmount = _initialBalancePerChunk * (1 << _depth);
        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), totalAmount), "failed transfer");

        // normalisedBalance is an absolute value per chunk, as if the batch had existed
        // since the block the contract was deployed, so we must supplement this batch's
        // _initialBalancePerChunk with the currentTotalOutPayment()
        uint256 normalisedBalance = currentTotalOutPayment() + (_initialBalancePerChunk);

        //update validChunkCount to remove currently expired batches
        expireLimited(type(uint256).max);

        //then add the chunks this batch will contribute
        validChunkCount += 1 << _depth;

        batches[batchId] = Batch({
            owner: _owner,
            depth: _depth,
            immutableFlag: _immutable,
            normalisedBalance: normalisedBalance
        });

        require(normalisedBalance > 0, "normalisedBalance cannot be zero");

        // insert into the ordered tree
        tree.insert(batchId, normalisedBalance);

        emit BatchCreated(batchId, totalAmount, normalisedBalance, _owner, _depth, _bucketDepth, _immutable);
    }

    /**
     * @notice Manually create a new batch when faciliatating migration, can only be called by the Admin role.
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
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "only administrator can use copy method");
        require(_owner != address(0), "owner cannot be the zero address");
        require(_bucketDepth != 0 && _bucketDepth < _depth, "invalid bucket depth");
        require(batches[_batchId].owner == address(0), "batch already exists");

        // per chunk balance multiplied by the batch size in chunks must be transferred from the sender
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

        require(normalisedBalance > 0, "normalisedBalance cannot be zero");

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
        Batch storage batch = batches[_batchId];
        require(batch.owner != address(0), "batch does not exist or has expired");
        require(batch.normalisedBalance > currentTotalOutPayment(), "batch already expired");
        require(batch.depth > minimumBucketDepth, "batch too small to renew");

        // per chunk balance multiplied by the batch size in chunks must be transferred from the sender
        uint256 totalAmount = _topupAmountPerChunk * (1 << batch.depth);
        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), totalAmount), "failed transfer");

        // update by removing batch and then reinserting
        tree.remove(_batchId, batch.normalisedBalance);
        batch.normalisedBalance = batch.normalisedBalance + (_topupAmountPerChunk);
        tree.insert(_batchId, batch.normalisedBalance);

        emit BatchTopUp(_batchId, totalAmount, batch.normalisedBalance);
    }

    /**
     * @notice Increase the depth of an existing batch.
     * @dev Can only be called by the owner of the batch.
     * @param _batchId the id of an existing batch.
     * @param _newDepth the new (larger than the previous one) depth for this batch.
     */
    function increaseDepth(bytes32 _batchId, uint8 _newDepth) external whenNotPaused {
        Batch storage batch = batches[_batchId];

        require(batch.owner == msg.sender, "not batch owner");
        require(minimumBucketDepth < _newDepth && batch.depth < _newDepth, "depth not increasing");
        require(!batch.immutableFlag, "batch is immutable");
        require(batch.normalisedBalance > currentTotalOutPayment(), "batch already expired");

        uint8 depthChange = _newDepth - batch.depth;
        // divide by the change in batch size (2^depthChange)
        uint256 newRemainingBalance = remainingBalance(_batchId) / (1 << depthChange);

        // expire batches up to current block before amending validChunkCount to include
        // the new chunks resultant of the depth increase
        expireLimited(type(uint256).max);
        validChunkCount += (1 << _newDepth) - (1 << batch.depth);

        // update by removing batch and then reinserting
        tree.remove(_batchId, batch.normalisedBalance);
        batch.depth = _newDepth;
        batch.normalisedBalance = currentTotalOutPayment() + (newRemainingBalance);
        tree.insert(_batchId, batch.normalisedBalance);

        emit BatchDepthIncrease(_batchId, _newDepth, batch.normalisedBalance);
    }

    /**
     * @notice Return the per chunk balance not yet used up.
     * @param _batchId The id of an existing batch.
     */
    function remainingBalance(bytes32 _batchId) public view returns (uint256) {
        Batch storage batch = batches[_batchId];
        require(batch.owner != address(0), "batch does not exist or expired");
        if (batch.normalisedBalance <= currentTotalOutPayment()) {
            return 0;
        }
        return batch.normalisedBalance - currentTotalOutPayment();
    }

    /**
     * @notice Set a new price.
     * @dev Can only be called by the price oracle role.
     * @param _price The new price.
     */
    function setPrice(uint256 _price) external {
        require(hasRole(PRICE_ORACLE_ROLE, msg.sender), "only price oracle can set the price");

        // if there was a last price, add the outpayment since the last update
        // using the last price to _totalOutPayment_. if there was not a lastPrice,
        // the lastprice must have been zero.
        if (lastPrice != 0) {
            totalOutPayment = currentTotalOutPayment();
        }

        lastPrice = _price;
        lastUpdatedBlock = block.number;

        emit PriceUpdate(_price);
    }

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

    /**
     * @notice Pause the contract.
     * @dev Can only be called by the pauser when not paused.
     * The contract can be provably stopped by renouncing the pauser role and the admin role once paused.
     */
    function pause() public {
        require(hasRole(PAUSER_ROLE, msg.sender), "only pauser can pause");
        _pause();
    }

    /**
     * @notice Unpause the contract.
     * @dev Can only be called by the pauser role while paused.
     */
    function unPause() public {
        require(hasRole(PAUSER_ROLE, msg.sender), "only pauser can unpause");
        _unpause();
    }

    /**
     * @notice Return true if no batches exist
     */
    function empty() public view returns (bool) {
        return tree.count() == 0;
    }

    /**
     * @notice Get the first batch id ordered by ascending normalised balance.
     * @dev If more than one batch id, return index at 0, if no batches, revert.
     */
    function firstBatchId() public view returns (bytes32) {
        uint256 val = tree.first();
        require(val > 0, "no batches exist");
        return tree.valueKeyAtIndex(val, 0);
    }

    /**
     * @notice Reclaims a limited number of expired batches
     * @dev Can be used if reclaiming all expired batches would exceed the block gas limit, causing other
     * contract method calls to fail.
     * @param limit The maximum number of batches to expire.
     */
    function expireLimited(uint256 limit) public {
        // the lower bound of the normalised balance for which we will check if batches have expired
        uint256 leb = lastExpiryBalance;
        uint256 i;
        for (i = 0; i < limit; i++) {
            if (empty()) {
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
            Batch storage batch = batches[fbi];
            uint256 batchSize = 1 << batch.depth;
            require(validChunkCount >= batchSize, "insufficient valid chunk count");
            validChunkCount -= batchSize;
            // since the batch expired _during_ the period we must add
            // remaining normalised payout for this batch only
            pot += batchSize * (batch.normalisedBalance - leb);
            tree.remove(fbi, batch.normalisedBalance);
            delete batches[fbi];
        }
        // then, for all batches that have _not_ expired during the period
        // add the total normalised payout of all batches
        // multiplied by the remaining total valid chunk count
        // to the pot for the period since the last expiry

        require(lastExpiryBalance >= leb, "current total outpayment should never decrease");

        // then, for all batches that have _not_ expired during the period
        // add the total normalised payout of all batches
        // multiplied by the remaining total valid chunk count
        // to the pot for the period since the last expiry
        pot += validChunkCount * (lastExpiryBalance - leb);
    }

    /**
     * @notice Indicates whether expired batches exist.
     */
    function expiredBatchesExist() public view returns (bool) {
        if (empty()) {
            return false;
        }
        return (remainingBalance(firstBatchId()) <= 0);
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
        require(hasRole(REDISTRIBUTOR_ROLE, msg.sender), "only redistributor can withdraw from the contract");
        require(ERC20(bzzToken).transfer(beneficiary, totalPot()), "failed transfer");
        pot = 0;
    }

    /**
     * @notice Topup the pot.
     * @param amount Amount of tokens the pot will be topped up by.
     */
    function topupPot(uint256 amount) external {
        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), amount), "failed transfer");
        pot += amount;
    }
}
