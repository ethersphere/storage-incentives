// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./OrderStatisticsTree/HitchensOrderStatisticsTreeLib.sol";
import "./interface/IPostageStampStorage.sol";

/**
 * @title PostageStampStorage
 * @author The Swarm Authors
 * @notice Immutable storage contract for postage stamp batches
 * @dev This contract holds all postage stamp data and BZZ tokens. It is designed to be
 * deployed once and never upgraded. Logic contracts can be upgraded by deploying new
 * versions that are granted the WRITER_ROLE. Each Bee node version knows which logic
 * contract address to use. This eliminates the need to migrate funds and batch data.
 *
 * ROLE MANAGEMENT:
 * - DEFAULT_ADMIN_ROLE: Set to multisig in constructor, can grant/revoke WRITER_ROLE
 * - WRITER_ROLE: Granted to PostageStamp logic contracts that can modify storage
 *
 * ADDING NEW LOGIC CONTRACT (multisig calls):
 *   storage.grantRole(WRITER_ROLE, newPostageStampAddress)
 *
 * REMOVING OLD LOGIC CONTRACT (optional, multisig calls):
 *   storage.revokeRole(WRITER_ROLE, oldPostageStampAddress)
 *
 * UPGRADE PROCESS:
 * 1. Deploy new PostageStamp logic contract (points to this storage)
 * 2. Multisig grants WRITER_ROLE to new logic contract
 * 3. Update Bee nodes to use new logic contract address
 * 4. (Optional) Multisig revokes WRITER_ROLE from old logic contract
 *
 * Note: Multiple logic contracts can have WRITER_ROLE simultaneously,
 * allowing gradual network migration between Bee versions.
 */
