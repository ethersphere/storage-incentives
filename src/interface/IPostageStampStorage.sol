// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

/**
 * @title IPostageStampStorage
 * @author The Swarm Authors
 * @notice Interface for the immutable PostageStamp storage contract
 * @dev This interface defines the storage layer for postage stamp batches,
 * allowing the logic contract to be upgraded without migrating data or funds.
 */
interface IPostageStampStorage {
    // ----------------------------- Type declarations ------------------------------

    struct Batch {
        address owner;
        uint8 depth;
        uint8 bucketDepth;
        bool immutableFlag;
        uint256 normalisedBalance;
        uint256 lastUpdatedBlockNumber;
    }

    // ----------------------------- Events ------------------------------

    event BatchStored(bytes32 indexed batchId);
    event BatchDeleted(bytes32 indexed batchId);

    // ----------------------------- Storage Operations ------------------------------

    /**
     * @notice Store or update a batch
     * @param _batchId The batch identifier
     * @param _batch The batch data
     */
    function storeBatch(bytes32 _batchId, Batch calldata _batch) external;

    /**
     * @notice Delete a batch
     * @param _batchId The batch identifier
     */
    function deleteBatch(bytes32 _batchId) external;

    /**
     * @notice Get a batch
     * @param _batchId The batch identifier
     * @return The batch data
     */
    function getBatch(bytes32 _batchId) external view returns (Batch memory);

    /**
     * @notice Check if a batch exists
     * @param _batchId The batch identifier
     * @return True if the batch exists
     */
    function batchExists(bytes32 _batchId) external view returns (bool);

    // ----------------------------- Tree Operations ------------------------------

    /**
     * @notice Insert a batch into the ordered tree
     * @param _batchId The batch identifier
     * @param _normalisedBalance The normalised balance for ordering
     */
    function treeInsert(bytes32 _batchId, uint256 _normalisedBalance) external;

    /**
     * @notice Remove a batch from the ordered tree
     * @param _batchId The batch identifier
     * @param _normalisedBalance The normalised balance (for verification)
     */
    function treeRemove(bytes32 _batchId, uint256 _normalisedBalance) external;

    /**
     * @notice Get the first value in the tree
     * @return The first normalised balance value
     */
    function treeFirst() external view returns (uint256);

    /**
     * @notice Get the count of items in the tree
     * @return The number of batches in the tree
     */
    function treeCount() external view returns (uint256);

    /**
     * @notice Get a key at a specific index for a value
     * @param _value The normalised balance value
     * @param _index The index
     * @return The batch ID at that index
     */
    function treeValueKeyAtIndex(uint256 _value, uint256 _index) external view returns (bytes32);

    // ----------------------------- Global State ------------------------------

    /**
     * @notice Set the total out payment
     * @param _totalOutPayment The new total out payment value
     */
    function setTotalOutPayment(uint256 _totalOutPayment) external;

    /**
     * @notice Get the total out payment
     * @return The current total out payment
     */
    function getTotalOutPayment() external view returns (uint256);

    /**
     * @notice Set the valid chunk count
     * @param _validChunkCount The new valid chunk count
     */
    function setValidChunkCount(uint256 _validChunkCount) external;

    /**
     * @notice Get the valid chunk count
     * @return The current valid chunk count
     */
    function getValidChunkCount() external view returns (uint256);

    /**
     * @notice Set the pot amount
     * @param _pot The new pot amount
     */
    function setPot(uint256 _pot) external;

    /**
     * @notice Get the pot amount
     * @return The current pot amount
     */
    function getPot() external view returns (uint256);

    /**
     * @notice Set the last expiry balance
     * @param _lastExpiryBalance The new last expiry balance
     */
    function setLastExpiryBalance(uint256 _lastExpiryBalance) external;

    /**
     * @notice Get the last expiry balance
     * @return The current last expiry balance
     */
    function getLastExpiryBalance() external view returns (uint256);

    /**
     * @notice Set the last price
     * @param _lastPrice The new last price
     */
    function setLastPrice(uint64 _lastPrice) external;

    /**
     * @notice Get the last price
     * @return The current last price
     */
    function getLastPrice() external view returns (uint64);

    /**
     * @notice Set the last updated block
     * @param _lastUpdatedBlock The new last updated block
     */
    function setLastUpdatedBlock(uint64 _lastUpdatedBlock) external;

    /**
     * @notice Get the last updated block
     * @return The current last updated block
     */
    function getLastUpdatedBlock() external view returns (uint64);

    // ----------------------------- Token Operations ------------------------------

    /**
     * @notice Get the BZZ token address
     * @return The BZZ token contract address
     */
    function bzzToken() external view returns (address);

    /**
     * @notice Transfer tokens from the storage contract
     * @param _token The token address
     * @param _to The recipient address
     * @param _amount The amount to transfer
     * @return True if successful
     */
    function transferToken(address _token, address _to, uint256 _amount) external returns (bool);

    /**
     * @notice Transfer tokens to the storage contract
     * @param _token The token address
     * @param _from The sender address
     * @param _amount The amount to transfer
     * @return True if successful
     */
    function transferTokenFrom(address _token, address _from, uint256 _amount) external returns (bool);

    /**
     * @notice Get token balance of the storage contract
     * @param _token The token address
     * @return The balance
     */
    function tokenBalance(address _token) external view returns (uint256);
}
