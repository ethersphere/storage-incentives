// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./OrderStatisticsTree/HitchensOrderStatisticsTreeLib.sol";

/**
 * @title PostageStamp contract
 * @author The Swarm Authors
 * @dev The postage stamp contracts allows users to create and manage postage stamp batches.
 */
contract PostageStamp is AccessControl, Pausable {
    using HitchensOrderStatisticsTreeLib for HitchensOrderStatisticsTreeLib.Tree;

    HitchensOrderStatisticsTreeLib.Tree tree;

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

    // Associate every batch id with batch data.
    mapping(bytes32 => Batch) public batches;

    // The address of the BZZ ERC20 token this contract references.
    address public bzzToken;
    // The total out payment per chunk
    uint256 public totalOutPayment;

    // the price from the last update
    uint256 public lastPrice;
    // the block at which the last update occured
    uint256 public lastUpdatedBlock;

    /**
     * @param _bzzToken The ERC20 token address to reference in this contract.
     */
    constructor(address _bzzToken) {
        bzzToken = _bzzToken;
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
        require(_bucketDepth != 0 && _bucketDepth < _depth, "invalid bucket depth");
        // Derive batchId from msg.sender to ensure another party cannot use the same batch id and frontrun us.
        bytes32 batchId = keccak256(abi.encode(msg.sender, _nonce));
        require(batches[batchId].owner == address(0), "batch already exists");

        // per chunk balance times the batch size is what we need to transfer in
        uint256 totalAmount = _initialBalancePerChunk * (1 << _depth);
        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), totalAmount), "failed transfer");

        uint256 normalisedBalance = currentTotalOutPayment() + (_initialBalancePerChunk);

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
     * @notice Top up an existing batch.
     * @dev At least `topupAmount*2^depth` number of tokens need to be preapproved for this contract.
     * @param _batchId The id of the existing batch.
     * @param _topupAmountPerChunk The amount of additional tokens to add per chunk.
     */
    function topUp(bytes32 _batchId, uint256 _topupAmountPerChunk) external whenNotPaused {
        Batch storage batch = batches[_batchId];
        require(batch.owner != address(0), "batch does not exist");
        require(batch.normalisedBalance > currentTotalOutPayment(), "batch already expired");

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
        require(_newDepth > batch.depth, "depth not increasing");
        require(batch.normalisedBalance > currentTotalOutPayment(), "batch already expired");

        uint8 depthChange = _newDepth - batch.depth;
        // divide by the change in batch size (2^depthChange)
        uint256 newRemainingBalance = remainingBalance(_batchId) / (1 << depthChange);

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
        if (batch.normalisedBalance <= currentTotalOutPayment()){
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
     * @notice Returns the current total outpayment
     */
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
    function empty() public view returns(bool) {
        return tree.count() == 0;
    }

    /**
     * @notice Gets the first batch id
     * @dev if more than one batch id, returns index at 0, if no batches, reverts
     */
    function firstBatchId() public view returns (bytes32) {
        uint val = tree.first();
        require(val > 0);
        return tree.valueKeyAtIndex(val, 0);
    }

    
}
