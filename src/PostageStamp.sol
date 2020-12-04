// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.7.4;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title PostageStamp contract
 * @author The Swarm Authors
 * @dev The postage stamp contracts allows users to create and manage postage stamp batches.
 */
contract PostageStamp is AccessControl {
    using SafeMath for uint256;
    /**
     * @dev Emitted when a new batch is created.
     */
    event BatchCreated(bytes32 indexed batchId, uint256 totalAmount, uint256 normalisedBalance, address owner, uint8 depth);

    /**
     * @dev Emitted when an existing batch is topped up.
     */
    event BatchTopUp(bytes32 indexed batchId, uint256 topupAmount, uint256 normalisedBalance);

    /**
     * @dev Emitted when the depth of an existing batch increases.
     */
    event BatchDepthIncrease(bytes32 indexed batchId, uint8 newDepth, uint256 normalisedBalance);

    struct Batch {
        // Owner of this batch (0 if not valid).
        address owner;
        // Current depth of this batch.
        uint8 depth;
        // Normalised balance per chunk.
        uint256 normalisedBalance;
    }

    // The role allowed to increase totalOutPayment
    bytes32 public constant PRICE_ORACLE_ROLE = keccak256("PRICE_ORACLE");

    // Associate every batch id with batch data.
    mapping(bytes32 => Batch) public batches;

    // The address of the BZZ ERC20 token this contract references.
    address public bzzToken;
    // The total out payment per chunk
    uint256 public totalOutPayment;    

    /**
     * @param _bzzToken The ERC20 token address to reference in this contract.
     */
    constructor(address _bzzToken) {
        bzzToken = _bzzToken;
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /**
     * @notice Create a new batch.
     * @dev At least `_initialBalancePerChunk*2^depth` number of tokens need to be preapproved for this contract.
     * @param _owner The owner of the new batch.
     * @param _initialBalancePerChunk The initial balance per chunk of the batch.
     * @param _depth The initial depth of the new batch.
     * @param _nonce A random value used in the batch id derivation to allow multiple batches per owner.
     */
    function createBatch(
        address _owner,
        uint256 _initialBalancePerChunk,
        uint8 _depth,
        bytes32 _nonce
    ) external {
        require(_owner != address(0), "owner cannot be the zero address");

        // Derive batchId from msg.sender to ensure another party cannot use the same batch id and frontrun us.
        bytes32 batchId = keccak256(abi.encode(msg.sender, _nonce));
        require(batches[batchId].owner == address(0), "batch already exists");

        uint256 totalAmount = _initialBalancePerChunk.mul(1 << _depth);
        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), totalAmount), "failed transfer");

        uint256 normalisedBalance = totalOutPayment.add(_initialBalancePerChunk);

        batches[batchId] = Batch({
            owner: _owner,
            depth: _depth,
            normalisedBalance: normalisedBalance
        });

        emit BatchCreated(batchId, totalAmount, normalisedBalance, _owner, _depth);
    }

    /**
     * @notice Top up an existing batch.
     * @dev At least `topupAmount*2^depth` number of tokens need to be preapproved for this contract.
     * @param _batchId The id of the existing batch.
     * @param _topupAmountPerChunk The amount of additional tokens to add per chunk.
     */
    function topUp(bytes32 _batchId, uint256 _topupAmountPerChunk) external {
        Batch storage batch = batches[_batchId];
        require(batch.owner != address(0), "batch does not exist");
        require(batch.normalisedBalance >= totalOutPayment, "batch already expired");

        uint256 totalAmount = _topupAmountPerChunk.mul(1 << batch.depth);
        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), totalAmount), "failed transfer");

        batch.normalisedBalance = batch.normalisedBalance.add(_topupAmountPerChunk);
        
        emit BatchTopUp(_batchId, totalAmount, batch.normalisedBalance);
    }

    /**
     * @notice Increase the depth of an existing batch.
     * @dev Can only be called by the owner of the batch.
     * @param _batchId the id of the existing batch
     * @param _newDepth the new (larger than the previous one) depth for this batch
     */
    function increaseDepth(bytes32 _batchId, uint8 _newDepth) external {
        Batch storage batch = batches[_batchId];
        require(batch.owner == msg.sender, "not batch owner");
        require(_newDepth > batch.depth, "depth not increasing");
        require(batch.normalisedBalance >= totalOutPayment, "batch already expired");

        uint8 depthChange = _newDepth - batch.depth;
        uint256 newRemainingBalance = remainingBalance(_batchId).div(1 << depthChange);

        batch.depth = _newDepth;
        batch.normalisedBalance = totalOutPayment.add(newRemainingBalance);

        emit BatchDepthIncrease(_batchId, _newDepth, batch.normalisedBalance);
    }

    /**
    * @notice Returns the per chunk balance not used up yet
    * @param _batchId the id of the existing batch
    */
    function remainingBalance(bytes32 _batchId) view public returns (uint256) {
        Batch storage batch = batches[_batchId];
        require(batch.owner != address(0), "batch does not exist");
        return batch.normalisedBalance.sub(totalOutPayment);
    }

    /**
    * @notice Increase totalOutPayment
    * @dev can only be called by the price oracle
    * @param _totalOutPaymentIncrease the size of the increase
    */
    function increaseTotalOutPayment(uint256 _totalOutPaymentIncrease) external {
        require(hasRole(PRICE_ORACLE_ROLE, msg.sender), "only price oracle can increase totalOutpayment");
        totalOutPayment = totalOutPayment.add(_totalOutPaymentIncrease);
    }
}
