// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./interface/IPostageStampStorage.sol";

/**
 * @title PostageStamp
 * @author The Swarm Authors
 * @notice Upgradeable logic contract for postage stamp operations
 * @dev This contract contains the business logic for postage stamp operations while
 * delegating all storage operations to the immutable PostageStampStorage contract.
 * This allows the logic to be upgraded without migrating funds or batch data.
 *
 * Key benefits:
 * - No need to migrate BZZ tokens when upgrading
 * - No need to migrate batch data when upgrading
 * - Swarm nodes only need to update the logic contract address
 * - Storage contract remains immutable and trusted
 *
 * Note: Contract versioning is tracked via git tags, not in the contract name.
 */
contract PostageStamp is AccessControl, Pausable {
    // ----------------------------- State variables ------------------------------

    /// @notice Reference to the immutable storage contract
    IPostageStampStorage public immutable storageContract;

    /// @notice Minimum allowed depth of bucket
    uint8 public minimumBucketDepth;

    /// @notice Minimum validity blocks (default ~24 hours)
    uint64 public minimumValidityBlocks;

    // ----------------------------- Roles ------------------------------

    /// @notice Role allowed to increase totalOutPayment
    bytes32 public immutable PRICE_ORACLE_ROLE;

    /// @notice Role allowed to pause
    bytes32 public immutable PAUSER_ROLE;

    /// @notice Role allowed to withdraw the pot
    bytes32 public immutable REDISTRIBUTOR_ROLE;

    // ----------------------------- Events ------------------------------

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
    error InsufficientChunkCount();
    error TotalOutpaymentDecreased();
    error NoBatchesExist();
    error OnlyPauser();
    error OnlyRedistributor();

    // ----------------------------- Structs ------------------------------

    struct ImportBatch {
        bytes32 batchId;
        address owner;
        uint8 depth;
        uint8 bucketDepth;
        bool immutableFlag;
        uint256 remainingBalance;
    }

    // ----------------------------- Constructor ------------------------------

    /**
     * @notice Initialize the logic contract
     * @param _storageContract Address of the PostageStampStorage contract
     * @param _minimumBucketDepth The minimum bucket depth of batches
     * @param _minimumValidityBlocks Minimum validity in blocks (~24h = 17280)
     */
    constructor(address _storageContract, uint8 _minimumBucketDepth, uint64 _minimumValidityBlocks) {
        if (_storageContract == address(0)) {
            revert ZeroAddress();
        }

        storageContract = IPostageStampStorage(_storageContract);
        minimumBucketDepth = _minimumBucketDepth;
        minimumValidityBlocks = _minimumValidityBlocks;

        PRICE_ORACLE_ROLE = keccak256("PRICE_ORACLE_ROLE");
        PAUSER_ROLE = keccak256("PAUSER_ROLE");
        REDISTRIBUTOR_ROLE = keccak256("REDISTRIBUTOR_ROLE");

        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(PAUSER_ROLE, msg.sender);
    }

    // ----------------------------- State Changing Functions ------------------------------

    /**
     * @notice Create a new batch
     * @param _owner Owner of the new batch
     * @param _initialBalancePerChunk Initial balance per chunk
     * @param _depth Initial depth of the new batch
     * @param _bucketDepth Bucket depth for the batch
     * @param _nonce A random value for batch ID derivation
     * @param _immutable Whether the batch is immutable
     * @return The batch ID
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
        if (storageContract.batchExists(batchId)) {
            revert BatchExists();
        }

        if (_initialBalancePerChunk < minimumInitialBalancePerChunk()) {
            revert InsufficientBalance();
        }

        uint256 totalAmount = _initialBalancePerChunk * (1 << _depth);
        if (!storageContract.transferTokenFrom(storageContract.bzzToken(), msg.sender, totalAmount)) {
            revert TransferFailed();
        }

        uint256 normalisedBalance = currentTotalOutPayment() + _initialBalancePerChunk;
        if (normalisedBalance == 0) {
            revert ZeroBalance();
        }

        expireLimited(type(uint256).max);

        uint256 newValidChunkCount = storageContract.getValidChunkCount() + (1 << _depth);
        storageContract.setValidChunkCount(newValidChunkCount);

        IPostageStampStorage.Batch memory batch = IPostageStampStorage.Batch({
            owner: _owner,
            depth: _depth,
            bucketDepth: _bucketDepth,
            immutableFlag: _immutable,
            normalisedBalance: normalisedBalance,
            lastUpdatedBlockNumber: block.number
        });

        storageContract.storeBatch(batchId, batch);
        storageContract.treeInsert(batchId, normalisedBalance);

        emit BatchCreated(batchId, totalAmount, normalisedBalance, _owner, _depth, _bucketDepth, _immutable);

        return batchId;
    }

    /**
     * @notice Top up an existing batch
     * @param _batchId The id of an existing batch
     * @param _topupAmountPerChunk The amount of additional tokens to add per chunk
     */
    function topUp(bytes32 _batchId, uint256 _topupAmountPerChunk) external whenNotPaused {
        IPostageStampStorage.Batch memory batch = storageContract.getBatch(_batchId);

        if (batch.owner == address(0)) {
            revert BatchDoesNotExist();
        }

        if (batch.normalisedBalance <= currentTotalOutPayment()) {
            revert BatchExpired();
        }

        if (batch.depth <= minimumBucketDepth) {
            revert BatchTooSmall();
        }

        if (remainingBalance(_batchId) + _topupAmountPerChunk < minimumInitialBalancePerChunk()) {
            revert InsufficientBalance();
        }

        uint256 totalAmount = _topupAmountPerChunk * (1 << batch.depth);
        if (!storageContract.transferTokenFrom(storageContract.bzzToken(), msg.sender, totalAmount)) {
            revert TransferFailed();
        }

        storageContract.treeRemove(_batchId, batch.normalisedBalance);
        batch.normalisedBalance = batch.normalisedBalance + _topupAmountPerChunk;
        storageContract.treeInsert(_batchId, batch.normalisedBalance);

        storageContract.storeBatch(_batchId, batch);
        emit BatchTopUp(_batchId, totalAmount, batch.normalisedBalance);
    }

    /**
     * @notice Increase the depth of an existing batch
     * @param _batchId The id of an existing batch
     * @param _newDepth The new (larger) depth for this batch
     */
    function increaseDepth(bytes32 _batchId, uint8 _newDepth) external whenNotPaused {
        IPostageStampStorage.Batch memory batch = storageContract.getBatch(_batchId);

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

        uint256 newValidChunkCount = storageContract.getValidChunkCount() + (1 << _newDepth) - (1 << batch.depth);
        storageContract.setValidChunkCount(newValidChunkCount);

        storageContract.treeRemove(_batchId, batch.normalisedBalance);

        batch.depth = _newDepth;
        batch.lastUpdatedBlockNumber = block.number;
        batch.normalisedBalance = currentTotalOutPayment() + newRemainingBalance;

        storageContract.storeBatch(_batchId, batch);
        storageContract.treeInsert(_batchId, batch.normalisedBalance);

        emit BatchDepthIncrease(_batchId, _newDepth, batch.normalisedBalance);
    }

    /**
     * @notice Set a new price
     * @param _price The new price
     */
    function setPrice(uint256 _price) external {
        if (!hasRole(PRICE_ORACLE_ROLE, msg.sender)) {
            revert PriceOracleOnly();
        }

        uint64 lastPrice = storageContract.getLastPrice();
        if (lastPrice != 0) {
            storageContract.setTotalOutPayment(currentTotalOutPayment());
        }

        storageContract.setLastPrice(uint64(_price));
        storageContract.setLastUpdatedBlock(uint64(block.number));

        emit PriceUpdate(_price);
    }

    /**
     * @notice Set minimum validity blocks
     * @param _value The new minimum validity blocks
     */
    function setMinimumValidityBlocks(uint64 _value) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AdministratorOnly();
        }

        minimumValidityBlocks = _value;
    }

    /**
     * @notice Reclaim expired batches up to a limit
     * @param limit The maximum number of batches to expire
     */
    function expireLimited(uint256 limit) public {
        uint256 _lastExpiryBalance = storageContract.getLastExpiryBalance();
        uint256 i;

        for (i; i < limit; ) {
            if (isBatchesTreeEmpty()) {
                storageContract.setLastExpiryBalance(currentTotalOutPayment());
                break;
            }

            bytes32 fbi = firstBatchId();

            if (remainingBalance(fbi) > 0) {
                storageContract.setLastExpiryBalance(currentTotalOutPayment());
                break;
            }

            IPostageStampStorage.Batch memory batch = storageContract.getBatch(fbi);
            uint256 batchSize = 1 << batch.depth;

            uint256 validChunkCount = storageContract.getValidChunkCount();
            if (validChunkCount < batchSize) {
                revert InsufficientChunkCount();
            }
            storageContract.setValidChunkCount(validChunkCount - batchSize);

            uint256 pot = storageContract.getPot();
            pot += batchSize * (batch.normalisedBalance - _lastExpiryBalance);
            storageContract.setPot(pot);

            storageContract.treeRemove(fbi, batch.normalisedBalance);
            storageContract.deleteBatch(fbi);

            unchecked {
                ++i;
            }
        }

        uint256 lastExpiryBalance = storageContract.getLastExpiryBalance();
        if (lastExpiryBalance < _lastExpiryBalance) {
            revert TotalOutpaymentDecreased();
        }

        uint256 pot = storageContract.getPot();
        pot += storageContract.getValidChunkCount() * (lastExpiryBalance - _lastExpiryBalance);
        storageContract.setPot(pot);
    }

    /**
     * @notice Get the current total pot
     * @return The total pot amount
     */
    function totalPot() public returns (uint256) {
        expireLimited(type(uint256).max);
        uint256 balance = storageContract.tokenBalance(storageContract.bzzToken());
        uint256 pot = storageContract.getPot();
        return pot < balance ? pot : balance;
    }

    /**
     * @notice Withdraw the pot
     * @param beneficiary Receives the current total pot
     */
    function withdraw(address beneficiary) external {
        if (!hasRole(REDISTRIBUTOR_ROLE, msg.sender)) {
            revert OnlyRedistributor();
        }

        uint256 totalAmount = totalPot();
        if (!storageContract.transferToken(storageContract.bzzToken(), beneficiary, totalAmount)) {
            revert TransferFailed();
        }

        emit PotWithdrawn(beneficiary, totalAmount);
        storageContract.setPot(0);
    }

    /**
     * @notice Pause the contract
     */
    function pause() public {
        if (!hasRole(PAUSER_ROLE, msg.sender)) {
            revert OnlyPauser();
        }
        _pause();
    }

    /**
     * @notice Unpause the contract
     */
    function unPause() public {
        if (!hasRole(PAUSER_ROLE, msg.sender)) {
            revert OnlyPauser();
        }
        _unpause();
    }

    // ----------------------------- View Functions ------------------------------

    /**
     * @notice Get current total out payment
     * @return The current total out payment per chunk
     */
    function currentTotalOutPayment() public view returns (uint256) {
        uint64 lastUpdatedBlock = storageContract.getLastUpdatedBlock();
        uint64 lastPrice = storageContract.getLastPrice();
        uint256 blocks = block.number - lastUpdatedBlock;
        uint256 increaseSinceLastUpdate = lastPrice * blocks;
        return storageContract.getTotalOutPayment() + increaseSinceLastUpdate;
    }

    /**
     * @notice Get minimum initial balance per chunk
     * @return The minimum balance required per chunk
     */
    function minimumInitialBalancePerChunk() public view returns (uint256) {
        return minimumValidityBlocks * storageContract.getLastPrice();
    }

    /**
     * @notice Get remaining balance for a batch
     * @param _batchId The batch ID
     * @return The remaining balance per chunk
     */
    function remainingBalance(bytes32 _batchId) public view returns (uint256) {
        IPostageStampStorage.Batch memory batch = storageContract.getBatch(_batchId);

        if (batch.owner == address(0)) {
            revert BatchDoesNotExist();
        }

        if (batch.normalisedBalance <= currentTotalOutPayment()) {
            return 0;
        }

        return batch.normalisedBalance - currentTotalOutPayment();
    }

    /**
     * @notice Check if expired batches exist
     * @return True if expired batches exist
     */
    function expiredBatchesExist() public view returns (bool) {
        if (isBatchesTreeEmpty()) {
            return false;
        }
        return (remainingBalance(firstBatchId()) <= 0);
    }

    /**
     * @notice Check if batches tree is empty
     * @return True if no batches exist
     */
    function isBatchesTreeEmpty() public view returns (bool) {
        return storageContract.treeCount() == 0;
    }

    /**
     * @notice Get the first batch ID ordered by normalised balance
     * @return The first batch ID
     */
    function firstBatchId() public view returns (bytes32) {
        uint256 val = storageContract.treeFirst();
        if (val == 0) {
            revert NoBatchesExist();
        }
        return storageContract.treeValueKeyAtIndex(val, 0);
    }

    /**
     * @notice Get batch owner
     */
    function batchOwner(bytes32 _batchId) public view returns (address) {
        return storageContract.getBatch(_batchId).owner;
    }

    /**
     * @notice Get batch depth
     */
    function batchDepth(bytes32 _batchId) public view returns (uint8) {
        return storageContract.getBatch(_batchId).depth;
    }

    /**
     * @notice Get batch bucket depth
     */
    function batchBucketDepth(bytes32 _batchId) public view returns (uint8) {
        return storageContract.getBatch(_batchId).bucketDepth;
    }

    /**
     * @notice Get batch immutable flag
     */
    function batchImmutableFlag(bytes32 _batchId) public view returns (bool) {
        return storageContract.getBatch(_batchId).immutableFlag;
    }

    /**
     * @notice Get batch normalised balance
     */
    function batchNormalisedBalance(bytes32 _batchId) public view returns (uint256) {
        return storageContract.getBatch(_batchId).normalisedBalance;
    }

    /**
     * @notice Get batch last updated block number
     */
    function batchLastUpdatedBlockNumber(bytes32 _batchId) public view returns (uint256) {
        return storageContract.getBatch(_batchId).lastUpdatedBlockNumber;
    }

    /**
     * @notice Get public batch data
     */
    function batches(
        bytes32 _batchId
    )
        public
        view
        returns (
            address owner,
            uint8 depth,
            uint8 bucketDepth,
            bool immutableFlag,
            uint256 normalisedBalance,
            uint256 lastUpdatedBlockNumber
        )
    {
        IPostageStampStorage.Batch memory batch = storageContract.getBatch(_batchId);
        return (
            batch.owner,
            batch.depth,
            batch.bucketDepth,
            batch.immutableFlag,
            batch.normalisedBalance,
            batch.lastUpdatedBlockNumber
        );
    }

    // ----------------------------- Storage Proxy Getters ------------------------------

    function bzzToken() public view returns (address) {
        return storageContract.bzzToken();
    }

    function validChunkCount() public view returns (uint256) {
        return storageContract.getValidChunkCount();
    }

    function pot() public view returns (uint256) {
        return storageContract.getPot();
    }

    function lastExpiryBalance() public view returns (uint256) {
        return storageContract.getLastExpiryBalance();
    }

    function lastPrice() public view returns (uint64) {
        return storageContract.getLastPrice();
    }

    function lastUpdatedBlock() public view returns (uint64) {
        return storageContract.getLastUpdatedBlock();
    }
}
