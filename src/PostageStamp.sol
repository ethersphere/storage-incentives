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

    // ----------------------------- SWIP-049 ------------------------------

    // Length of a redistribution round in blocks. Mirrors Redistribution.ROUND_LENGTH.
    uint64 public constant REDISTRIBUTION_ROUND_BLOCKS = 152;

    // Offset of the first reveal block within a round. Sampling for round `r` starts at the
    // first reveal block of round `r - 1`, i.e. (r - 1) * 152 + 38.
    uint64 public constant REDISTRIBUTION_REVEAL_OFFSET = 38;

    // Balance, in blocks at the price in force at sampling start, that a batch must hold to be
    // usable by a redistribution round. Covers the 266 block sampling-to-claim window with
    // headroom for the preceding round's price increase.
    uint64 public constant ROUND_USABILITY_BLOCKS = 456;

    // Six complete redistribution rounds. Floor for the configurable operation minimum, so a
    // later top-up or dilution can never cross the usability boundary of an open round.
    uint64 public constant MIN_OPERATION_VALIDITY_BLOCKS = 6 * REDISTRIBUTION_ROUND_BLOCKS;

    // The price that was in force immediately before `lastPrice`.
    uint64 public previousPrice;

    // The block in which `previousPrice` became active. Needed to prove that the price period
    // being rolled back through actually covered the requested sampling start block; without it
    // the reconstruction silently returns a wrong answer whenever more than one price update has
    // happened since. See docs/SWIP-49-50-SCRUTINY.md 1.1.
    uint64 public previousPriceUpdatedBlock;

    // Superseded batch depths that were visible at a sampling boundary. Two slots are needed
    // because neighbouring sampling-to-claim windows overlap: a later round can fix its batch
    // scope while the preceding round is still claimable.
    mapping(bytes32 => DepthHistory) private depthHistory;

    // Every batch id ever created or imported, so an expired id can never be reincarnated and
    // make old signatures usable under a new batch.
    mapping(bytes32 => bool) public batchIdUsed;

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

    struct DepthHistory {
        // Most recent superseded depth that was visible at a sampling boundary.
        uint64 previousDepthBlock;
        // One older boundary-visible depth, needed while two round scopes overlap.
        uint64 olderDepthBlock;
        // A live batch always has depth > bucketDepth >= minimumBucketDepth >= 1, so zero is a
        // safe "slot empty" sentinel for both depths.
        uint8 previousDepth;
        uint8 olderDepth;
    }

    struct ImportBatch {
        bytes32 batchId;
        address owner;
        uint8 depth;
        uint8 bucketDepth;
        bool immutableFlag;
        uint256 remainingBalance;
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

    /**
     *@dev Emitted on every batch failed in bulk batch creation
     */
    event CopyBatchFailed(uint index, bytes32 batchId);

    // ----------------------------- Errors ------------------------------

    error ZeroAddress(); // Owner cannot be the zero address
    error InvalidDepth(); // Invalid bucket depth
    error BatchExists(); // Deprecated by SWIP-049: batch id collisions now revert BatchIdAlreadyUsed
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
    error BatchIdAlreadyUsed(bytes32 batchId); // Batch id was already consumed, even if since expired
    error BatchNotUsableForRedistribution(bytes32 batchId); // Batch absent, expired, or had no depth at sampling start
    error FutureSamplingStartBlock(); // Sampling start block is in the future
    error MinimumValidityTooShort(); // Operation minimum below six redistribution rounds
    error PriceHistoryUnavailable(); // Price at the requested sampling start cannot be reconstructed

    // ----------------------------- CONSTRUCTOR ------------------------------

    /**
     * @param _bzzToken The ERC20 token address to reference in this contract.
     * @param _minimumBucketDepth The minimum bucket depth of batches that can be purchased.
     */
    constructor(address _bzzToken, uint8 _minimumBucketDepth) {
        bzzToken = _bzzToken;
        minimumBucketDepth = _minimumBucketDepth;
        PRICE_ORACLE_ROLE = keccak256("PRICE_ORACLE_ROLE");
        PAUSER_ROLE = keccak256("PAUSER_ROLE");
        REDISTRIBUTOR_ROLE = keccak256("REDISTRIBUTOR_ROLE");
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
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
    ) external whenNotPaused returns (bytes32) {
        if (_owner == address(0)) {
            revert ZeroAddress();
        }

        if (_bucketDepth == 0 || _bucketDepth < minimumBucketDepth || _bucketDepth >= _depth) {
            revert InvalidDepth();
        }

        bytes32 batchId = keccak256(abi.encode(msg.sender, _nonce));
        _consumeBatchId(batchId);

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

        return batchId;
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
    ) public whenNotPaused {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AdministratorOnly();
        }

        if (_owner == address(0)) {
            revert ZeroAddress();
        }

        if (_bucketDepth == 0 || _bucketDepth >= _depth) {
            revert InvalidDepth();
        }

        _consumeBatchId(_batchId);

        // Imports are held to the same creation minimum as ordinary batches, so an imported
        // batch can never enter a round already below the operation minimum.
        if (_initialBalancePerChunk < minimumInitialBalancePerChunk()) {
            revert InsufficientBalance();
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
     * @notice Import batches in bulk
     * @dev Import batches in bulk to lower the number of transactions needed,
     * @dev becase of block limitations 90 batches per trx is ceiling, 60 to 70 sweetspot
     * @param bulkBatches array of batches
     */
    function copyBatchBulk(ImportBatch[] calldata bulkBatches) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AdministratorOnly();
        }
        for (uint i = 0; i < bulkBatches.length; i++) {
            ImportBatch memory _batch = bulkBatches[i];
            try
                this.copyBatch(
                    _batch.owner,
                    _batch.remainingBalance,
                    _batch.depth,
                    _batch.bucketDepth,
                    _batch.batchId,
                    _batch.immutableFlag
                )
            {
                // Successful copyBatch call
            } catch {
                // copyBatch failed, handle error
                emit CopyBatchFailed(i, _batch.batchId);
            }
        }
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

        // Checked before the top-up, not after: a batch that has already fallen below the
        // operation minimum must not be rescuable into a redistribution round that is already
        // open. Note this makes the drop permanent - see docs/SWIP-49-50-SCRUTINY.md 1.2.
        if (remainingBalance(_batchId) < minimumInitialBalancePerChunk()) {
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
        Batch storage batch = batches[_batchId];

        if (batch.owner != msg.sender) {
            revert NotBatchOwner();
        }

        uint8 oldDepth = batch.depth;
        if (!(minimumBucketDepth < _newDepth && oldDepth < _newDepth)) {
            revert DepthNotIncreasing();
        }

        uint256 outPayment = currentTotalOutPayment();
        uint256 oldNormalisedBalance = batch.normalisedBalance;
        if (oldNormalisedBalance <= outPayment) {
            revert BatchExpired();
        }

        uint256 newRemainingBalance = (oldNormalisedBalance - outPayment) / (uint256(1) << (_newDepth - oldDepth));

        // The post-dilution balance must still clear the operation minimum, so a dilution can
        // never push a batch out of a redistribution round that is already open.
        if (newRemainingBalance < minimumInitialBalancePerChunk()) {
            revert InsufficientBalance();
        }

        expireLimited(type(uint256).max);

        // `lastUpdatedBlockNumber` is the block in which `oldDepth` became current; top-ups do
        // not touch it, so it is the correct introduction block for the depth being superseded.
        _recordDepthBeforeIncrease(_batchId, oldDepth, batch.lastUpdatedBlockNumber);

        validChunkCount += (uint256(1) << _newDepth) - (uint256(1) << oldDepth);
        tree.remove(_batchId, oldNormalisedBalance);

        uint256 newNormalisedBalance = outPayment + newRemainingBalance;
        batch.depth = _newDepth;
        batch.lastUpdatedBlockNumber = block.number;
        batch.normalisedBalance = newNormalisedBalance;

        tree.insert(_batchId, newNormalisedBalance);

        emit BatchDepthIncrease(_batchId, _newDepth, newNormalisedBalance);
    }

    // ----------------------------- SWIP-049 internals ------------------------------

    /**
     * @notice Consume a batch id permanently.
     * @dev An id is never released, not even by expiry. Reincarnating an expired id would make
     * signatures issued against the old batch valid against the new one.
     */
    function _consumeBatchId(bytes32 batchId) internal {
        if (batchIdUsed[batchId] || batches[batchId].owner != address(0)) {
            revert BatchIdAlreadyUsed(batchId);
        }
        batchIdUsed[batchId] = true;
    }

    /**
     * @notice The first sampling-start block strictly after `blockNumber`.
     * @dev Sampling for round `r` starts at `(r - 1) * 152 + 38`. A depth introduced in a
     * sampling-start block is too late for that round, which reads the state at the end of the
     * preceding block, so the boundary that could have observed `blockNumber` is the next one.
     */
    function _firstSamplingStartAfter(uint256 blockNumber) internal pure returns (uint256) {
        if (blockNumber < REDISTRIBUTION_REVEAL_OFFSET) {
            return REDISTRIBUTION_REVEAL_OFFSET;
        }

        uint256 completedIntervals = (blockNumber - REDISTRIBUTION_REVEAL_OFFSET) / REDISTRIBUTION_ROUND_BLOCKS;

        return REDISTRIBUTION_REVEAL_OFFSET + (completedIntervals + 1) * REDISTRIBUTION_ROUND_BLOCKS;
    }

    /**
     * @notice Retain a superseded depth, but only if a sampling boundary ever observed it.
     * @dev Dilutions that happen before the next sampling start replace an intermediate value no
     * round ever fixed, so they must not consume a history slot. This is what allows repeated
     * dilution without losing a depth an open claim still needs.
     *
     * Worked example from SWIP-049 (depth 20 from block 120, sampling starts 190, 342, 494):
     *   dilute at 220 (20 -> 21): 190 has passed, record previous = depth 20 from block 120
     *   dilute at 260 (21 -> 22): next boundary 342 not reached, no round fixed 21, record nothing
     *   dilute at 360 (22 -> 23): 342 has passed, rotate to older = depth 20 from block 120, previous = depth 22 from block 260
     * Both old depths are then live at once: the round sampled at 190 is still claimable while
     * the round sampled at 342 must use 22.
     */
    function _recordDepthBeforeIncrease(bytes32 batchId, uint8 oldDepth, uint256 oldDepthBlock) internal {
        uint256 firstSamplingStartThatCouldUseOldDepth = _firstSamplingStartAfter(oldDepthBlock);

        // Strictly less than: an increase in the sampling-start block itself is too late for that
        // round, so the old depth is the one that round must use and has to be retained.
        if (block.number < firstSamplingStartThatCouldUseOldDepth) {
            return;
        }

        DepthHistory storage history = depthHistory[batchId];

        history.olderDepth = history.previousDepth;
        history.olderDepthBlock = history.previousDepthBlock;
        history.previousDepth = oldDepth;
        history.previousDepthBlock = uint64(oldDepthBlock);
    }

    /**
     * @notice Reconstruct the price and cumulative outpayment in force at `samplingStartBlock`.
     * @dev The rollback branch is only sound when the previous price period actually covered
     * `samplingStartBlock`. SWIP-049 argues that from claim ordering; this checks it instead,
     * because PriceOracle also exposes an unrestricted admin setPrice.
     */
    function _priceStateAtSamplingStart(
        uint256 samplingStartBlock
    ) internal view returns (uint64 priceAtStart, uint256 outPaymentAtStart) {
        if (samplingStartBlock > block.number) {
            revert FutureSamplingStartBlock();
        }

        uint256 priceUpdateBlock = uint256(lastUpdatedBlock);
        if (priceUpdateBlock < samplingStartBlock) {
            return (lastPrice, totalOutPayment + (samplingStartBlock - priceUpdateBlock) * uint256(lastPrice));
        }

        if (previousPrice == 0) {
            revert PriceHistoryUnavailable();
        }

        if (uint256(previousPriceUpdatedBlock) > samplingStartBlock) {
            revert PriceHistoryUnavailable();
        }

        uint256 rollback = (priceUpdateBlock - samplingStartBlock) * uint256(previousPrice);
        if (rollback > totalOutPayment) {
            revert PriceHistoryUnavailable();
        }

        return (previousPrice, totalOutPayment - rollback);
    }

    /**
     * @notice The newest recorded depth introduced strictly before `samplingStartBlock`.
     */
    function _depthAtSamplingStart(
        bytes32 batchId,
        Batch storage batch,
        uint256 samplingStartBlock
    ) internal view returns (uint8) {
        if (batch.lastUpdatedBlockNumber < samplingStartBlock) {
            return batch.depth;
        }

        DepthHistory storage history = depthHistory[batchId];
        if (history.previousDepth != 0 && uint256(history.previousDepthBlock) < samplingStartBlock) {
            return history.previousDepth;
        }
        if (history.olderDepth != 0 && uint256(history.olderDepthBlock) < samplingStartBlock) {
            return history.olderDepth;
        }

        revert BatchNotUsableForRedistribution(batchId);
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

        uint64 newPrice = uint64(_price);

        if (lastPrice == 0) {
            // Bootstrap: there is no earlier price period to roll back through.
            previousPrice = newPrice;
        } else {
            totalOutPayment = currentTotalOutPayment();
            previousPrice = lastPrice;
        }
        previousPriceUpdatedBlock = lastUpdatedBlock;

        lastPrice = newPrice;
        lastUpdatedBlock = uint64(block.number);

        emit PriceUpdate(_price);
    }

    function setMinimumValidityBlocks(uint64 _value) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AdministratorOnly();
        }

        if (_value < MIN_OPERATION_VALIDITY_BLOCKS) {
            revert MinimumValidityTooShort();
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
            delete depthHistory[fbi];
            delete batches[fbi];
            // batchIdUsed[fbi] deliberately stays true: the id is permanently consumed.

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

    // ----------------------------- SWIP-049 reads ------------------------------

    /**
     * @notice The normalised balance a batch must hold to be usable by the round that started
     * sampling at `samplingStartBlock`.
     * @dev Bee and Redistribution must use this same value. It is fixed at sampling start and a
     * later price update does not move it.
     */
    function redistributionMinimumNormalisedBalance(uint256 samplingStartBlock) external view returns (uint256) {
        (uint64 priceAtStart, uint256 outPaymentAtStart) = _priceStateAtSamplingStart(samplingStartBlock);
        return outPaymentAtStart + uint256(ROUND_USABILITY_BLOCKS) * uint256(priceAtStart);
    }

    /**
     * @notice The batch as a redistribution round that started sampling at `samplingStartBlock`
     * may use it.
     * @dev Reverts unless the batch is present, still live, and had a depth before sampling
     * began. The returned depth is the historical one, so a later dilution cannot widen the
     * index range an open claim is verified against.
     */
    function redistributionBatchAt(
        bytes32 batchId,
        uint256 samplingStartBlock
    ) external view returns (address owner, uint8 depthAtSamplingStart, uint8 bucketDepth, uint256 normalisedBalance) {
        if (samplingStartBlock > block.number) {
            revert FutureSamplingStartBlock();
        }

        Batch storage batch = batches[batchId];
        if (batch.owner == address(0) || batch.normalisedBalance <= currentTotalOutPayment()) {
            revert BatchNotUsableForRedistribution(batchId);
        }

        return (
            batch.owner,
            _depthAtSamplingStart(batchId, batch, samplingStartBlock),
            batch.bucketDepth,
            batch.normalisedBalance
        );
    }

    /**
     * @notice Retained depth history of a batch. Exposed so Bee can check its own reconstruction
     * against the contract rather than inferring it from events alone.
     */
    function batchDepthHistory(
        bytes32 batchId
    ) external view returns (uint8 previousDepth, uint64 previousDepthBlock, uint8 olderDepth, uint64 olderDepthBlock) {
        DepthHistory storage history = depthHistory[batchId];
        return (history.previousDepth, history.previousDepthBlock, history.olderDepth, history.olderDepthBlock);
    }
}
