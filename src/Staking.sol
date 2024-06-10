// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

interface IPriceOracle {
    function currentPrice() external view returns (uint32);
}

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
        // Amount of tokens staked as potential stake
        uint256 potentialStake;
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

    // The address of the linked PriceOracle contract.
    IPriceOracle public OracleContract;

    // ----------------------------- Events ------------------------------

    /**
     * @dev Emitted when a stake is created or updated by `owner` of the `overlay` by `commitedStake`, and `potentialStake` during `lastUpdatedBlock`.
     */
    event StakeUpdated(
        address indexed owner,
        uint256 commitedStake,
        uint256 potentialStake,
        bytes32 overlay,
        uint256 lastUpdatedBlock
    );

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

    /**
     * @dev Emitted when a stake for address is withdrawn
     */
    event StakeWithdrawn(address node, uint256 amount);

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
    constructor(address _bzzToken, uint64 _NetworkId, address _oracleContract) {
        NetworkId = _NetworkId;
        bzzToken = _bzzToken;
        OracleContract = IPriceOracle(_oracleContract);
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(PAUSER_ROLE, msg.sender);
    }

    ////////////////////////////////////////
    //            STATE SETTING           //
    ////////////////////////////////////////

    /**
     * @notice Create a new stake or update an existing one, change overlay of node
     * @dev At least `_initialBalancePerChunk*2^depth` number of tokens need to be preapproved for this contract.
     * @param _setNonce Nonce that was used for overlay calculation.
     * @param _addAmount Deposited amount of ERC20 tokens.
     * @param _addCommitedStake The committed stake is interpreted as the stake that the staker commits to stake
     */
    function manageStake(bytes32 _setNonce, uint256 _addAmount, uint256 _addCommitedStake) external whenNotPaused {
        bytes32 _previousOverlay = stakes[msg.sender].overlay;
        bytes32 _newOverlay = keccak256(abi.encodePacked(msg.sender, reverse(NetworkId), _setNonce));

        if (stakes[msg.sender].isValue && !addressNotFrozen(msg.sender)) revert Frozen();
        uint256 updatedAmount = stakes[msg.sender].isValue
            ? _addAmount + stakes[msg.sender].potentialStake
            : _addAmount;

        uint256 updatedCommitedStake = stakes[msg.sender].isValue
            ? _addCommitedStake + stakes[msg.sender].commitedStake
            : _addCommitedStake;

        stakes[msg.sender] = Stake({
            overlay: _newOverlay,
            commitedStake: updatedCommitedStake,
            potentialStake: updatedAmount,
            lastUpdatedBlockNumber: block.number,
            isValue: true
        });

        // Transfer tokens and emit event that stake has been updated
        if (_addAmount > 0) {
            if (!ERC20(bzzToken).transferFrom(msg.sender, address(this), _addAmount)) revert TransferFailed();
            emit StakeUpdated(msg.sender, updatedCommitedStake, updatedAmount, _newOverlay, block.number);
        }

        // Emit overlay change event
        if (_previousOverlay != _newOverlay) {
            emit OverlayChanged(msg.sender, _newOverlay);
        }
    }

    /**
     * @dev Withdraw node stake surplus
     */
    function withdrawFromStake() external whenNotPaused {
        Stake memory stake = stakes[msg.sender];

        uint256 _surplusStake = stake.potentialStake -
            calculateEffectiveStake(stake.commitedStake, stake.potentialStake);

        if (_surplusStake > 0) {
            // TODO Do we reset node from playing 2 rounds?
            stakes[msg.sender].lastUpdatedBlockNumber = block.number;
            if (!ERC20(bzzToken).transfer(msg.sender, _surplusStake)) revert TransferFailed();
            emit StakeWithdrawn(msg.sender, _surplusStake);
        }

        // TODO do we need do delete stake? commited stake cant be lowered
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
            if (stakes[_owner].potentialStake > _amount) {
                stakes[_owner].potentialStake -= _amount;
                stakes[_owner].lastUpdatedBlockNumber = block.number;
            } else {
                delete stakes[_owner];
            }
        }
        emit StakeSlashed(_owner, stakes[_owner].overlay, _amount);
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
     * @dev Returns the current `potentialStake` of `address`.
     * @param _owner _owner of node
     */
    function stakeOfAddress(address _owner) public view returns (uint256) {
        return stakes[_owner].potentialStake;
    }

    /**
     * @dev Returns the current usable `potentialStake` of `address`.
     * Checks whether the stake is currently frozen.
     * @param _owner owner of node
     */
    function usableStakeOfAddress(address _owner) public view returns (uint256) {
        return addressNotFrozen(_owner) ? stakes[_owner].potentialStake : 0;
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

    function calculateEffectiveStake(
        uint256 committedStake,
        uint256 potentialStakeBalance
    ) internal view returns (uint256) {
        // Calculate the product of committedStake and unitPrice
        uint256 calculatedStake = committedStake * OracleContract.currentPrice();

        // Return the minimum value between calculatedStake and potentialStakeBalance
        if (calculatedStake < potentialStakeBalance) {
            return calculatedStake;
        } else {
            return potentialStakeBalance;
        }
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