contract PostageStampStorage is AccessControl, IPostageStampStorage {
    using HitchensOrderStatisticsTreeLib for HitchensOrderStatisticsTreeLib.Tree;

    // ----------------------------- State variables ------------------------------

    /// @notice Address of the ERC20 BZZ token
    address public immutable bzzToken;

    /// @notice Mapping of batch IDs to batch data
    mapping(bytes32 => Batch) private batches;

    /// @notice Ordered tree of batches by normalised balance
    HitchensOrderStatisticsTreeLib.Tree private tree;

    /// @notice Total out payment per chunk
    uint256 private totalOutPayment;

    /// @notice Combined global chunk capacity of valid batches
    uint256 private validChunkCount;

    /// @notice Lottery pot
    uint256 private pot;

    /// @notice Normalised balance at last expiry
    uint256 private lastExpiryBalance;

    /// @notice Price from the last update
    uint64 private lastPrice;

    /// @notice Block at which the last update occurred
    uint64 private lastUpdatedBlock;

    // ----------------------------- Roles ------------------------------

    /// @notice Role that can modify storage (granted to PostageStamp logic contracts)
    bytes32 public constant WRITER_ROLE = keccak256("WRITER_ROLE");

    /// @notice Role that can perform emergency operations
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    // ----------------------------- Events ------------------------------

    // Inherited from IPostageStampStorage:
    // - event BatchStored(bytes32 indexed batchId);
    // - event BatchDeleted(bytes32 indexed batchId);

    // ----------------------------- Errors ------------------------------

    error ZeroAddress();
    error UnauthorizedWriter();

    // ----------------------------- Constructor ------------------------------

    /**
     * @notice Initialize the storage contract
     * @param _bzzToken Address of the BZZ token contract
     * @param _multisig Address of the multisig wallet that will be the permanent admin
     * @dev The multisig becomes DEFAULT_ADMIN_ROLE and can:
     *      - Grant WRITER_ROLE to new PostageStamp logic contracts
     *      - Revoke WRITER_ROLE from old PostageStamp logic contracts
     *      This is the ONLY admin action ever needed on this contract.
     */
    constructor(address _bzzToken, address _multisig) {
        if (_bzzToken == address(0) || _multisig == address(0)) {
            revert ZeroAddress();
        }

        bzzToken = _bzzToken;

        // Multisig is the permanent admin - can grant/revoke WRITER_ROLE
        _setupRole(DEFAULT_ADMIN_ROLE, _multisig);
        _setRoleAdmin(WRITER_ROLE, DEFAULT_ADMIN_ROLE);
        _setRoleAdmin(EMERGENCY_ROLE, DEFAULT_ADMIN_ROLE);
    }

    ////////////////////////////////////////
    //           STATE SETTING           //
    ////////////////////////////////////////

    /// @inheritdoc IPostageStampStorage
    function storeBatch(bytes32 _batchId, Batch calldata _batch) external {
        if (!hasRole(WRITER_ROLE, msg.sender)) {
            revert UnauthorizedWriter();
        }
        batches[_batchId] = _batch;
        emit BatchStored(_batchId);
    }

    /// @inheritdoc IPostageStampStorage
    function deleteBatch(bytes32 _batchId) external {
        if (!hasRole(WRITER_ROLE, msg.sender)) {
            revert UnauthorizedWriter();
        }
        delete batches[_batchId];
        emit BatchDeleted(_batchId);
    }

    /// @inheritdoc IPostageStampStorage
    function treeInsert(bytes32 _batchId, uint256 _normalisedBalance) external {
        if (!hasRole(WRITER_ROLE, msg.sender)) {
            revert UnauthorizedWriter();
        }
        tree.insert(_batchId, _normalisedBalance);
    }

    /// @inheritdoc IPostageStampStorage
    function treeRemove(bytes32 _batchId, uint256 _normalisedBalance) external {
        if (!hasRole(WRITER_ROLE, msg.sender)) {
            revert UnauthorizedWriter();
        }
        tree.remove(_batchId, _normalisedBalance);
    }

    /// @inheritdoc IPostageStampStorage
    function setTotalOutPayment(uint256 _totalOutPayment) external {
        if (!hasRole(WRITER_ROLE, msg.sender)) {
            revert UnauthorizedWriter();
        }
        totalOutPayment = _totalOutPayment;
    }

    /// @inheritdoc IPostageStampStorage
    function setValidChunkCount(uint256 _validChunkCount) external {
        if (!hasRole(WRITER_ROLE, msg.sender)) {
            revert UnauthorizedWriter();
        }
        validChunkCount = _validChunkCount;
    }

    /// @inheritdoc IPostageStampStorage
    function setPot(uint256 _pot) external {
        if (!hasRole(WRITER_ROLE, msg.sender)) {
            revert UnauthorizedWriter();
        }
        pot = _pot;
    }

    /// @inheritdoc IPostageStampStorage
    function setLastExpiryBalance(uint256 _lastExpiryBalance) external {
        if (!hasRole(WRITER_ROLE, msg.sender)) {
            revert UnauthorizedWriter();
        }
        lastExpiryBalance = _lastExpiryBalance;
    }

    /// @inheritdoc IPostageStampStorage
    function setLastPrice(uint64 _lastPrice) external {
        if (!hasRole(WRITER_ROLE, msg.sender)) {
            revert UnauthorizedWriter();
        }
        lastPrice = _lastPrice;
    }

    /// @inheritdoc IPostageStampStorage
    function setLastUpdatedBlock(uint64 _lastUpdatedBlock) external {
        if (!hasRole(WRITER_ROLE, msg.sender)) {
            revert UnauthorizedWriter();
        }
        lastUpdatedBlock = _lastUpdatedBlock;
    }

    /// @inheritdoc IPostageStampStorage
    function transferToken(address _token, address _to, uint256 _amount) external returns (bool) {
        if (!hasRole(WRITER_ROLE, msg.sender)) {
            revert UnauthorizedWriter();
        }
        return ERC20(_token).transfer(_to, _amount);
    }

    /// @inheritdoc IPostageStampStorage
    function transferTokenFrom(address _token, address _from, uint256 _amount) external returns (bool) {
        if (!hasRole(WRITER_ROLE, msg.sender)) {
            revert UnauthorizedWriter();
        }
        return ERC20(_token).transferFrom(_from, address(this), _amount);
    }

    ////////////////////////////////////////
    //           STATE READING           //
    ////////////////////////////////////////

    /**
     * @notice Check if an address is an authorized writer (PostageStamp logic contract)
     * @param _address Address to check
     * @return True if the address has WRITER_ROLE
     */
    function isWriter(address _address) external view returns (bool) {
        return hasRole(WRITER_ROLE, _address);
    }

    /**
     * @notice Check if an address is the admin (multisig)
     * @param _address Address to check
     * @return True if the address has DEFAULT_ADMIN_ROLE
     */
    function isAdmin(address _address) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, _address);
    }

    /// @inheritdoc IPostageStampStorage
    function getBatch(bytes32 _batchId) external view returns (Batch memory) {
        return batches[_batchId];
    }

    /// @inheritdoc IPostageStampStorage
    function batchExists(bytes32 _batchId) external view returns (bool) {
        return batches[_batchId].owner != address(0);
    }

    /// @inheritdoc IPostageStampStorage
    function treeFirst() external view returns (uint256) {
        return tree.first();
    }

    /// @inheritdoc IPostageStampStorage
    function treeCount() external view returns (uint256) {
        return tree.count();
    }

    /// @inheritdoc IPostageStampStorage
    function treeValueKeyAtIndex(uint256 _value, uint256 _index) external view returns (bytes32) {
        return tree.valueKeyAtIndex(_value, _index);
    }

    /// @inheritdoc IPostageStampStorage
    function getTotalOutPayment() external view returns (uint256) {
        return totalOutPayment;
    }

    /// @inheritdoc IPostageStampStorage
    function getValidChunkCount() external view returns (uint256) {
        return validChunkCount;
    }

    /// @inheritdoc IPostageStampStorage
    function getPot() external view returns (uint256) {
        return pot;
    }

    /// @inheritdoc IPostageStampStorage
    function getLastExpiryBalance() external view returns (uint256) {
        return lastExpiryBalance;
    }

    /// @inheritdoc IPostageStampStorage
    function getLastPrice() external view returns (uint64) {
        return lastPrice;
    }

    /// @inheritdoc IPostageStampStorage
    function getLastUpdatedBlock() external view returns (uint64) {
        return lastUpdatedBlock;
    }

    /// @inheritdoc IPostageStampStorage
    function tokenBalance(address _token) external view returns (uint256) {
        return ERC20(_token).balanceOf(address(this));
    }
}
