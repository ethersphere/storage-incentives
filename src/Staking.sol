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
        uint256 committedStake;
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

    // The miniumum stake allowed to be staked using the Staking contract.
    uint64 private constant MIN_STAKE = 100000000000000000;

    // Address of the staked ERC20 token
    address public immutable bzzToken;

    // The address of the linked PriceOracle contract.
    IPriceOracle public OracleContract;

    // ----------------------------- Events ------------------------------

    /**
     * @dev Emitted when a stake is created or updated by `owner` of the `overlay` by `committedStake`, and `potentialStake` during `lastUpdatedBlock`.
     */
    event StakeUpdated(
        address indexed owner,
        uint256 committedStake,
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
    error BelowMinimumStake(); // Node participating in game has stake below minimum treshold

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
     * @param _addAmount Deposited amount of ERC20 tokens, equals to added Potential stake value
     */
    function manageStake(bytes32 _setNonce, uint256 _addAmount) external whenNotPaused {
        bytes32 _previousOverlay = stakes[msg.sender].overlay;
        bytes32 _newOverlay = keccak256(abi.encodePacked(msg.sender, reverse(NetworkId), _setNonce));
        uint256 _addCommittedStake = _addAmount / OracleContract.currentPrice(); // losing some decimals from start 10n16 is 99999999999984000

        // First time adding stake, check the minimum is added
        if (_addAmount < MIN_STAKE && !stakes[msg.sender].isValue) {
            revert BelowMinimumStake();
        }

        if (stakes[msg.sender].isValue && !addressNotFrozen(msg.sender)) revert Frozen();
        uint256 updatedPotentialStake = stakes[msg.sender].potentialStake + _addAmount;
        uint256 updatedCommittedStake = stakes[msg.sender].committedStake + _addCommittedStake;

        stakes[msg.sender] = Stake({
            overlay: _newOverlay,
            committedStake: updatedCommittedStake,
            potentialStake: updatedPotentialStake,
            lastUpdatedBlockNumber: block.number,
            isValue: true
        });

        // Transfer tokens and emit event that stake has been updated
        if (_addAmount > 0) {
            if (!ERC20(bzzToken).transferFrom(msg.sender, address(this), _addAmount)) revert TransferFailed();
            emit StakeUpdated(msg.sender, updatedCommittedStake, updatedPotentialStake, _newOverlay, block.number);
        }

        // Emit overlay change event
        if (_previousOverlay != _newOverlay) {
            emit OverlayChanged(msg.sender, _newOverlay);
        }
    }

    /**
     * @dev Withdraw node stake surplus
     */
    function withdrawFromStake() external {
        Stake memory stake = stakes[msg.sender];

        uint256 _surplusStake = stake.potentialStake -
            calculateEffectiveStake(stake.committedStake, stake.potentialStake);

        if (_surplusStake > 0) {
            stakes[msg.sender].potentialStake -= _surplusStake;
            stakes[msg.sender].committedStake -= _surplusStake / OracleContract.currentPrice();
            if (!ERC20(bzzToken).transfer(msg.sender, _surplusStake)) revert TransferFailed();
            emit StakeWithdrawn(msg.sender, _surplusStake);
        }
    }

    /**
     * @dev Migrate stake only when the staking contract is paused,
     * can only be called by the owner of the stake
     */
    function migrateStake() external whenPaused {
        Stake memory stake = stakes[msg.sender];

        // We take out all the stake so user can migrate stake to other contract
        if (stake.lastUpdatedBlockNumber != 0) {
            if (!ERC20(bzzToken).transfer(msg.sender, stake.potentialStake)) revert TransferFailed();
            delete stakes[msg.sender];
        }
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
     * @dev Returns the current `effectiveStake` of `address`.
     * @param _owner _owner of node
     */
    function nodeEffectiveStake(address _owner) public view returns (uint256) {
        Stake memory stake = stakes[_owner];
        return calculateEffectiveStake(stake.committedStake, stake.potentialStake);
    }

    // TODO should we change this to effective stake?
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
        // Calculate the product of committedStake and unitPrice to get price in BZZ
        uint256 committedStakeBzz = committedStake * OracleContract.currentPrice();

        // Return the minimum value between committedStakeBzz and potentialStakeBalance
        if (committedStakeBzz < potentialStakeBalance) {
            return committedStakeBzz;
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
