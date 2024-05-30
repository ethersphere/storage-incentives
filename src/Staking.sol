// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title Staking contract for the Swarm storage incentives
 * @author The Swarm Authors
 * @dev Allows users to stake tokens in order to be eligible for the Redistribution Schelling co-ordination game.
 * Stakes are frozen or slashed by the Redistribution contract in response to violations of the
 * protocol.
 */

contract StakeRegistry is AccessControl, Pausable {
    // ----------------------------- State variables ------------------------------

    struct Stake {
        // Overlay of the node that is being staked
        bytes32 overlay;
        // Amount of tokens staked
        uint256 commitedStake;
        // Block height the stake was updated
        uint256 lastUpdatedBlockNumber;
        // Used to indicate presents in stakes struct
        bool isValue;
    }

    // Associate every stake id with node address data.
    mapping(address => Stake) public stakes;

    // Role allowed to pause
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    // Role allowed to freeze and slash entries
    bytes32 public constant REDISTRIBUTOR_ROLE = keccak256("REDISTRIBUTOR_ROLE");

    // Swarm network ID
    uint64 NetworkId;

    // Address of the staked ERC20 token
    address public immutable bzzToken;

    // ----------------------------- Events ------------------------------

    /**
     * @dev Emitted when a stake is created or updated by `owner` of the `overlay` by `stakeamount`, during `lastUpdatedBlock`.
     */
    event StakeUpdated(address indexed owner, uint256 stakeAmount, bytes32 overlay, uint256 lastUpdatedBlock);

    /**
     * @dev Emitted when a stake for address `slashed` is slashed by `amount`.
     */
    event StakeSlashed(address slashed, bytes32 overlay, uint256 amount);

    /**
     * @dev Emitted when a stake for address `frozen` is frozen for `time` blocks.
     */
    event StakeFrozen(address frozen, bytes32 overlay, uint256 time);

    /**
     * @dev Emitted when a address changes overlay it uses
     */
    event OverlayChanged(address owner, bytes32 overlay);

    // ----------------------------- Errors ------------------------------

    error TransferFailed(); // Used when token transfers fail
    error Frozen(); // Used when an action cannot proceed because the overlay is frozen
    error Unauthorized(); // Used where only the owner can perform the action
    error OnlyRedistributor(); // Used when only the redistributor role is allowed
    error OnlyPauser(); // Used when only the pauser role is allowed

    // ----------------------------- CONSTRUCTOR ------------------------------

    /**
     * @param _bzzToken Address of the staked ERC20 token
     * @param _NetworkId Swarm network ID
     */
    constructor(address _bzzToken, uint64 _NetworkId) {
        NetworkId = _NetworkId;
        bzzToken = _bzzToken;
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(PAUSER_ROLE, msg.sender);
    }

    ////////////////////////////////////////
    //            STATE SETTING           //
    ////////////////////////////////////////

    /**
     * @notice Create a new stake or update an existing one.
     * @dev At least `_initialBalancePerChunk*2^depth` number of tokens need to be preapproved for this contract.
     * @param _nonce Nonce that was used for overlay calculation.
     * @param _amount Deposited amount of ERC20 tokens.
     */
    function depositStake(bytes32 _nonce, uint256 _amount) external whenNotPaused {
        bytes32 overlay = keccak256(abi.encodePacked(msg.sender, reverse(NetworkId), _nonce));

        if (stakes[msg.sender].isValue && !addressNotFrozen(msg.sender)) revert Frozen();
        uint256 updatedAmount = stakes[msg.sender].isValue ? _amount + stakes[msg.sender].stakeAmount : _amount;

        if (!ERC20(bzzToken).transferFrom(msg.sender, address(this), _amount)) revert TransferFailed();

        stakes[msg.sender] = Stake({
            overlay: overlay,
            stakeAmount: updatedAmount,
            lastUpdatedBlockNumber: block.number,
            isValue: true
        });

        emit StakeUpdated(msg.sender, updatedAmount, overlay, block.number);
    }

    /**
     * @dev Withdraw stake only when the staking contract is paused,
     * @param _amount The amount of ERC20 tokens to be withdrawn
     */
    function withdrawFromStake(uint256 _amount) external whenPaused {
        Stake memory stake = stakes[msg.sender];

        // We cap the limit to not be over what is possible
        uint256 withDrawLimit = (_amount > stake.stakeAmount) ? stake.stakeAmount : _amount;
        stake.stakeAmount -= withDrawLimit;

        if (stake.stakeAmount == 0) {
            delete stakes[msg.sender];
        } else {
            stakes[msg.sender].lastUpdatedBlockNumber = block.number;
        }

        if (!ERC20(bzzToken).transfer(msg.sender, withDrawLimit)) revert TransferFailed();
    }

    /**
     * @dev Freeze an existing stake, can only be called by the redistributor
     * @param _owner the addres selected
     * @param _time penalty length in blocknumbers
     */
    function freezeDeposit(address _owner, uint256 _time) external {
        if (!hasRole(REDISTRIBUTOR_ROLE, msg.sender)) revert OnlyRedistributor();

        if (stakes[_owner].isValue) {
            stakes[_owner].lastUpdatedBlockNumber = block.number + _time;
            emit StakeFrozen(_owner, stakes[_owner].overlay, _time);
        }
    }

    /**
     * @dev Slash an existing stake, can only be called by the `redistributor`
     * @param _owner the _owner adress selected
     * @param _amount the amount to be slashed
     */
    function slashDeposit(address _owner, uint256 _amount) external {
        if (!hasRole(REDISTRIBUTOR_ROLE, msg.sender)) revert OnlyRedistributor();

        if (stakes[_owner].isValue) {
            if (stakes[_owner].stakeAmount > _amount) {
                stakes[_owner].stakeAmount -= _amount;
                stakes[_owner].lastUpdatedBlockNumber = block.number;
            } else {
                delete stakes[_owner];
            }
        }
        emit StakeSlashed(_owner, stakes[_owner].overlay, _amount);
    }

    /**
     * @dev Change overlay of address to new one for neighbourhood hopping
     * disable hopping if frozen, as it would reset frozen value of lastUpdatedBlockNumber that is future
     * @param _nonce the new nonce that will produce overlay
     */
    function changeOverlay(bytes32 _nonce) external whenNotPaused {
        if (stakes[msg.sender].isValue && !addressNotFrozen(msg.sender)) revert Frozen();
        bytes32 overlay = keccak256(abi.encodePacked(msg.sender, reverse(NetworkId), _nonce));

        stakes[msg.sender].overlay = overlay;
        stakes[msg.sender].lastUpdatedBlockNumber = block.number;
        emit OverlayChanged(msg.sender, overlay);
    }

    function changeNetworkId(uint64 _NetworkId) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert Unauthorized();
        NetworkId = _NetworkId;
    }

    /**
     * @dev Pause the contract. The contract is provably stopped by renouncing
     the pauser role and the admin role after pausing, can only be called by the `PAUSER`
     */
    function pause() public {
        if (!hasRole(PAUSER_ROLE, msg.sender)) revert OnlyPauser();
        _pause();
    }

    /**
     * @dev Unpause the contract, can only be called by the pauser when paused
     */
    function unPause() public {
        if (!hasRole(PAUSER_ROLE, msg.sender)) revert OnlyPauser();
        _unpause();
    }

    ////////////////////////////////////////
    //            STATE READING           //
    ////////////////////////////////////////

    /**
     * @dev Checks to see if `address` is frozen.
     * @param _owner owner of staked address
     *
     * Returns a boolean value indicating whether the operation succeeded.
     */
    function addressNotFrozen(address _owner) internal view returns (bool) {
        return stakes[_owner].lastUpdatedBlockNumber < block.number;
    }

    /**
     * @dev Returns the current `stakeAmount` of `address`.
     * @param _owner _owner of node
     */
    function stakeOfAddress(address _owner) public view returns (uint256) {
        return stakes[_owner].stakeAmount;
    }

    /**
     * @dev Returns the current usable `stakeAmount` of `address`.
     * Checks whether the stake is currently frozen.
     * @param _owner owner of node
     */
    function usableStakeOfAddress(address _owner) public view returns (uint256) {
        return addressNotFrozen(_owner) ? stakes[_owner].stakeAmount : 0;
    }

    /**
     * @dev Returns the `lastUpdatedBlockNumber` of `address`.
     */
    function lastUpdatedBlockNumberOfAddress(address _owner) public view returns (uint256) {
        return stakes[_owner].lastUpdatedBlockNumber;
    }

    /**
     * @dev Returns the currently used overlay of the address.
     * @param _owner address of node
     */
    function overlayOfAddress(address _owner) public view returns (bytes32) {
        return stakes[_owner].overlay;
    }

    /**
     * @dev Please both Endians 🥚.
     * @param input Eth address used for overlay calculation.
     */
    function reverse(uint64 input) internal pure returns (uint64 v) {
        v = input;

        // swap bytes
        v = ((v & 0xFF00FF00FF00FF00) >> 8) | ((v & 0x00FF00FF00FF00FF) << 8);

        // swap 2-byte long pairs
        v = ((v & 0xFFFF0000FFFF0000) >> 16) | ((v & 0x0000FFFF0000FFFF) << 16);

        // swap 4-byte long pairs
        v = (v >> 32) | (v << 32);
    }
}
