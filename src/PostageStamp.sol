// SPDX-License-Identifier: MIT
pragma solidity ^0.7.4;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
@title PostageStamp contract
@author The Swarm Authors
@dev The postage stamp contracts allows users to create and manage postage stamp batches 
*/
contract PostageStamp {
  /**
  @dev Emitted when a new batch is created. 
  */
  event BatchCreated(bytes32 indexed batchId, uint256 initialBalance, address owner, uint8 depth);
  /**
  @dev Emitted when an existing batch is topped up. 
  */
  event BatchTopUp(bytes32 indexed batchId, uint256 topupAmount);
  /**
  @dev Emitted when the depth of an existing batch increases. 
  */
  event BatchDepthIncrease(bytes32 indexed batchId, uint8 newDepth);

  struct Batch {
    // owner of this batch (0 if not valid)
    address owner;
    // current depth of this batch
    uint8 depth;
  }
  
  // associate every batch id with batch data
  mapping (bytes32 => Batch) public batches;
  // the ERC20 token this contract uses
  address public bzzToken;

  /**
  @param _bzzToken the ERC20 token to use for this contract
  */
  constructor(address _bzzToken) {
    bzzToken = _bzzToken;
  }

  /**
  @notice create a new batch
  @dev initialBalance tokens need to be preapproved for this contract
  @param owner the owner of the new batch
  @param initialBalance the initial balance of the batch to be transferred into the contract
  @param depth the initial depth of the new batch
  @param nonce a random value used in the batch id derivation to allow multiple batches per owner
  */
  function createBatch(address owner, uint256 initialBalance, uint8 depth, bytes32 nonce) external {
    require(owner != address(0), "owner cannot be the zero address");
    // derive batchId from msg.sender to ensure another party cannot use the same batch id and frontrun us
    bytes32 batchId = keccak256(abi.encode(msg.sender, nonce));
    require(batches[batchId].owner == address(0), "batch already exists");
    // TODO: check if we should call burn
    require(ERC20(bzzToken).transferFrom(msg.sender, address(this), initialBalance), "failed transfer");

    batches[batchId] = Batch({
      owner: owner,
      depth: depth
    });

    emit BatchCreated(batchId, initialBalance, owner, depth);
  }

  /**
  @notice top up an existing batch
  @dev topupAmount tokens need to be preapproved for this contract
  @param batchId the id of the existing batch
  @param topupAmount the amount of additional tokens to add
  */
  function topUp(bytes32 batchId, uint256 topupAmount) external {
    require(batches[batchId].owner != address(0), "batch does not exist");
    require(ERC20(bzzToken).transferFrom(msg.sender, address(this), topupAmount), "failed transfer");
    // the topup amount is only tracked in events
    emit BatchTopUp(batchId, topupAmount);
  }

  /**
  @notice increase the depth of an existing batch
  @dev can only be called by the owner of the batch
  @param batchId the id of the existing batch
  @param newDepth the new (larger than the previous one) depth for this batch
  */
  function increaseDepth(bytes32 batchId, uint8 newDepth) external {
    Batch storage batch = batches[batchId];
    require(batch.owner == msg.sender, "not batch owner");
    require(newDepth > batch.depth, "depth not increasing");
    batch.depth = newDepth;
    emit BatchDepthIncrease(batchId, newDepth);
  }

}