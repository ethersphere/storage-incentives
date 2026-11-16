// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title PostageStampSnark
 * @author The Swarm Authors
 * @notice PostageStamp for the SNARK settlement. Batch purchase, top-up and depth increase work as in
 * src/PostageStamp.sol, with the same events and views. The difference: no batch tree and no expiry
 * loop. See docs/SNARK-SETTLEMENT.md, section 6.
 *
 * - A batch is expired when `normalisedBalance <= currentTotalOutPayment()`. Every reader (this contract,
 *   Bee, the claim checks) evaluates that directly. Nothing is removed.
 * - The pot is computed here, without a list of the batches in expiry order. The balance scale is split
 *   into buckets of `BUCKET` units. For each bucket the contract keeps the chunks of the batches that
 *   expire in it. A batch pays the pot for each unit of outpayment up to the start of its bucket, and
 *   the rest of its balance when the outpayment passes the end of its bucket. So each batch pays exactly
 *   its balance, and the last part (less than one bucket) arrives late, never early. A purchase or a
 *   top-up changes one or two buckets. Nobody pays for the expiry of the batches of other users.
 * - Settlement pays a round's winner the pot as it was at the round's seed block (`potAt`).
 * - `expiredBatchesExist()` and `expireLimited()` remain as no-ops, so current Bee versions (which call
 *   them before buying a batch) keep working.
 *
 * Buyers pay only for their own batch: no tree insert, no sweep of other batches.
 */
