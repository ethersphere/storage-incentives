// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.7.4;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title PostageStamp contract
 * @author The Swarm Authors
 * @dev The postage stamp contracts allows users to create and manage postage stamp batches.
 */
contract PostageStamp {
    /**
     * @dev Emitted when a new batch is created.
     */
    event BatchCreated(bytes32 indexed batchId, uint256 initialBalance, address owner, uint8 depth);

    /**
     * @dev Emitted when an existing batch is topped up.
     */
    event BatchTopUp(bytes32 indexed batchId, uint256 topupAmount);

    /**
     * @dev Emitted when the depth of an existing batch increases.
     */
    event BatchDepthIncrease(bytes32 indexed batchId, uint8 newDepth);

    struct Batch {
        // Owner of this batch (0 if not valid).
        address owner;
        // Current depth of this batch.
        uint8 depth;
    }

    // Associate every batch id with batch data.
    mapping(bytes32 => Batch) public batches;

    // The address of the BZZ ERC20 token this contract references.
    address public bzzToken;

    /**
     * @param _bzzToken The ERC20 token address to reference in this contract.
     */
    constructor(address _bzzToken) {
        bzzToken = _bzzToken;
    }

    /**
     * @notice Create a new batch.
     * @dev At least `initialBalance` number of tokens need to be preapproved for this contract.
     * @param _owner The owner of the new batch.
     * @param _initialBalance The initial balance of the batch to be transferred into the contract.
     * @param _depth The initial depth of the new batch.
     * @param _nonce A random value used in the batch id derivation to allow multiple batches per owner.
     */
    function createBatch(
        address _owner,
        uint256 _initialBalance,
        uint8 _depth,
        bytes32 _nonce
    ) external {
        require(_owner != address(0), "owner cannot be the zero address");

        // Derive batchId from msg.sender to ensure another party cannot use the same batch id and frontrun us.
        bytes32 batchId = keccak256(abi.encode(msg.sender, _nonce));
        require(batches[batchId].owner == address(0), "batch already exists");

        // TODO: check if we should call burn instead of transfer.
        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), _initialBalance), "failed transfer");

        batches[batchId] = Batch({owner: _owner, depth: _depth});

        emit BatchCreated(batchId, _initialBalance, _owner, _depth);
    }

    /**
     * @notice Top up an existing batch.
     * @dev At least `topupAmount` number of tokens need to be preapproved for this contract.
     * @param _batchId The id of the existing batch.
     * @param _topupAmount The amount of additional tokens to add.
     */
    function topUp(bytes32 _batchId, uint256 _topupAmount) external {
        require(batches[_batchId].owner != address(0), "batch does not exist");

        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), _topupAmount), "failed transfer");

        // NOTE: the topup amount is not stored - it is only tracked in events.
        emit BatchTopUp(_batchId, _topupAmount);
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

        batch.depth = _newDepth;
        emit BatchDepthIncrease(_batchId, _newDepth);
    }
}
