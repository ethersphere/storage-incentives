// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title Staking contract for the Swarm storage incentives
 * @author The Swarm Authors
 * @dev Allows users to stake tokens in order to be eligible for the Redistribution Schelling co-ordination game.
 * Stakes are not withdrawable unless the contract is paused, e.g. in the event of migration to a new staking
 * contract. Stakes are frozen or slashed by the Redistribution contract in response to violations of the
 * protocol.
 */

contract StakeRegistry is AccessControl, Pausable {
    /**
     * @dev Emitted when a stake is created or updated by `owner` of the `overlay` by `stakeamount`, during `lastUpdatedBlock`.
     */
    event StakeUpdated(bytes32 indexed overlay, uint256 stakeAmount, address owner, uint256 lastUpdatedBlock);

    /**
     * @dev Emitted when a stake for overlay `slashed` is slashed by `amount`.
     */
    event StakeSlashed(bytes32 slashed, uint256 amount);

    /**
     * @dev Emitted when a stake for overlay `frozen` for `time` blocks.
     */
    event StakeFrozen(bytes32 slashed, uint256 time);

    struct Stake {
        // Overlay of the node that is being staked
        bytes32 overlay;
        // Amount of tokens staked
        uint256 stakeAmount;
        // Owner of `overlay`
        address owner;
        // Block height the stake was updated
        uint256 lastUpdatedBlockNumber;
        // Used to indicate presents in stakes struct
        bool isValue;
    }

    // Associate every stake id with overlay data.
    mapping(bytes32 => Stake) public stakes;

    // Role allowed to pause
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    // Role allowed to freeze and slash entries
    bytes32 public constant REDISTRIBUTOR_ROLE = keccak256("REDISTRIBUTOR_ROLE");

    // Swarm network ID
    uint64 NetworkId;

    // Address of the staked ERC20 token
    address public bzzToken;

    /**
     * @param _bzzToken Address of the staked ERC20 token
     * @param _NetworkId Swarm network ID
     */
    constructor(address _bzzToken, uint64 _NetworkId, address multisig) {
        NetworkId = _NetworkId;
        bzzToken = _bzzToken;
        _setupRole(DEFAULT_ADMIN_ROLE, multisig);
        _setupRole(PAUSER_ROLE, msg.sender);
    }

    /**
     * @dev Checks to see if `overlay` is frozen.
     * @param overlay Overlay of staked overlay
     *
     * Returns a boolean value indicating whether the operation succeeded.
     */
    function overlayNotFrozen(bytes32 overlay) internal view returns (bool) {
        return stakes[overlay].lastUpdatedBlockNumber < block.number;
    }

    /**
     * @dev Returns the current `stakeAmount` of `overlay`.
     * @param overlay Overlay of node
     */
    function stakeOfOverlay(bytes32 overlay) public view returns (uint256) {
        return stakes[overlay].stakeAmount;
    }

    /**
     * @dev Returns the current usable `stakeAmount` of `overlay`.
     * Checks whether the stake is currently frozen.
     * @param overlay Overlay of node
     */
    function usableStakeOfOverlay(bytes32 overlay) public view returns (uint256) {
        return overlayNotFrozen(overlay) ? stakes[overlay].stakeAmount : 0;
    }

    /**
     * @dev Returns the `lastUpdatedBlockNumber` of `overlay`.
     */
    function lastUpdatedBlockNumberOfOverlay(bytes32 overlay) public view returns (uint256) {
        return stakes[overlay].lastUpdatedBlockNumber;
    }

    /**
     * @dev Returns the eth address of the owner of `overlay`.
     * @param overlay Overlay of node
     */
    function ownerOfOverlay(bytes32 overlay) public view returns (address) {
        return stakes[overlay].owner;
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

    /**
     * @notice Create a new stake or update an existing one.
     * @dev At least `_initialBalancePerChunk*2^depth` number of tokens need to be preapproved for this contract.
     * @param _owner Eth address used for overlay calculation.
     * @param nonce Nonce that was used for overlay calculation.
     * @param amount Deposited amount of ERC20 tokens.
     */
    function depositStake(address _owner, bytes32 nonce, uint256 amount) external whenNotPaused {
        require(_owner == msg.sender, "only owner can update stake");

        bytes32 overlay = keccak256(abi.encodePacked(_owner, reverse(NetworkId), nonce));

        uint256 updatedAmount = amount;

        if (stakes[overlay].isValue) {
            require(overlayNotFrozen(overlay), "overlay currently frozen");
            updatedAmount = amount + stakes[overlay].stakeAmount;
        }

        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), amount), "failed transfer");

        emit StakeUpdated(overlay, updatedAmount, _owner, block.number);

        stakes[overlay] = Stake({
            owner: _owner,
            overlay: overlay,
            stakeAmount: updatedAmount,
            lastUpdatedBlockNumber: block.number,
            isValue: true
        });
    }

    /**
     * @dev Withdraw stake only when the staking contract is paused,
     * can only be called by the owner specific to the associated `overlay`
     * @param overlay The overlay to withdraw from
     * @param amount The amount of ERC20 tokens to be withdrawn
     */
    function withdrawFromStake(bytes32 overlay, uint256 amount) external whenPaused {
        require(stakes[overlay].owner == msg.sender, "only owner can withdraw stake");
        uint256 withDrawLimit = amount;
        if (withDrawLimit >= stakes[overlay].stakeAmount) {
            withDrawLimit = stakes[overlay].stakeAmount;
            delete stakes[overlay];
            require(ERC20(bzzToken).transfer(msg.sender, withDrawLimit), "failed withdrawal");
        }

        if (withDrawLimit < stakes[overlay].stakeAmount) {
            stakes[overlay].stakeAmount -= withDrawLimit;
            stakes[overlay].lastUpdatedBlockNumber = block.number;
            require(ERC20(bzzToken).transfer(msg.sender, withDrawLimit), "failed withdrawal");
        }
    }

    /**
     * @dev Freeze an existing stake, can only be called by the redistributor
     * @param overlay the overlay selected
     * @param time penalty length in blocknumbers
     */
    function freezeDeposit(bytes32 overlay, uint256 time) external {
        require(hasRole(REDISTRIBUTOR_ROLE, msg.sender), "only redistributor can freeze stake");

        if (stakes[overlay].isValue) {
            emit StakeFrozen(overlay, time);
            stakes[overlay].lastUpdatedBlockNumber = block.number + time;
        }
    }

    /**
     * @dev Slash an existing stake, can only be called by the `redistributor`
     * @param overlay the overlay selected
     * @param amount the amount to be slashed
     */
    function slashDeposit(bytes32 overlay, uint256 amount) external {
        require(hasRole(REDISTRIBUTOR_ROLE, msg.sender), "only redistributor can slash stake");
        emit StakeSlashed(overlay, amount);
        if (stakes[overlay].isValue) {
            if (stakes[overlay].stakeAmount > amount) {
                stakes[overlay].stakeAmount -= amount;
                stakes[overlay].lastUpdatedBlockNumber = block.number;
            } else {
                delete stakes[overlay];
            }
        }
    }

    /**
     * @dev Pause the contract. The contract is provably stopped by renouncing
     the pauser role and the admin role after pausing, can only be called by the `PAUSER`
     */
    function pause() public {
        require(hasRole(PAUSER_ROLE, msg.sender), "only pauser can pause");
        _pause();
    }

    /**
     * @dev Unpause the contract, can only be called by the pauser when paused
     */
    function unPause() public {
        require(hasRole(PAUSER_ROLE, msg.sender), "only pauser can unpause");
        _unpause();
    }
}