contract PostageStampSnark is AccessControl, Pausable {
    // ----------------------------- State variables ------------------------------

    address public bzzToken;
    uint8 public minimumBucketDepth;

    bytes32 public immutable PRICE_ORACLE_ROLE;
    bytes32 public immutable PAUSER_ROLE;
    bytes32 public immutable REDISTRIBUTOR_ROLE;

    mapping(bytes32 => Batch) public batches;

    // Total out payment per chunk at `lastUpdatedBlock`, as in PostageStamp.
    uint256 private totalOutPayment;
    uint64 public lastPrice;
    uint64 public minimumValidityBlocks = 17280;
    uint64 public lastUpdatedBlock;

    // The pot of a game round is fixed at the round's seed block, so it does not depend on when the round
    // settles. The first accounting after a seed block stores the pot at that block as the round's cut.
    // Rounds without any transaction between their seed blocks share one cut (fromRound..toRound).
    // The cuts are kept for the last CUT_RING rounds that stored one.
    uint256 public constant GAME_ROUND_LENGTH = 64; // Settlement.ROUND_LENGTH
    uint256 public constant GAME_SEED_OFFSET = 48; // Settlement.SEED_OFFSET
    uint256 public constant CUT_RING = 256;

    struct Cut {
        uint64 fromRound;
        uint64 toRound;
        uint256 pot;
    }

    uint64 public lastCutRound;
    Cut[256] private cuts;

    // Width of a bucket of the balance scale, in units of outpayment for each chunk. It must not be more
    // than the minimum balance of a batch (minimumValidityBlocks * price), so that a new balance is never
    // in the current bucket.
    uint256 public constant BUCKET = 1 << 21;

    struct Bucket {
        // Chunks of the batches whose balance is in this bucket.
        uint96 size;
        // What these batches pay when the bucket ends: the sum of chunks * (balance - start of the bucket).
        uint160 credit;
    }

    mapping(uint256 => Bucket) public buckets;
    // Bit b of word w is set when bucket w * 256 + b is in use.
    mapping(uint256 => uint256) internal bucketBitmap;
    // Chunks of the batches in the buckets after the current one: they pay for each unit of outpayment.
    uint256 public liveSize;
    // The outpayment up to which the pot is computed. Its bucket is the current bucket.
    uint256 public accountedOutPayment;
    // Everything the batches paid to the pot up to `accountedOutPayment`. It only increases.
    uint256 public cumulativePot;

    // ----------------------------- Type declarations ------------------------------

    struct Batch {
        address owner;
        uint8 depth;
        uint8 bucketDepth;
        bool immutableFlag;
        uint256 normalisedBalance;
        uint256 lastUpdatedBlockNumber;
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

    // Same events as PostageStamp; Bee follows these.
    event BatchCreated(
        bytes32 indexed batchId,
        uint256 totalAmount,
        uint256 normalisedBalance,
        address owner,
        uint8 depth,
        uint8 bucketDepth,
        bool immutableFlag
    );
    event PotWithdrawn(address recipient, uint256 totalAmount);
    event BatchTopUp(bytes32 indexed batchId, uint256 topupAmount, uint256 normalisedBalance);
    event BatchDepthIncrease(bytes32 indexed batchId, uint8 newDepth, uint256 normalisedBalance);
    event PriceUpdate(uint256 price);
    event CopyBatchFailed(uint index, bytes32 batchId);

    // ----------------------------- Errors ------------------------------

    error ZeroAddress();
    error BalanceTooLow();
    error InvalidDepth();
    error BatchExists();
    error InsufficientBalance();
    error TransferFailed();
    error ZeroBalance();
    error AdministratorOnly();
    error BatchDoesNotExist();
    error BatchExpired();
    error BatchTooSmall();
    error NotBatchOwner();
    error DepthNotIncreasing();
    error PriceOracleOnly();
    error OnlyPauser();
    error OnlyRedistributor();
    error CutNotFound();

    // ----------------------------- CONSTRUCTOR ------------------------------

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
     * @notice Create a new batch. Same rules and event as PostageStamp.createBatch.
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

        _storeBatch(batchId, _owner, _depth, _bucketDepth, _immutable, _initialBalancePerChunk, totalAmount);
        return batchId;
    }

    /**
     * @notice Admin migration of a batch, as PostageStamp.copyBatch. Tokens are deposited separately.
     */
    function copyBatch(
        address _owner,
        uint256 _initialBalancePerChunk,
        uint8 _depth,
        uint8 _bucketDepth,
        bytes32 _batchId,
        bool _immutable
    ) public whenNotPaused {
        // copyBatchBulk calls this through `this` (so that one bad batch does not revert the others), and
        // checks the admin role itself. Without the address(this) case every bulk copy failed, as in
        // master's PostageStamp (found in the migration rehearsal, 2026-11-08).
        if (msg.sender != address(this) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
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
        _storeBatch(_batchId, _owner, _depth, _bucketDepth, _immutable, _initialBalancePerChunk, totalAmount);
    }

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
            {} catch {
                emit CopyBatchFailed(i, _batch.batchId);
            }
        }
    }

    /**
     * @notice Top up a batch. Same rules and event as PostageStamp.topUp.
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

        uint256 totalAmount = _topupAmountPerChunk * (1 << batch.depth);
        if (!ERC20(bzzToken).transferFrom(msg.sender, address(this), totalAmount)) {
            revert TransferFailed();
        }

        _account();
        _remove(uint256(1) << batch.depth, batch.normalisedBalance);
        batch.normalisedBalance = batch.normalisedBalance + (_topupAmountPerChunk);
        batches[_batchId].normalisedBalance = batch.normalisedBalance;

        _add(uint256(1) << batch.depth, batch.normalisedBalance);
        emit BatchTopUp(_batchId, totalAmount, batch.normalisedBalance);
    }

    /**
     * @notice Increase the depth of a batch. Same rules and event as PostageStamp.increaseDepth.
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

        if (_newDepth >= 64) revert InvalidDepth();
        _account();
        _remove(uint256(1) << batch.depth, batch.normalisedBalance);
        batch.normalisedBalance = currentTotalOutPayment() + newRemainingBalance;
        batches[_batchId].depth = _newDepth;
        batches[_batchId].lastUpdatedBlockNumber = block.number;
        batches[_batchId].normalisedBalance = batch.normalisedBalance;

        _add(uint256(1) << _newDepth, batch.normalisedBalance);
        emit BatchDepthIncrease(_batchId, _newDepth, batch.normalisedBalance);
    }

    /**
     * @notice Set the price. Same as PostageStamp.setPrice, plus a log entry.
     */
    function setPrice(uint256 _price) external {
        if (!hasRole(PRICE_ORACLE_ROLE, msg.sender)) {
            revert PriceOracleOnly();
        }

        // The pot up to now, with the price before the change.
        _account();
        if (lastPrice != 0) {
            totalOutPayment = currentTotalOutPayment();
        }
        lastPrice = uint64(_price);
        lastUpdatedBlock = uint64(block.number);

        emit PriceUpdate(_price);
    }

    /**
     * @notice Withdraw a proven amount of the pot. Only Settlement (REDISTRIBUTOR_ROLE) calls this, with the
     * amount its proof computed.
     */
    function withdraw(address beneficiary, uint256 amount) external {
        if (!hasRole(REDISTRIBUTOR_ROLE, msg.sender)) {
            revert OnlyRedistributor();
        }
        if (!ERC20(bzzToken).transfer(beneficiary, amount)) {
            revert TransferFailed();
        }
        emit PotWithdrawn(beneficiary, amount);
    }

    function setMinimumValidityBlocks(uint64 _value) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AdministratorOnly();
        }
        minimumValidityBlocks = _value;
    }

    function pause() public {
        if (!hasRole(PAUSER_ROLE, msg.sender)) {
            revert OnlyPauser();
        }
        _pause();
    }

    function unPause() public {
        if (!hasRole(PAUSER_ROLE, msg.sender)) {
            revert OnlyPauser();
        }
        _unpause();
    }

    // ----------------------------- Bee compatibility ------------------------------

    /// @notice Always false: nothing needs on-chain expiry. Bee calls this before it buys a batch.
    function expiredBatchesExist() external pure returns (bool) {
        return false;
    }

    /// @notice No-op: expiry is computed in the settlement proof.
    function expireLimited(uint256) external pure {}

    ////////////////////////////////////////
    //            STATE READING           //
    ////////////////////////////////////////

    function currentTotalOutPayment() public view returns (uint256) {
        uint256 blocks = block.number - lastUpdatedBlock;
        uint256 increaseSinceLastUpdate = lastPrice * (blocks);
        return totalOutPayment + (increaseSinceLastUpdate);
    }

    function minimumInitialBalancePerChunk() public view returns (uint256) {
        return minimumValidityBlocks * lastPrice;
    }

    function remainingBalance(bytes32 _batchId) public view returns (uint256) {
        Batch memory batch = batches[_batchId];
        if (batch.owner == address(0)) {
            revert BatchDoesNotExist();
        }
        if (batch.normalisedBalance <= currentTotalOutPayment()) {
            return 0;
        }
        return batch.normalisedBalance - currentTotalOutPayment();
    }

    /// @notice True when the batch exists and has balance left. Replaces "owner != 0" of PostageStamp.
    function isBatchAlive(bytes32 _batchId) external view returns (bool) {
        Batch memory batch = batches[_batchId];
        return batch.owner != address(0) && batch.normalisedBalance > currentTotalOutPayment();
    }

    /**
     * @notice The pot at the seed block of game round `round`: everything the batches paid up to that
     * block. Settlement pays the difference to what it paid before. Call it only after the seed block.
     * Reverts when the round's cut is no longer kept.
     */
    function potAt(uint64 round) external returns (uint256) {
        _account();
        if (round > lastCutRound) revert CutNotFound();
        for (uint64 r = round; r <= lastCutRound && r < round + CUT_RING; r++) {
            Cut storage c = cuts[r % CUT_RING];
            if (c.toRound == r) {
                if (c.fromRound > round) break; // the cut that covered `round` was overwritten
                return c.pot;
            }
        }
        revert CutNotFound();
    }

    /// @notice Bring the pot accounting up to this block. Anybody can call it, for example once in a
    /// round, so that each round gets its own cut.
    function checkpoint() external {
        _account();
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

    ////////////////////////////////////////
    //              INTERNAL              //
    ////////////////////////////////////////

    function _storeBatch(
        bytes32 _batchId,
        address _owner,
        uint8 _depth,
        uint8 _bucketDepth,
        bool _immutable,
        uint256 _initialBalancePerChunk,
        uint256 _totalAmount
    ) internal {
        if (_depth >= 64) revert InvalidDepth();
        _account();
        uint256 normalisedBalance = currentTotalOutPayment() + (_initialBalancePerChunk);
        if (normalisedBalance == 0) {
            revert ZeroBalance();
        }

        batches[_batchId] = Batch({
            owner: _owner,
            depth: _depth,
            bucketDepth: _bucketDepth,
            immutableFlag: _immutable,
            normalisedBalance: normalisedBalance,
            lastUpdatedBlockNumber: block.number
        });

        _add(uint256(1) << _depth, normalisedBalance);
        emit BatchCreated(_batchId, _totalAmount, normalisedBalance, _owner, _depth, _bucketDepth, _immutable);
    }

    // ----------------------------- Pot accounting ------------------------------

    /// @dev Bring the accounting up to this block. If a seed block passed since the last accounting,
    /// store the pot at that block as the cut of its round first.
    function _account() internal {
        if (block.number > GAME_SEED_OFFSET) {
            uint64 round = uint64((block.number - GAME_SEED_OFFSET - 1) / GAME_ROUND_LENGTH);
            uint64 last = lastCutRound;
            if (round > last) {
                uint256 seedBlock = uint256(round) * GAME_ROUND_LENGTH + GAME_SEED_OFFSET;
                // The price did not change since the last accounting (setPrice accounts first), so the
                // outpayment at the seed block follows from the current price.
                if (seedBlock >= lastUpdatedBlock) {
                    _accrueTo(totalOutPayment + uint256(lastPrice) * (seedBlock - lastUpdatedBlock));
                }
                cuts[round % CUT_RING] = Cut({fromRound: last + 1, toRound: round, pot: cumulativePot});
                lastCutRound = round;
            }
        }
        _accrueTo(currentTotalOutPayment());
    }

    /// @dev Add to the pot what the batches pay while the outpayment goes from `accountedOutPayment` to `o`.
    function _accrueTo(uint256 o) internal {
        uint256 acc = accountedOutPayment;
        if (o <= acc) return;
        uint256 cur = acc / BUCKET;
        uint256 target = o / BUCKET;
        uint256 live = liveSize;
        uint256 pot = cumulativePot;
        while (cur < target) {
            // The current bucket ends: the later batches pay up to its end, and its own batches pay the
            // rest of their balance.
            uint256 end = (cur + 1) * BUCKET;
            pot += live * (end - acc);
            Bucket memory b = buckets[cur];
            if (b.size != 0) {
                pot += b.credit;
                delete buckets[cur];
                bucketBitmap[cur >> 8] &= ~(uint256(1) << (cur & 255));
            }
            // Go to the next bucket in use (or to the target). Its batches stop paying at its start.
            cur = _nextBucket(cur + 1, target);
            acc = cur * BUCKET;
            pot += live * (acc - end);
            live -= buckets[cur].size;
        }
        pot += live * (o - acc);
        accountedOutPayment = o;
        liveSize = live;
        cumulativePot = pot;
    }

    /// @dev The first bucket in use in [from, to], or `to`.
    function _nextBucket(uint256 from, uint256 to) internal view returns (uint256) {
        while (from < to) {
            uint256 word = bucketBitmap[from >> 8] >> (from & 255);
            if (word != 0) {
                // index of the lowest set bit
                uint256 i;
                if (word & type(uint128).max == 0) (i, word) = (i + 128, word >> 128);
                if (word & type(uint64).max == 0) (i, word) = (i + 64, word >> 64);
                if (word & type(uint32).max == 0) (i, word) = (i + 32, word >> 32);
                if (word & type(uint16).max == 0) (i, word) = (i + 16, word >> 16);
                if (word & type(uint8).max == 0) (i, word) = (i + 8, word >> 8);
                if (word & 15 == 0) (i, word) = (i + 4, word >> 4);
                if (word & 3 == 0) (i, word) = (i + 2, word >> 2);
                if (word & 1 == 0) i += 1;
                return from + i < to ? from + i : to;
            }
            from = ((from >> 8) + 1) << 8;
        }
        return to;
    }

    /// @dev A batch with `size` chunks gets the balance `balance`. Call `_account` first.
    function _add(uint256 size, uint256 balance) internal {
        uint256 b = balance / BUCKET;
        // A balance in the current bucket would not pay for the part of the bucket that is over.
        if (b <= accountedOutPayment / BUCKET) revert BalanceTooLow();
        Bucket storage bucket = buckets[b];
        bucket.size += uint96(size);
        bucket.credit += uint160(size * (balance - b * BUCKET));
        bucketBitmap[b >> 8] |= uint256(1) << (b & 255);
        liveSize += size;
    }

    /// @dev A live batch with `size` chunks leaves the balance `balance` (top-up, depth increase). Call
    /// `_account` first.
    function _remove(uint256 size, uint256 balance) internal {
        uint256 b = balance / BUCKET;
        uint256 start = b * BUCKET;
        Bucket storage bucket = buckets[b];
        bucket.size -= uint96(size);
        bucket.credit -= uint160(size * (balance - start));
        if (bucket.size == 0) bucketBitmap[b >> 8] &= ~(uint256(1) << (b & 255));
        if (b > accountedOutPayment / BUCKET) {
            liveSize -= size;
        } else {
            // The batch is in the current bucket: it stopped paying at the start of the bucket. It pays
            // now for the part of the bucket that is over.
            cumulativePot += size * (accountedOutPayment - start);
        }
    }
}
