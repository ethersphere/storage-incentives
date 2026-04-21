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

    uint256 private constant ROUND_LENGTH = 152;
    uint256 private constant MIN_STAKE = 100000000000000000;
    uint256 public constant UPDATE_QUEUE_MAX_LENGTH = 10;

    // ----------------------------- Type declarations ------------------------------

    enum UpdateKind {
        CreateDeposit,
        AddTokens,
        IncreaseHeight,
        ChangeOverlay,
        WithdrawTokens,
        ExitStake
    }

    struct Stake {
        bytes32 overlay;
        uint256 balance;
        uint256 frozenUntilBlock;
        uint8 height;
    }

    struct ScheduledUpdate {
        UpdateKind kind;
        uint64 effectiveFromRound;
        bytes32 nonce;
        uint256 amount;
        uint8 height;
    }

    mapping(address => Stake) private _stakes;
    mapping(address => ScheduledUpdate[]) private _updateQueues;
    mapping(address => uint256) private _queueHeads;
    mapping(address => bool) private _queueClosed;

    bytes32 public constant REDISTRIBUTOR_ROLE = keccak256("REDISTRIBUTOR_ROLE");

    uint64 public NetworkId;
    address public immutable bzzToken;
    uint64 public immutable WAIT_BASE;
    uint64 public immutable WAIT_OVERLAY_CHANGE;
    uint64 public immutable WAIT_WITHDRAWAL;

    // ----------------------------- Events ------------------------------

    event DepositCreated(
        address indexed owner, uint64 registeredFromRound, uint256 amount, bytes32 overlay, uint8 height
    );
    event TokensAdded(address indexed owner, uint64 registeredFromRound, uint256 amount);
    event OverlayChanged(address indexed owner, uint64 registeredFromRound, bytes32 overlay);
    event HeightIncreased(address indexed owner, uint64 registeredFromRound, uint8 height);
    event Withdrawal(address indexed owner, uint64 registeredFromRound, uint256 amount);
    event StakeSlashed(address slashed, bytes32 overlay, uint256 amount);
    event StakeFrozen(address frozen, bytes32 overlay, uint256 time);

    // ----------------------------- Errors ------------------------------

    error TransferFailed();
    error Unauthorized();
    error OnlyRedistributor();
    error OnlyPauser();
    error BelowMinimumStake();
    error NotStaked();
    error AlreadyStaked();
    error HeightDecreaseNotAllowed();
    error InvalidWithdrawalAmount();
    error UpdateQueueFull();
    error QueueClosed();
    error FrozenWithdrawal();
    error InvalidWaitConfiguration();

    constructor(
        address _bzzToken,
        uint64 _NetworkId,
        uint64 _waitBase,
        uint64 _waitOverlayChange,
        uint64 _waitWithdrawal
    ) {
        if (_waitOverlayChange < _waitBase || _waitWithdrawal < _waitBase) {
            revert InvalidWaitConfiguration();
        }
        NetworkId = _NetworkId;
        bzzToken = _bzzToken;
        WAIT_BASE = _waitBase;
        WAIT_OVERLAY_CHANGE = _waitOverlayChange;
        WAIT_WITHDRAWAL = _waitWithdrawal;
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    ////////////////////////////////////////
    //           STATE CHANGING           //
    ////////////////////////////////////////

    /**
     * @notice Schedules a new deposit to become active after the base delay.
     * @param _setNonce The nonce used to derive the overlay.
     * @param _amount The amount of BZZ to lock.
     * @param _height The initial staking height.
     */
    function createDeposit(bytes32 _setNonce, uint256 _amount, uint8 _height) external whenNotPaused {
        if (_queueClosed[msg.sender]) revert QueueClosed();
        Stake memory plannedStake = _previewStake(msg.sender, true);
        if (_isInitialized(plannedStake) && plannedStake.balance > 0) revert AlreadyStaked();
        if (_amount < _minimumStakeForHeight(_height)) revert BelowMinimumStake();

        bytes32 newOverlay = _deriveOverlay(msg.sender, _setNonce);
        _pullTokens(msg.sender, _amount);

        uint64 effectiveFromRound =
            _enqueueUpdate(msg.sender, UpdateKind.CreateDeposit, WAIT_BASE, _setNonce, _amount, _height);

        emit DepositCreated(msg.sender, effectiveFromRound, _amount, newOverlay, _height);
    }

    /**
     * @notice Schedules an increase of the caller's stake balance.
     * @param _amount The amount of BZZ to add to the stake.
     */
    function addTokens(uint256 _amount) external whenNotPaused {
        if (_queueClosed[msg.sender]) revert QueueClosed();
        Stake memory plannedStake = _previewStake(msg.sender, true);
        if (!_isInitialized(plannedStake) || plannedStake.balance == 0) revert NotStaked();

        _pullTokens(msg.sender, _amount);
        uint64 effectiveFromRound = _enqueueUpdate(msg.sender, UpdateKind.AddTokens, WAIT_BASE, 0, _amount, 0);

        emit TokensAdded(msg.sender, effectiveFromRound, _amount);
    }

    /**
     * @notice Schedules an overlay change after the configured overlay delay.
     * @param _setNonce The nonce used to derive the new overlay.
     */
    function changeOverlay(bytes32 _setNonce) external whenNotPaused {
        if (_queueClosed[msg.sender]) revert QueueClosed();
        Stake memory plannedStake = _previewStake(msg.sender, true);
        if (!_isInitialized(plannedStake) || plannedStake.balance == 0) revert NotStaked();

        bytes32 newOverlay = _deriveOverlay(msg.sender, _setNonce);
        if (newOverlay == plannedStake.overlay) return;

        uint64 effectiveFromRound =
            _enqueueUpdate(msg.sender, UpdateKind.ChangeOverlay, WAIT_OVERLAY_CHANGE, _setNonce, 0, 0);

        emit OverlayChanged(msg.sender, effectiveFromRound, newOverlay);
    }

    /**
     * @notice Schedules a height increase once the base delay elapses.
     * @param _height The new staking height.
     */
    function increaseHeight(uint8 _height) external whenNotPaused {
        if (_queueClosed[msg.sender]) revert QueueClosed();
        Stake memory plannedStake = _previewStake(msg.sender, true);
        if (!_isInitialized(plannedStake) || plannedStake.balance == 0) revert NotStaked();
        if (_height < plannedStake.height) revert HeightDecreaseNotAllowed();
        if (_height == plannedStake.height) return;
        if (plannedStake.balance < _minimumStakeForHeight(_height)) revert BelowMinimumStake();

        uint64 effectiveFromRound = _enqueueUpdate(msg.sender, UpdateKind.IncreaseHeight, WAIT_BASE, 0, 0, _height);
        emit HeightIncreased(msg.sender, effectiveFromRound, _height);
    }

    /**
     * @notice Schedules a partial withdrawal after the withdrawal delay.
     * @param _amount The amount of BZZ to withdraw from the stake.
     */
    function withdraw(uint256 _amount) external whenNotPaused {
        if (_amount == 0) revert InvalidWithdrawalAmount();
        if (_queueClosed[msg.sender]) revert QueueClosed();

        Stake memory plannedStake = _previewStake(msg.sender, true);
        if (!_isInitialized(plannedStake) || plannedStake.balance == 0) revert NotStaked();
        if (_amount >= plannedStake.balance) revert BelowMinimumStake();
        if (plannedStake.balance - _amount < _minimumStakeForHeight(plannedStake.height)) revert BelowMinimumStake();

        uint64 effectiveFromRound =
            _enqueueUpdate(msg.sender, UpdateKind.WithdrawTokens, WAIT_WITHDRAWAL, 0, _amount, 0);
        emit Withdrawal(msg.sender, effectiveFromRound, _amount);
    }

    /**
     * @notice Schedules a full exit after the withdrawal delay.
     */
    function exit() external whenNotPaused {
        if (_queueClosed[msg.sender]) revert QueueClosed();
        Stake memory plannedStake = _previewStake(msg.sender, true);
        if (!_isInitialized(plannedStake) || plannedStake.balance == 0) revert NotStaked();

        uint64 effectiveFromRound = _enqueueUpdate(msg.sender, UpdateKind.ExitStake, WAIT_WITHDRAWAL, 0, 0, 0);
        _queueClosed[msg.sender] = true;
        emit Withdrawal(msg.sender, effectiveFromRound, plannedStake.balance);
    }

    /**
     * @notice Applies all updates that are ready for the given owner.
     * @param _owner The address whose queue should be processed.
     */
    function applyUpdates(address _owner) public {
        _applyReadyUpdates(_owner);
        if (
            _queueLength(_owner) > 0
                && _blocksQueuedWithdrawalExecution(_owner, _updateQueues[_owner][_queueHeads[_owner]].kind)
        ) {
            revert FrozenWithdrawal();
        }
    }

    /**
     * @notice Withdraws active and queued stake while the contract is paused.
     * @dev Used for migration flows where queued deposits and top ups must be returned.
     */
    function migrateStake() external whenPaused {
        _applyReadyUpdates(msg.sender);

        uint256 payout = _stakes[msg.sender].balance;
        ScheduledUpdate[] storage queue = _updateQueues[msg.sender];
        uint256 head = _queueHeads[msg.sender];

        for (uint256 i = head; i < queue.length;) {
            ScheduledUpdate storage scheduled = queue[i];
            if (scheduled.kind == UpdateKind.CreateDeposit || scheduled.kind == UpdateKind.AddTokens) {
                payout += scheduled.amount;
            }

            unchecked {
                ++i;
            }
        }

        delete _stakes[msg.sender];
        delete _updateQueues[msg.sender];
        delete _queueHeads[msg.sender];
        delete _queueClosed[msg.sender];

        if (payout > 0) {
            if (!ERC20(bzzToken).transfer(msg.sender, payout)) revert TransferFailed();
        }
    }

    /**
     * @notice Freezes a stake and blocks queued withdrawals while the freeze lasts.
     * @param _owner The staker to freeze.
     * @param _time The freeze duration in blocks.
     */
    function freezeDeposit(address _owner, uint256 _time) external {
        if (!hasRole(REDISTRIBUTOR_ROLE, msg.sender)) revert OnlyRedistributor();

        if (!_isInitialized(_owner) && _queueLength(_owner) == 0) {
            return;
        }

        _applyReadyUpdates(_owner);
        _stakes[_owner].frozenUntilBlock = block.number + _time;

        if (_isInitialized(_owner)) {
            emit StakeFrozen(_owner, _stakes[_owner].overlay, _time);
        }
    }

    /**
     * @notice Slashes the active stake and reconciles queued withdrawals if needed.
     * @param _owner The staker to slash.
     * @param _amount The amount to slash from the active stake.
     */
    function slashDeposit(address _owner, uint256 _amount) external {
        if (!hasRole(REDISTRIBUTOR_ROLE, msg.sender)) revert OnlyRedistributor();

        _applyReadyUpdates(_owner);

        Stake storage stake = _stakes[_owner];
        bytes32 previousOverlay = stake.overlay;

        if (_isInitialized(_owner)) {
            if (stake.balance > _amount) {
                stake.balance -= _amount;
            } else if (_queueLength(_owner) > 0) {
                stake.balance = 0;
            } else {
                delete _stakes[_owner];
            }

            _reconcileQueuedWithdrawals(_owner);
        }

        emit StakeSlashed(_owner, previousOverlay, _amount);
    }

    /**
     * @notice Updates the Swarm network identifier used in overlay derivation.
     * @param _NetworkId The new network id.
     */
    function changeNetworkId(uint64 _NetworkId) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert Unauthorized();
        NetworkId = _NetworkId;
    }

    /**
     * @notice Pauses staking mutations.
     */
    function pause() public {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert OnlyPauser();
        _pause();
    }

    /**
     * @notice Unpauses staking mutations.
     */
    function unPause() public {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert OnlyPauser();
        _unpause();
    }

    ////////////////////////////////////////
    //            STATE READING           //
    ////////////////////////////////////////

    /**
     * @notice Returns the currently visible stake state for an owner.
     */
    function stakes(address _owner) public view returns (Stake memory) {
        return _previewStake(_owner, false);
    }

    /**
     * @notice Returns the currently effective stake balance for an owner.
     */
    function nodeEffectiveStake(address _owner) public view returns (uint256) {
        if (!addressNotFrozen(_owner)) return 0;

        Stake memory preview = _previewStake(_owner, false);
        return _isInitialized(preview) ? preview.balance : 0;
    }

    /**
     * @notice Returns the currently effective overlay for an owner.
     */
    function overlayOfAddress(address _owner) public view returns (bytes32) {
        Stake memory preview = _previewStake(_owner, false);
        return _isInitialized(preview) ? preview.overlay : bytes32(0);
    }

    /**
     * @notice Returns the currently effective height for an owner.
     */
    function heightOfAddress(address _owner) public view returns (uint8) {
        Stake memory preview = _previewStake(_owner, false);
        return _isInitialized(preview) ? preview.height : 0;
    }

    /**
     * @notice Returns the effective stake that would be active after the given round lookahead.
     */
    function nodeEffectiveStakeLookahead(address _owner, uint64 _lookahead) public view returns (uint256) {
        if (!_addressNotFrozenLookahead(_owner, _lookahead)) return 0;

        Stake memory preview = _previewStakeLookahead(_owner, _lookahead);
        return _isInitialized(preview) ? preview.balance : 0;
    }

    /**
     * @notice Returns the overlay that would be active after the given round lookahead.
     */
    function overlayOfAddressLookahead(address _owner, uint64 _lookahead) public view returns (bytes32) {
        Stake memory preview = _previewStakeLookahead(_owner, _lookahead);
        return _isInitialized(preview) ? preview.overlay : bytes32(0);
    }

    /**
     * @notice Returns the height that would be active after the given round lookahead.
     */
    function heightOfAddressLookahead(address _owner, uint64 _lookahead) public view returns (uint8) {
        Stake memory preview = _previewStakeLookahead(_owner, _lookahead);
        return _isInitialized(preview) ? preview.height : 0;
    }

    /**
     * @notice Returns the current staking round derived from block height.
     */
    function currentRound() public view returns (uint64) {
        return uint64(block.number / ROUND_LENGTH);
    }

    /**
     * @notice Returns true when the owner is not currently frozen.
     */
    function addressNotFrozen(address _owner) internal view returns (bool) {
        return !_isInitialized(_owner) || _stakes[_owner].frozenUntilBlock < block.number;
    }

    /**
     * @notice Applies all queued updates that are effective in the current round.
     * @dev Stops at the first frozen withdrawal/exit without reverting.
     */
    function _applyReadyUpdates(address _owner) internal {
        ScheduledUpdate[] storage queue = _updateQueues[_owner];
        uint256 head = _queueHeads[_owner];
        uint64 roundNumber = currentRound();

        while (head < queue.length && queue[head].effectiveFromRound <= roundNumber) {
            if (_blocksQueuedWithdrawalExecution(_owner, queue[head].kind)) break;
            _applyStoredUpdate(_owner, queue[head]);
            delete queue[head];
            unchecked {
                ++head;
            }
        }

        if (head == queue.length) {
            delete _updateQueues[_owner];
            delete _queueHeads[_owner];
            delete _queueClosed[_owner];
        } else {
            _queueHeads[_owner] = head;
        }
    }

    /**
     * @notice Applies a single queued update to storage.
     */
    function _applyStoredUpdate(address _owner, ScheduledUpdate storage scheduled) internal {
        Stake storage stake = _stakes[_owner];

        if (scheduled.kind == UpdateKind.CreateDeposit) {
            stake.overlay = _deriveOverlay(_owner, scheduled.nonce);
            stake.balance = scheduled.amount;
            stake.height = scheduled.height;
            return;
        }

        if (scheduled.kind == UpdateKind.AddTokens) {
            stake.balance += scheduled.amount;
            return;
        }

        if (scheduled.kind == UpdateKind.IncreaseHeight) {
            if (_isInitialized(_owner) && scheduled.height > stake.height) {
                stake.height = scheduled.height;
            }
            return;
        }

        if (scheduled.kind == UpdateKind.ChangeOverlay) {
            if (_isInitialized(_owner)) {
                stake.overlay = _deriveOverlay(_owner, scheduled.nonce);
            }
            return;
        }

        if (scheduled.kind == UpdateKind.WithdrawTokens) {
            if (_isInitialized(_owner)) {
                if (scheduled.amount >= stake.balance) {
                    stake.balance = 0;
                } else {
                    stake.balance -= scheduled.amount;
                }

                if (!ERC20(bzzToken).transfer(_owner, scheduled.amount)) revert TransferFailed();
            }
            return;
        }

        if (scheduled.kind == UpdateKind.ExitStake) {
            uint256 balance = stake.balance;
            delete _stakes[_owner];
            if (balance > 0 && !ERC20(bzzToken).transfer(_owner, balance)) revert TransferFailed();
        }
    }

    /**
     * @notice Returns true when a queued withdrawal or exit must stay pending for the current round.
     * @dev Current-round participation does not block execution once the withdrawal or exit is effective.
     */
    function _blocksQueuedWithdrawalExecution(address _owner, UpdateKind _kind) internal view returns (bool) {
        if (_kind != UpdateKind.WithdrawTokens && _kind != UpdateKind.ExitStake) {
            return false;
        }

        return !addressNotFrozen(_owner);
    }

    /**
     * @notice Returns true when a queued withdrawal or exit would still be blocked after the given round lookahead.
     * @dev Lookahead previews only defer execution while the node remains frozen.
     */
    function _blocksQueuedWithdrawalExecutionLookahead(address _owner, UpdateKind _kind, uint64 _lookahead)
        internal
        view
        returns (bool)
    {
        if (_kind != UpdateKind.WithdrawTokens && _kind != UpdateKind.ExitStake) {
            return false;
        }

        return !_addressNotFrozenLookahead(_owner, _lookahead);
    }

    /**
     * @notice Previews stake state using the current round, optionally including future queued updates.
     */
    function _previewStake(address _owner, bool includeFutureUpdates) internal view returns (Stake memory preview) {
        preview = _stakes[_owner];

        ScheduledUpdate[] storage queue = _updateQueues[_owner];
        uint256 head = _queueHeads[_owner];
        uint64 roundNumber = currentRound();

        for (uint256 i = head; i < queue.length;) {
            ScheduledUpdate storage scheduled = queue[i];
            if (!includeFutureUpdates && scheduled.effectiveFromRound > roundNumber) {
                break;
            }
            if (!includeFutureUpdates && _blocksQueuedWithdrawalExecution(_owner, scheduled.kind)) {
                break;
            }

            preview = _applyPreviewUpdate(_owner, preview, scheduled);

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Previews stake state as it would look after the given round lookahead.
     */
    function _previewStakeLookahead(address _owner, uint64 _lookahead) internal view returns (Stake memory preview) {
        preview = _stakes[_owner];

        ScheduledUpdate[] storage queue = _updateQueues[_owner];
        uint256 head = _queueHeads[_owner];
        uint64 targetRound = currentRound() + _lookahead;

        for (uint256 i = head; i < queue.length;) {
            ScheduledUpdate storage scheduled = queue[i];
            if (scheduled.effectiveFromRound > targetRound) {
                break;
            }
            if (_blocksQueuedWithdrawalExecutionLookahead(_owner, scheduled.kind, _lookahead)) {
                break;
            }

            preview = _applyPreviewUpdate(_owner, preview, scheduled);

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Applies a single queued update to an in-memory preview state.
     */
    function _applyPreviewUpdate(address _owner, Stake memory preview, ScheduledUpdate storage scheduled)
        internal
        view
        returns (Stake memory)
    {
        if (scheduled.kind == UpdateKind.CreateDeposit) {
            preview.overlay = _deriveOverlay(_owner, scheduled.nonce);
            preview.balance = scheduled.amount;
            preview.height = scheduled.height;
            return preview;
        }

        if (scheduled.kind == UpdateKind.AddTokens) {
            preview.balance += scheduled.amount;
            return preview;
        }

        if (scheduled.kind == UpdateKind.IncreaseHeight) {
            if (_isInitialized(preview) && scheduled.height > preview.height) {
                preview.height = scheduled.height;
            }
            return preview;
        }

        if (scheduled.kind == UpdateKind.ChangeOverlay) {
            if (_isInitialized(preview)) {
                preview.overlay = _deriveOverlay(_owner, scheduled.nonce);
            }
            return preview;
        }

        if (scheduled.kind == UpdateKind.WithdrawTokens) {
            if (_isInitialized(preview)) {
                if (scheduled.amount >= preview.balance) {
                    preview.balance = 0;
                } else {
                    preview.balance -= scheduled.amount;
                }
            }
            return preview;
        }

        if (scheduled.kind == UpdateKind.ExitStake) {
            delete preview;
        }

        return preview;
    }

    /**
     * @notice Appends a new queued update and assigns the first valid effective round.
     */
    function _enqueueUpdate(
        address _owner,
        UpdateKind _kind,
        uint64 _minimumWait,
        bytes32 _nonce,
        uint256 _amount,
        uint8 _height
    ) internal returns (uint64 effectiveFromRound) {
        if (_queueLength(_owner) >= UPDATE_QUEUE_MAX_LENGTH) revert UpdateQueueFull();

        uint64 candidateRound = currentRound() + _minimumWait;
        uint64 lastRound = _lastScheduledRound(_owner);
        effectiveFromRound = candidateRound > lastRound ? candidateRound : lastRound;

        _updateQueues[_owner].push(
            ScheduledUpdate({
                kind: _kind, effectiveFromRound: effectiveFromRound, nonce: _nonce, amount: _amount, height: _height
            })
        );
    }

    /**
     * @notice Returns the effective round of the last queued update.
     */
    function _lastScheduledRound(address _owner) internal view returns (uint64) {
        ScheduledUpdate[] storage queue = _updateQueues[_owner];
        if (_queueHeads[_owner] == queue.length) {
            return 0;
        }
        return queue[queue.length - 1].effectiveFromRound;
    }

    /**
     * @notice Returns the number of pending queued updates.
     */
    function _queueLength(address _owner) internal view returns (uint256) {
        return _updateQueues[_owner].length - _queueHeads[_owner];
    }

    /**
     * @notice Returns true when the owner would be unfrozen after the given round lookahead.
     */
    function _addressNotFrozenLookahead(address _owner, uint64 _lookahead) internal view returns (bool) {
        if (!_isInitialized(_owner)) {
            return true;
        }

        if (_lookahead == 0) {
            return _stakes[_owner].frozenUntilBlock < block.number;
        }

        return _stakes[_owner].frozenUntilBlock < uint256(currentRound() + _lookahead) * ROUND_LENGTH;
    }

    /**
     * @notice Shrinks queued withdrawals when slashing leaves less balance than they expect.
     * @dev This preserves queue order while preventing later withdrawals from overpaying the owner.
     */
    function _reconcileQueuedWithdrawals(address _owner) internal {
        ScheduledUpdate[] storage queue = _updateQueues[_owner];
        uint256 head = _queueHeads[_owner];
        Stake memory preview = _stakes[_owner];

        for (uint256 i = head; i < queue.length;) {
            ScheduledUpdate storage scheduled = queue[i];

            if (scheduled.kind == UpdateKind.CreateDeposit) {
                preview.overlay = _deriveOverlay(_owner, scheduled.nonce);
                preview.balance = scheduled.amount;
                preview.height = scheduled.height;
            } else if (scheduled.kind == UpdateKind.AddTokens) {
                preview.balance += scheduled.amount;
            } else if (scheduled.kind == UpdateKind.IncreaseHeight) {
                if (_isInitialized(preview) && scheduled.height > preview.height) {
                    preview.height = scheduled.height;
                }
            } else if (scheduled.kind == UpdateKind.ChangeOverlay) {
                if (_isInitialized(preview)) {
                    preview.overlay = _deriveOverlay(_owner, scheduled.nonce);
                }
            } else if (scheduled.kind == UpdateKind.WithdrawTokens) {
                if (_isInitialized(preview)) {
                    if (scheduled.amount > preview.balance) {
                        scheduled.amount = preview.balance;
                    }

                    preview.balance -= scheduled.amount;
                }
            } else if (scheduled.kind == UpdateKind.ExitStake) {
                delete preview;
            }

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Pulls BZZ into the staking contract.
     */
    function _pullTokens(address _owner, uint256 _amount) internal {
        if (_amount == 0) revert InvalidWithdrawalAmount();
        if (!ERC20(bzzToken).transferFrom(_owner, address(this), _amount)) revert TransferFailed();
    }

    /**
     * @notice Returns the minimum stake required for a given height.
     */
    function _minimumStakeForHeight(uint8 _height) internal pure returns (uint256) {
        return MIN_STAKE * (2 ** _height);
    }

    /**
     * @notice Derives an overlay from owner, network id and nonce.
     */
    function _deriveOverlay(address _owner, bytes32 _setNonce) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(_owner, reverse(NetworkId), _setNonce));
    }

    /**
     * @notice Returns true when the stored stake for an owner is initialized.
     */
    function _isInitialized(address _owner) internal view returns (bool) {
        return _stakes[_owner].overlay != bytes32(0);
    }

    /**
     * @notice Returns true when an in-memory stake state is initialized.
     */
    function _isInitialized(Stake memory _stake) internal pure returns (bool) {
        return _stake.overlay != bytes32(0);
    }

    /**
     * @notice Reverses byte order for network id encoding in overlay derivation.
     */
    function reverse(uint64 input) internal pure returns (uint64 v) {
        v = input;

        v = ((v & 0xFF00FF00FF00FF00) >> 8) | ((v & 0x00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000) >> 16) | ((v & 0x0000FFFF0000FFFF) << 16);
        v = (v >> 32) | (v << 32);
    }
}
