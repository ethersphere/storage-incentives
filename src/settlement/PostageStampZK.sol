// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title PostageStampZK
 * @author The Swarm Authors
 * @notice PostageStamp for ZK settlement. Batch purchase, top-up and depth increase work as in
 * src/PostageStamp.sol, with the same events and views. The difference: no batch tree and no on-chain
 * expiry. See docs/ZK-SETTLEMENT.md, "Postage accounting in the proof".
 *
 * - A batch is expired when `normalisedBalance <= currentTotalOutPayment()`. Every reader (this contract,
 *   Bee, the proof) evaluates that directly. Nothing is removed.
 * - The pot is not computed here. Every change that affects it (batch created, copied, topped up,
 *   deepened, price changed) is appended to an event log: a hash chain plus a `PostageLog` event. The
 *   settlement proof replays the log, expires batches in order and computes the pot, exactly as
 *   `expireLimited` did. Settlement then withdraws the proven amount with `withdraw(beneficiary, amount)`.
 * - `expiredBatchesExist()` and `expireLimited()` remain as no-ops, so current Bee versions (which call
 *   them before buying a batch) keep working.
 *
 * Buyers pay only for their own batch: no tree insert, no sweep of other batches.
 */
contract PostageStampZK is AccessControl, Pausable {
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

    // Event log for the settlement proof. Entry i (1-based) is hashed into eventHash(i); the last
    // EVENT_RING entries keep their hash and block so Settlement can check a prefix of the log. A settlement
    // needs the entries from its cut block (the seed block of its round) to its own transaction to still be
    // in the ring. With 256 entries, about 17M gas of cheap top-ups in a minute pushed them out and made
    // settleRound revert; 8192 entries need about 550M. Each log entry still writes one hash slot (and a
    // quarter of a block slot): the slots are reused, so the larger ring costs gas only on first use.
    uint256 public constant EVENT_RING = 8192;
    uint64 public eventCount;
    bytes32[8192] private eventHashRing;
    uint64[8192] private eventBlockRing;

    uint8 public constant KIND_CREATE = 1;
    uint8 public constant KIND_TOPUP = 2;
    uint8 public constant KIND_DEPTH = 3;
    uint8 public constant KIND_PRICE = 4;

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

    /**
     * @dev One entry of the event log, with exactly the fields that are hashed:
     * hash_i = keccak256(abi.encodePacked(hash_{i-1}, kind, batchId, owner, depth, bucketDepth, value,
     * outpayment, blockNumber)). `value` is the batch's new normalisedBalance, or the new price for
     * KIND_PRICE. `outpayment` is currentTotalOutPayment() after the change.
     */
    event PostageLog(
        uint64 indexed index,
        uint8 kind,
        bytes32 batchId,
        address owner,
        uint8 depth,
        uint8 bucketDepth,
        uint256 value,
        uint256 outpayment,
        uint64 blockNumber
    );

    // ----------------------------- Errors ------------------------------

    error ZeroAddress();
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
    error EventOutOfRange();

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

        batch.normalisedBalance = batch.normalisedBalance + (_topupAmountPerChunk);
        batches[_batchId].normalisedBalance = batch.normalisedBalance;

        _log(KIND_TOPUP, _batchId, batch.owner, batch.depth, batch.bucketDepth, batch.normalisedBalance);
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

        batch.normalisedBalance = currentTotalOutPayment() + newRemainingBalance;
        batches[_batchId].depth = _newDepth;
        batches[_batchId].lastUpdatedBlockNumber = block.number;
        batches[_batchId].normalisedBalance = batch.normalisedBalance;

        _log(KIND_DEPTH, _batchId, batch.owner, _newDepth, batch.bucketDepth, batch.normalisedBalance);
        emit BatchDepthIncrease(_batchId, _newDepth, batch.normalisedBalance);
    }

    /**
     * @notice Set the price. Same as PostageStamp.setPrice, plus a log entry.
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

        _log(KIND_PRICE, bytes32(0), address(0), 0, 0, _price);
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

    /// @notice Hash of the event log after `index` entries. 0 for index 0. Only the last EVENT_RING are kept.
    function eventHashAt(uint64 index) external view returns (bytes32) {
        if (index == 0) return bytes32(0);
        if (index > eventCount || eventCount - index >= EVENT_RING) revert EventOutOfRange();
        return eventHashRing[index % EVENT_RING];
    }

    /// @notice Block of log entry `index` (1-based). Only the last EVENT_RING are kept.
    function eventBlockAt(uint64 index) external view returns (uint64) {
        if (index == 0 || index > eventCount || eventCount - index >= EVENT_RING) revert EventOutOfRange();
        return eventBlockRing[index % EVENT_RING];
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

        _log(KIND_CREATE, _batchId, _owner, _depth, _bucketDepth, normalisedBalance);
        emit BatchCreated(_batchId, _totalAmount, normalisedBalance, _owner, _depth, _bucketDepth, _immutable);
    }

    function _log(uint8 kind, bytes32 batchId, address owner, uint8 depth, uint8 bucketDepth, uint256 value) internal {
        uint64 index = eventCount + 1;
        uint256 outpayment = currentTotalOutPayment();
        bytes32 prev = index == 1 ? bytes32(0) : eventHashRing[(index - 1) % EVENT_RING];
        eventHashRing[index % EVENT_RING] = keccak256(
            abi.encodePacked(prev, kind, batchId, owner, depth, bucketDepth, value, outpayment, uint64(block.number))
        );
        eventBlockRing[index % EVENT_RING] = uint64(block.number);
        eventCount = index;
        emit PostageLog(index, kind, batchId, owner, depth, bucketDepth, value, outpayment, uint64(block.number));
    }
}
