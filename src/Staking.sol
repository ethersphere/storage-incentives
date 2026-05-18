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
 * @dev Freeze penalties are stored per account (`freezeUntilBlock`); they are not cleared by exit,
 * migration, or stake deletion. A new deposit after exit still cannot participate until the freeze ends.
 */

contract StakeRegistry is AccessControl, Pausable {
    // ----------------------------- State variables ------------------------------

    uint256 public constant ROUND_LENGTH = 152;
    /// @notice Minimum BZZ base unit at staking height 0 (`MIN_STAKE * 2**height` for higher heights).
    uint256 public constant MIN_STAKE = 100000000000000000;
    uint256 public constant UPDATE_QUEUE_MAX_LENGTH = 10;
    /// @notice Maximum staking height; prevents `2**height` overflow in `MIN_STAKE * (2 ** height)`.
    uint8 public constant MAX_STAKING_HEIGHT = 128;

    // ----------------------------- Type declarations ------------------------------

    enum UpdateKind {
        CreateDeposit,
        AddTokens,
        IncreaseHeight,
        ChangeOverlay,
        WithdrawTokens,
        ExitStake
    }

    /// @dev Why `withdraw` was rejected before anything was queued.
    enum WithdrawalAmountIssue {
        /// Amount is zero; `withdraw` only accepts positive pulls (see `exit()` for full unwind).
        Zero,
        /// Amount is greater than the previewed stake balance.
        ExceedsBalance
    }

    /// @dev Committed stake is indicated by `overlay != bytes32(0)` (see `_hasCommittedStake`).
    struct Stake {
        bytes32 overlay;
        uint256 balance;
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
    /// @notice End block of the protocol freeze for this account (exclusive: unfrozen when `block.number` > this value). Persists across exit and migration.
    mapping(address => uint256) public freezeUntilBlock;
    mapping(address => ScheduledUpdate[]) private _updateQueues;
    mapping(address => uint256) private _queueHeads;
    mapping(address => bool) private _queueClosed;

    bytes32 public constant REDISTRIBUTOR_ROLE = keccak256("REDISTRIBUTOR_ROLE");

    uint64 public networkId;
    address public immutable bzzToken;
    uint64 public immutable WAIT_BASE;
    uint64 public immutable WAIT_OVERLAY_CHANGE;
    uint64 public immutable WAIT_WITHDRAWAL;

    // ----------------------------- Events ------------------------------

    event DepositCreated(
        address indexed owner,
        uint64 registeredFromRound,
        uint256 amount,
        bytes32 overlay,
        uint8 height
    );
    event TokensAdded(address indexed owner, uint64 registeredFromRound, uint256 amount);
    event OverlayChanged(address indexed owner, uint64 registeredFromRound, bytes32 overlay);
    event HeightIncreased(address indexed owner, uint64 registeredFromRound, uint8 height);
    /// @notice A partial or full withdrawal was scheduled; tokens move only when the item is applied.
    event WithdrawalQueued(address indexed owner, uint64 effectiveFromRound, uint256 amount);
    /// @notice BZZ was transferred to `owner` when a queued withdrawal or exit was applied (`executedInRound` is the round at execution).
    event Withdrawal(address indexed owner, uint64 executedInRound, uint256 amount);
    event StakeSlashed(address indexed owner, bytes32 overlay, uint256 amount);
    event StakeFrozen(address indexed frozen, bytes32 indexed overlay, uint256 durationBlocks);
    /// @notice Account-level freeze recorded when there is no stake/queue (overlay zero in `StakeFrozen`).
    event AccountFreezeExtended(address indexed account, uint256 freezeUntilBlock);
    event StakeMigrated(address indexed owner, uint256 totalReturned);

    // ----------------------------- Errors ------------------------------

    /// @notice ERC20 `transfer` / `transferFrom` returned false for `bzzToken`.
    error TransferFailed();
    /// @notice Caller lacks `REDISTRIBUTOR_ROLE` (`freezeDeposit`, `slashDeposit`).
    error OnlyRedistributor();
    /// @notice Stake amount `have` is below protocol minimum `need` for the operation (deposit, height, or post-withdraw remainder).
    error BelowMinimumStake(uint256 have, uint256 need);
    /// @notice No active stake (or preview balance zero) for this action.
    error NotStaked();
    /// @notice Address already has stake or a pending deposit that establishes one.
    error AlreadyStaked();
    /// @notice `increaseHeight` cannot lower staking height.
    error HeightDecreaseNotAllowed();
    /// @notice Pulled token amount must be non-zero (`createDeposit`, `addTokens`).
    error InvalidAmount();
    /// @notice `withdraw` rejected before enqueueing; see `WithdrawalAmountIssue`. For a remainder below minimum (including withdrawing the entire balance here), see `BelowMinimumStake`; use `exit()` for a scheduled full unwind.
    error InvalidWithdrawalAmount(WithdrawalAmountIssue reason);
    /// @notice Update queue has `queuedCount` pending items; cannot exceed `limit`.
    error UpdateQueueFull(uint256 queuedCount, uint256 limit);
    /// @notice An exit is scheduled; no further mutations allowed until processed or migrated.
    error QueueClosed();
    /// @notice Thrown only by `applyUpdates`: head queue item is due `WithdrawTokens`/`ExitStake` but frozen.
    /// @dev Full tx revert; see `applyUpdates` NatSpec — no checkpointed partial progress from that call.
    error FrozenWithdrawal();
    /// @notice Overlay or withdrawal wait rounds must be at least `waitBase` (`waitOverlayChange` / `waitWithdrawal` were below).
    error InvalidWaitConfiguration(uint64 waitBase, uint64 waitOverlayChange, uint64 waitWithdrawal);
    /// @notice `height` exceeds `MAX_STAKING_HEIGHT` (stake math would overflow).
    error StakingHeightTooLarge(uint8 height, uint8 maxHeight);
    /// @notice `changeOverlay` was called with a nonce that produces the current overlay.
    error OverlayUnchanged();

    constructor(
        address _bzzToken,
        uint64 _networkId,
        uint64 _waitBase,
        uint64 _waitOverlayChange,
        uint64 _waitWithdrawal
    ) {
        if (_waitOverlayChange < _waitBase || _waitWithdrawal < _waitBase) {
            revert InvalidWaitConfiguration(_waitBase, _waitOverlayChange, _waitWithdrawal);
        }
        networkId = _networkId;
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
     * @return effectiveFromRound Round when the queued update becomes effective (matches event).
     */
    function createDeposit(
        bytes32 _setNonce,
        uint256 _amount,
        uint8 _height
    ) external whenNotPaused returns (uint64 effectiveFromRound) {
        if (_queueClosed[msg.sender]) revert QueueClosed();
        Stake memory plannedStake = _previewStake(msg.sender, true);
        if (_hasCommittedStake(plannedStake) && plannedStake.balance > 0) revert AlreadyStaked();
        uint256 minStake = _minimumStakeForHeight(_height);
        if (_amount < minStake) revert BelowMinimumStake(_amount, minStake);

        bytes32 newOverlay = _deriveOverlay(msg.sender, _setNonce);
        _pullTokens(_amount);

        effectiveFromRound = _enqueueUpdate(
            msg.sender,
            UpdateKind.CreateDeposit,
            WAIT_BASE,
            _setNonce,
            _amount,
            _height
        );

        emit DepositCreated(msg.sender, effectiveFromRound, _amount, newOverlay, _height);
    }

    /**
     * @notice Schedules an increase of the caller's stake balance.
     * @param _amount The amount of BZZ to add to the stake.
     * @return effectiveFromRound Round when the queued update becomes effective (matches event).
     */
    function addTokens(uint256 _amount) external whenNotPaused returns (uint64 effectiveFromRound) {
        if (_queueClosed[msg.sender]) revert QueueClosed();
        Stake memory plannedStake = _previewStake(msg.sender, true);
        if (!_hasCommittedStake(plannedStake) || plannedStake.balance == 0) revert NotStaked();

        _pullTokens(_amount);
        effectiveFromRound = _enqueueUpdate(msg.sender, UpdateKind.AddTokens, WAIT_BASE, 0, _amount, 0);

        emit TokensAdded(msg.sender, effectiveFromRound, _amount);
    }

    /**
     * @notice Schedules an overlay change after the configured overlay delay.
     * @param _setNonce The nonce used to derive the new overlay.
     * @return effectiveFromRound Round when the queued update becomes effective (matches `OverlayChanged`).
     * @dev Reverts with `OverlayUnchanged` if the derived overlay equals the current one (no sentinel return value).
     */
    function changeOverlay(bytes32 _setNonce) external whenNotPaused returns (uint64 effectiveFromRound) {
        if (_queueClosed[msg.sender]) revert QueueClosed();
        Stake memory plannedStake = _previewStake(msg.sender, true);
        if (!_hasCommittedStake(plannedStake) || plannedStake.balance == 0) revert NotStaked();

        bytes32 newOverlay = _deriveOverlay(msg.sender, _setNonce);
        if (newOverlay == plannedStake.overlay) revert OverlayUnchanged();

        effectiveFromRound = _enqueueUpdate(msg.sender, UpdateKind.ChangeOverlay, WAIT_OVERLAY_CHANGE, _setNonce, 0, 0);

        emit OverlayChanged(msg.sender, effectiveFromRound, newOverlay);
    }

    /**
     * @notice Schedules a height increase once the base delay elapses.
     * @param _height The new staking height.
     * @return effectiveFromRound Round when the queued update becomes effective (matches event); 0 if unchanged.
     */
    function increaseHeight(uint8 _height) external whenNotPaused returns (uint64 effectiveFromRound) {
        if (_queueClosed[msg.sender]) revert QueueClosed();
        Stake memory plannedStake = _previewStake(msg.sender, true);
        if (!_hasCommittedStake(plannedStake) || plannedStake.balance == 0) revert NotStaked();
        if (_height < plannedStake.height) revert HeightDecreaseNotAllowed();
        if (_height == plannedStake.height) return 0;
        uint256 minForHeight = _minimumStakeForHeight(_height);
        if (plannedStake.balance < minForHeight) revert BelowMinimumStake(plannedStake.balance, minForHeight);

        effectiveFromRound = _enqueueUpdate(msg.sender, UpdateKind.IncreaseHeight, WAIT_BASE, 0, 0, _height);
        emit HeightIncreased(msg.sender, effectiveFromRound, _height);
    }

    /**
     * @notice Schedules a partial withdrawal after the withdrawal delay.
     * @param _amount The amount of BZZ to withdraw from the stake.
     * @dev A full unwind must use `exit()`, not `withdraw(balance)`. Overdrawing reverts with `ExceedsBalance`; leaving a remainder below the height minimum reverts with `BelowMinimumStake`. Effective round stacking follows `_enqueueUpdate` (FIFO vs delay rounds).
     * @return effectiveFromRound Round when the queued update becomes effective (matches `WithdrawalQueued`).
     */
    function withdraw(uint256 _amount) external whenNotPaused returns (uint64 effectiveFromRound) {
        if (_amount == 0) revert InvalidWithdrawalAmount(WithdrawalAmountIssue.Zero);
        if (_queueClosed[msg.sender]) revert QueueClosed();

        Stake memory plannedStake = _previewStake(msg.sender, true);
        if (!_hasCommittedStake(plannedStake) || plannedStake.balance == 0) revert NotStaked();
        if (_amount > plannedStake.balance) {
            revert InvalidWithdrawalAmount(WithdrawalAmountIssue.ExceedsBalance);
        }
        uint256 minAfterWithdraw = _minimumStakeForHeight(plannedStake.height);
        uint256 balanceAfter = plannedStake.balance - _amount;
        if (balanceAfter < minAfterWithdraw) revert BelowMinimumStake(balanceAfter, minAfterWithdraw);

        effectiveFromRound = _enqueueUpdate(msg.sender, UpdateKind.WithdrawTokens, WAIT_WITHDRAWAL, 0, _amount, 0);
        emit WithdrawalQueued(msg.sender, effectiveFromRound, _amount);
    }

    /**
     * @notice Schedules a full exit after the withdrawal delay.
     * @dev Uses the same effective-round stacking as `withdraw()`; see `_enqueueUpdate`.
     * @return effectiveFromRound Round when the queued update becomes effective (matches `WithdrawalQueued`).
     */
    function exit() external whenNotPaused returns (uint64 effectiveFromRound) {
        if (_queueClosed[msg.sender]) revert QueueClosed();
        Stake memory plannedStake = _previewStake(msg.sender, true);
        if (!_hasCommittedStake(plannedStake) || plannedStake.balance == 0) revert NotStaked();

        effectiveFromRound = _enqueueUpdate(msg.sender, UpdateKind.ExitStake, WAIT_WITHDRAWAL, 0, 0, 0);
        _queueClosed[msg.sender] = true;
        emit WithdrawalQueued(msg.sender, effectiveFromRound, plannedStake.balance);
    }

    /**
     * @notice Applies all updates that are ready for the given owner.
     * @param _owner The address whose queue should be processed.
     * @dev Integrators / bots / backends: `_applyReadyUpdates` runs first. If the next pending item at `head`
     *      is a due withdrawal or exit and execution is blocked by freeze, this function reverts with
     *      `FrozenWithdrawal()` — the **entire transaction** reverts, so no partial state from this call persists.
     *      When that happens (e.g. user frozen with a matured withdrawal queued), callers may retry after
     *      unfreeze, or advance the queue indirectly via functions that invoke `_applyReadyUpdates` internally
     *      under different rules (`freezeDeposit`, `slashDeposit`, `migrateStake` when paused).
     */
    function applyUpdates(address _owner) public {
        _applyReadyUpdates(_owner);
        ScheduledUpdate[] storage queue = _updateQueues[_owner];
        uint256 head = _queueHeads[_owner];
        if (
            head < queue.length &&
            queue[head].effectiveFromRound <= currentRound() &&
            _queuedWithdrawalExecutionFrozen(_owner, queue[head].kind, 0)
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

        for (uint256 i = head; i < queue.length; ) {
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

        emit StakeMigrated(msg.sender, payout);

        if (payout > 0) {
            if (!ERC20(bzzToken).transfer(msg.sender, payout)) revert TransferFailed();
        }
    }

    /**
     * @notice Extends the account freeze and blocks queued withdrawals while the freeze lasts.
     * @param _owner The staker to freeze.
     * @param _time The freeze duration in blocks from `block.number`.
     * @dev If an existing freeze ends later than `block.number + _time`, it is kept (monotonic). The
     * deadline is stored per account and survives exit, `migrateStake`, and stake deletion.
     */
    function freezeDeposit(address _owner, uint256 _time) external whenNotPaused {
        if (!hasRole(REDISTRIBUTOR_ROLE, msg.sender)) revert OnlyRedistributor();

        uint256 until = block.number + _time;

        // No stake and no queue: only record account-level penalty.
        if (!_hasCommittedStake(_owner) && _queueLength(_owner) == 0) {
            if (freezeUntilBlock[_owner] < until) {
                freezeUntilBlock[_owner] = until;
                emit AccountFreezeExtended(_owner, freezeUntilBlock[_owner]);
            }
            return;
        }

        // Apply updates that were already due under the *previous* freeze window first, so a mature
        // withdrawal in the same transaction is not blocked by the new penalty start.
        _applyReadyUpdates(_owner);

        if (freezeUntilBlock[_owner] < until) {
            freezeUntilBlock[_owner] = until;
        }

        if (_hasCommittedStake(_owner)) {
            emit StakeFrozen(_owner, _stakes[_owner].overlay, _time);
        }
    }

    /**
     * @notice Slashes the active stake and reconciles queued withdrawals if needed.
     * @param _owner The staker to slash.
     * @param _amount The amount to slash from the active stake.
     */
    function slashDeposit(address _owner, uint256 _amount) external whenNotPaused {
        if (!hasRole(REDISTRIBUTOR_ROLE, msg.sender)) revert OnlyRedistributor();
        if (_amount == 0) revert InvalidAmount();

        _applyReadyUpdates(_owner);

        Stake storage stake = _stakes[_owner];
        bytes32 previousOverlay = stake.overlay;

        if (previousOverlay != bytes32(0)) {
            if (stake.balance > _amount) {
                stake.balance -= _amount;
                _reconcileQueuedWithdrawals(_owner);
                _syncHeightToBalance(stake);
            } else if (_queueLength(_owner) > 0) {
                stake.balance = 0;
                _reconcileQueuedWithdrawals(_owner);
            } else {
                delete _stakes[_owner];
            }
        }

        if (previousOverlay != bytes32(0)) {
            emit StakeSlashed(_owner, previousOverlay, _amount);
        }
    }

    /**
     * @notice Updates the Swarm network identifier used in overlay derivation.
     * @param _networkId The new network id.
     */
    function changeNetworkId(uint64 _networkId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        networkId = _networkId;
    }

    /**
     * @notice Pauses staking mutations.
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses staking mutations.
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
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
        if (!_addressNotFrozen(_owner)) return 0;

        Stake memory preview = _previewStake(_owner, false);
        return _hasCommittedStake(preview) ? preview.balance : 0;
    }

    /**
     * @notice Returns the currently effective overlay for an owner.
     */
    function overlayOfAddress(address _owner) public view returns (bytes32) {
        Stake memory preview = _previewStake(_owner, false);
        return _hasCommittedStake(preview) ? preview.overlay : bytes32(0);
    }

    /**
     * @notice Returns the currently effective height for an owner.
     */
    function heightOfAddress(address _owner) public view returns (uint8) {
        Stake memory preview = _previewStake(_owner, false);
        return _hasCommittedStake(preview) ? preview.height : 0;
    }

    /**
     * @notice Returns the effective stake that would be active after the given round lookahead.
     */
    function nodeEffectiveStakeLookahead(address _owner, uint64 _lookahead) public view returns (uint256) {
        if (!_addressNotFrozenLookahead(_owner, _lookahead)) return 0;

        Stake memory preview = _previewStakeLookahead(_owner, _lookahead);
        return _hasCommittedStake(preview) ? preview.balance : 0;
    }

    /**
     * @notice Returns the overlay that would be active after the given round lookahead.
     */
    function overlayOfAddressLookahead(address _owner, uint64 _lookahead) public view returns (bytes32) {
        Stake memory preview = _previewStakeLookahead(_owner, _lookahead);
        return _hasCommittedStake(preview) ? preview.overlay : bytes32(0);
    }

    /**
     * @notice Returns the height that would be active after the given round lookahead.
     */
    function heightOfAddressLookahead(address _owner, uint64 _lookahead) public view returns (uint8) {
        Stake memory preview = _previewStakeLookahead(_owner, _lookahead);
        return _hasCommittedStake(preview) ? preview.height : 0;
    }

    /**
     * @notice Returns the current staking round derived from block height.
     */
    function currentRound() public view returns (uint64) {
        return uint64(block.number / ROUND_LENGTH);
    }

    /**
     * @dev True when `freezeUntilBlock[_owner] < block.number` (current block is past the penalty window).
     */
    function _addressNotFrozen(address _owner) internal view returns (bool) {
        return freezeUntilBlock[_owner] < block.number;
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
            if (_queuedWithdrawalExecutionFrozen(_owner, queue[head].kind, 0)) break;
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
        if (scheduled.kind == UpdateKind.WithdrawTokens) {
            Stake storage stake = _stakes[_owner];
            if (stake.overlay != bytes32(0)) {
                uint256 paid = scheduled.amount > stake.balance ? stake.balance : scheduled.amount;
                stake.balance -= paid;
                if (paid > 0) {
                    if (!ERC20(bzzToken).transfer(_owner, paid)) revert TransferFailed();
                    emit Withdrawal(_owner, currentRound(), paid);
                }
            }
            return;
        }

        if (scheduled.kind == UpdateKind.ExitStake) {
            Stake storage stakeRef = _stakes[_owner];
            uint256 balance = stakeRef.balance;
            delete _stakes[_owner];
            if (balance > 0) {
                if (!ERC20(bzzToken).transfer(_owner, balance)) revert TransferFailed();
                emit Withdrawal(_owner, currentRound(), balance);
            }
            return;
        }

        Stake storage stRef = _stakes[_owner];
        Stake memory s = Stake({overlay: stRef.overlay, balance: stRef.balance, height: stRef.height});
        s = _applyPreviewUpdate(_owner, s, scheduled);
        stRef.overlay = s.overlay;
        stRef.balance = s.balance;
        stRef.height = s.height;
    }

    /**
     * @dev Whether a due withdrawal/exit is blocked by freeze when evaluating unfrozen state at `_lookaheadRounds`:
     *      `_lookaheadRounds == 0` uses `_addressNotFrozen` (strict `block.number`). `_lookaheadRounds > 0`
     *      uses the first block of round `currentRound() + _lookaheadRounds`. Those bases differ, so
     *      behavior is not a simple extension of the `_lookaheadRounds == 0` case at round boundaries.
     */
    function _queuedWithdrawalExecutionFrozen(
        address _owner,
        UpdateKind _kind,
        uint64 _lookaheadRounds
    ) internal view returns (bool) {
        if (_kind != UpdateKind.WithdrawTokens && _kind != UpdateKind.ExitStake) {
            return false;
        }
        return !_addressNotFrozenLookahead(_owner, _lookaheadRounds);
    }

    /**
     * @notice Previews stake state using the current round, optionally including future queued updates.
     */
    function _previewStake(address _owner, bool includeFutureUpdates) internal view returns (Stake memory preview) {
        preview = _stakes[_owner];

        ScheduledUpdate[] storage queue = _updateQueues[_owner];
        uint256 head = _queueHeads[_owner];
        uint64 roundNumber = currentRound();

        for (uint256 i = head; i < queue.length; ) {
            ScheduledUpdate storage scheduled = queue[i];
            if (!includeFutureUpdates && scheduled.effectiveFromRound > roundNumber) {
                break;
            }
            if (!includeFutureUpdates && _queuedWithdrawalExecutionFrozen(_owner, scheduled.kind, 0)) {
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

        for (uint256 i = head; i < queue.length; ) {
            ScheduledUpdate storage scheduled = queue[i];
            if (scheduled.effectiveFromRound > targetRound) {
                break;
            }
            if (_queuedWithdrawalExecutionFrozen(_owner, scheduled.kind, _lookahead)) {
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
     * @dev Must match non-transfer semantics applied in `_applyStoredUpdate` for the same `kind` (excluding token transfers).
     */
    function _applyPreviewUpdate(
        address _owner,
        Stake memory preview,
        ScheduledUpdate storage scheduled
    ) internal view returns (Stake memory) {
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
            if (_hasCommittedStake(preview) && scheduled.height > preview.height) {
                preview.height = scheduled.height;
            }
            return preview;
        }

        if (scheduled.kind == UpdateKind.ChangeOverlay) {
            if (_hasCommittedStake(preview)) {
                preview.overlay = _deriveOverlay(_owner, scheduled.nonce);
            }
            return preview;
        }

        if (scheduled.kind == UpdateKind.WithdrawTokens) {
            if (_hasCommittedStake(preview)) {
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
     * @dev `effectiveFromRound` is `max(currentRound() + _minimumWait, lastQueuedRound)` so FIFO is preserved when waits differ; a withdrawal/exit may become effective later than `_minimumWait` rounds after prior queue items.
     */
    function _enqueueUpdate(
        address _owner,
        UpdateKind _kind,
        uint64 _minimumWait,
        bytes32 _nonce,
        uint256 _amount,
        uint8 _height
    ) internal returns (uint64 effectiveFromRound) {
        uint256 queued = _queueLength(_owner);
        if (queued >= UPDATE_QUEUE_MAX_LENGTH) revert UpdateQueueFull(queued, UPDATE_QUEUE_MAX_LENGTH);

        uint64 candidateRound = currentRound() + _minimumWait;
        uint64 lastRound = _lastScheduledRound(_owner);
        effectiveFromRound = candidateRound > lastRound ? candidateRound : lastRound;

        _updateQueues[_owner].push(
            ScheduledUpdate({
                kind: _kind,
                effectiveFromRound: effectiveFromRound,
                nonce: _nonce,
                amount: _amount,
                height: _height
            })
        );
    }

    /**
     * @notice Returns the effective round of the last queued update.
     */
    function _lastScheduledRound(address _owner) internal view returns (uint64) {
        ScheduledUpdate[] storage queue = _updateQueues[_owner];
        if (_queueLength(_owner) == 0) {
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
     * @notice True if `freezeUntilBlock` is strictly before the reference block for this lookahead.
     * @dev `_lookaheadRounds == 0`: reference is current `block.number` (same as `_addressNotFrozen`).
     *      `_lookaheadRounds > 0`: reference is the first block of staking round `currentRound() + _lookaheadRounds`
     *      (not `block.number + _lookaheadRounds * ROUND_LENGTH`), so preview semantics are round-anchored.
     */
    function _addressNotFrozenLookahead(address _owner, uint64 _lookaheadRounds) internal view returns (bool) {
        if (_lookaheadRounds == 0) {
            return _addressNotFrozen(_owner);
        }

        return freezeUntilBlock[_owner] < (uint256(currentRound()) + uint256(_lookaheadRounds)) * ROUND_LENGTH;
    }

    /**
     * @notice Shrinks queued withdrawals when slashing leaves less balance than they expect.
     * @dev This preserves queue order while preventing later withdrawals from overpaying the owner.
     */
    function _reconcileQueuedWithdrawals(address _owner) internal {
        ScheduledUpdate[] storage queue = _updateQueues[_owner];
        uint256 head = _queueHeads[_owner];
        Stake memory preview = _stakes[_owner];

        for (uint256 i = head; i < queue.length; ) {
            ScheduledUpdate storage scheduled = queue[i];

            if (scheduled.kind == UpdateKind.WithdrawTokens && _hasCommittedStake(preview)) {
                if (scheduled.amount > preview.balance) {
                    scheduled.amount = preview.balance;
                }
            }

            preview = _applyPreviewUpdate(_owner, preview, scheduled);

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Pulls BZZ from `msg.sender` into the staking contract.
     */
    function _pullTokens(uint256 _amount) internal {
        if (_amount == 0) revert InvalidAmount();
        if (!ERC20(bzzToken).transferFrom(msg.sender, address(this), _amount)) revert TransferFailed();
    }

    /**
     * @notice Lowers height so `balance` satisfies `_minimumStakeForHeight(height)` when possible.
     */
    function _syncHeightToBalance(Stake storage stake) internal {
        if (stake.overlay == bytes32(0)) return;
        uint8 h = stake.height;
        while (h > 0 && stake.balance < _minimumStakeForHeight(h)) {
            unchecked {
                h--;
            }
        }
        stake.height = h;
    }

    /**
     * @notice Returns the minimum stake required for a given height.
     */
    function _minimumStakeForHeight(uint8 _height) internal pure returns (uint256) {
        if (_height > MAX_STAKING_HEIGHT) revert StakingHeightTooLarge(_height, MAX_STAKING_HEIGHT);
        return MIN_STAKE * (2 ** _height);
    }

    /**
     * @notice Derives an overlay from owner, network id and nonce.
     */
    function _deriveOverlay(address _owner, bytes32 _setNonce) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(_owner, reverse(networkId), _setNonce));
    }

    /**
     * @notice True when the on-chain stake record is committed for `owner`.
     * @dev Commitment is indicated by `overlay != bytes32(0)`; collision with keccak256 output is negligible.
     */
    function _hasCommittedStake(address _owner) internal view returns (bool) {
        return _stakes[_owner].overlay != bytes32(0);
    }

    /// @notice Same commitment predicate for an in-memory stake (e.g. queue preview).
    function _hasCommittedStake(Stake memory _stake) internal pure returns (bool) {
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
