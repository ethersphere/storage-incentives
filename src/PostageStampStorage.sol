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
 * versions and updating the authorized logic contract address in this storage contract.
 * This eliminates the need to migrate funds and batch data when upgrading the system.
 */
contract PostageStampStorage is AccessControl, IPostageStampStorage {
    using HitchensOrderStatisticsTreeLib for HitchensOrderStatisticsTreeLib.Tree;

    // ----------------------------- State variables ------------------------------

    /// @notice Address of the ERC20 BZZ token
    address public immutable bzzToken;

    /// @notice Current authorized logic contract that can modify storage
    address public logicContract;

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

    /// @notice Role that can update the logic contract address
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Role that can perform emergency operations
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    // ----------------------------- Errors ------------------------------

    error UnauthorizedLogicContract();
    error ZeroAddress();
    error SameLogicContract();

    // ----------------------------- Modifiers ------------------------------

    /**
     * @notice Restricts function access to the authorized logic contract only
     */
    modifier onlyLogicContract() {
        if (msg.sender != logicContract) {
            revert UnauthorizedLogicContract();
        }
        _;
    }

    // ----------------------------- Constructor ------------------------------

    /**
     * @notice Initialize the storage contract
     * @param _bzzToken Address of the BZZ token contract
     * @param _initialLogicContract Address of the initial logic contract
     * @param _admin Address of the admin who can update the logic contract
     */
    constructor(address _bzzToken, address _initialLogicContract, address _admin) {
        if (_bzzToken == address(0) || _initialLogicContract == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }

        bzzToken = _bzzToken;
        logicContract = _initialLogicContract;

        _setupRole(ADMIN_ROLE, _admin);
        _setupRole(DEFAULT_ADMIN_ROLE, _admin);
        _setRoleAdmin(ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
    }

    // ----------------------------- Storage Operations ------------------------------

    /// @inheritdoc IPostageStampStorage
    function storeBatch(bytes32 _batchId, Batch calldata _batch) external onlyLogicContract {
        batches[_batchId] = _batch;
        emit BatchStored(_batchId);
    }

    /// @inheritdoc IPostageStampStorage
    function deleteBatch(bytes32 _batchId) external onlyLogicContract {
        delete batches[_batchId];
        emit BatchDeleted(_batchId);
    }

    /// @inheritdoc IPostageStampStorage
    function getBatch(bytes32 _batchId) external view returns (Batch memory) {
        return batches[_batchId];
    }

    /// @inheritdoc IPostageStampStorage
    function batchExists(bytes32 _batchId) external view returns (bool) {
        return batches[_batchId].owner != address(0);
    }

    // ----------------------------- Tree Operations ------------------------------

    /// @inheritdoc IPostageStampStorage
    function treeInsert(bytes32 _batchId, uint256 _normalisedBalance) external onlyLogicContract {
        tree.insert(_batchId, _normalisedBalance);
    }

    /// @inheritdoc IPostageStampStorage
    function treeRemove(bytes32 _batchId, uint256 _normalisedBalance) external onlyLogicContract {
        tree.remove(_batchId, _normalisedBalance);
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

    // ----------------------------- Global State ------------------------------

    /// @inheritdoc IPostageStampStorage
    function setTotalOutPayment(uint256 _totalOutPayment) external onlyLogicContract {
        totalOutPayment = _totalOutPayment;
    }

    /// @inheritdoc IPostageStampStorage
    function getTotalOutPayment() external view returns (uint256) {
        return totalOutPayment;
    }

    /// @inheritdoc IPostageStampStorage
    function setValidChunkCount(uint256 _validChunkCount) external onlyLogicContract {
        validChunkCount = _validChunkCount;
    }

    /// @inheritdoc IPostageStampStorage
    function getValidChunkCount() external view returns (uint256) {
        return validChunkCount;
    }

    /// @inheritdoc IPostageStampStorage
    function setPot(uint256 _pot) external onlyLogicContract {
        pot = _pot;
    }

    /// @inheritdoc IPostageStampStorage
    function getPot() external view returns (uint256) {
        return pot;
    }

    /// @inheritdoc IPostageStampStorage
    function setLastExpiryBalance(uint256 _lastExpiryBalance) external onlyLogicContract {
        lastExpiryBalance = _lastExpiryBalance;
    }

    /// @inheritdoc IPostageStampStorage
    function getLastExpiryBalance() external view returns (uint256) {
        return lastExpiryBalance;
    }

    /// @inheritdoc IPostageStampStorage
    function setLastPrice(uint64 _lastPrice) external onlyLogicContract {
        lastPrice = _lastPrice;
    }

    /// @inheritdoc IPostageStampStorage
    function getLastPrice() external view returns (uint64) {
        return lastPrice;
    }

    /// @inheritdoc IPostageStampStorage
    function setLastUpdatedBlock(uint64 _lastUpdatedBlock) external onlyLogicContract {
        lastUpdatedBlock = _lastUpdatedBlock;
    }

    /// @inheritdoc IPostageStampStorage
    function getLastUpdatedBlock() external view returns (uint64) {
        return lastUpdatedBlock;
    }

    // ----------------------------- Token Operations ------------------------------

    /// @inheritdoc IPostageStampStorage
    function transferToken(address _token, address _to, uint256 _amount) external onlyLogicContract returns (bool) {
        return ERC20(_token).transfer(_to, _amount);
    }

    /// @inheritdoc IPostageStampStorage
    function transferTokenFrom(
        address _token,
        address _from,
        uint256 _amount
    ) external onlyLogicContract returns (bool) {
        return ERC20(_token).transferFrom(_from, address(this), _amount);
    }

    /// @inheritdoc IPostageStampStorage
    function tokenBalance(address _token) external view returns (uint256) {
        return ERC20(_token).balanceOf(address(this));
    }

    // ----------------------------- Logic Contract Management ------------------------------

    /// @inheritdoc IPostageStampStorage
    function updateLogicContract(address _newLogicContract) external onlyRole(ADMIN_ROLE) {
        if (_newLogicContract == address(0)) {
            revert ZeroAddress();
        }
        if (_newLogicContract == logicContract) {
            revert SameLogicContract();
        }

        address oldLogic = logicContract;
        logicContract = _newLogicContract;

        emit LogicContractUpdated(oldLogic, _newLogicContract);
    }
}
