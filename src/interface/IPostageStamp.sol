// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

interface IPostageStamp {
    function withdraw(address beneficiary) external;

    function validChunkCount() external view returns (uint256);

    // Dont use commented out until we deploy new postagestamp contract that has this methods
    // function batchOwner(bytes32 _batchId) external view returns (address);

    // function batchDepth(bytes32 _batchId) external view returns (uint8);

    // function batchBucketDepth(bytes32 _batchId) external view returns (uint8);

    function remainingBalance(bytes32 _batchId) external view returns (uint256);

    function minimumInitialBalancePerChunk() external view returns (uint256);

    function setPrice(uint256 _price) external;

    function batches(
        bytes32
    )
        external
        view
        returns (
            address owner,
            uint8 depth,
            uint8 bucketDepth,
            bool immutableFlag,
            uint256 normalisedBalance,
            uint256 lastUpdatedBlockNumber
        );
}
