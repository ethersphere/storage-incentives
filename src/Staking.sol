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
    uint256 private constant ROUND_LENGTH = 152;
    uint256 private constant MIN_STAKE = 100000000000000000;
    uint256 private constant UPDATE_QUEUE_MAX_LENGTH = 10;

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
        uint256 lastUpdatedBlockNumber;
        uint256 frozenUntilBlock;
        uint8 height;
    }

    struct StakeState {
        bytes32 overlay;
        uint256 balance;
        uint256 lastUpdatedBlockNumber;
        uint256 frozenUntilBlock;
        uint8 height;
        bool initialized;
    }

    struct ScheduledUpdate {
        UpdateKind kind;
        uint64 effectiveFromRound;
        bytes32 nonce;
        uint256 amount;
        uint8 height;
    }

    mapping(address => StakeState) private _stakes;
    mapping(address => ScheduledUpdate[]) private _updateQueues;
    mapping(address => uint256) private _queueHeads;

    bytes32 public constant REDISTRIBUTOR_ROLE = keccak256("REDISTRIBUTOR_ROLE");

    uint64 public NetworkId;
    address public immutable bzzToken;
    uint64 public immutable WAIT_BASE;
    uint64 public immutable WAIT_OVERLAY_CHANGE;
    uint64 public immutable WAIT_WITHDRAWAL;

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
    event Withdrawal(address indexed owner, uint64 registeredFromRound, uint256 amount);
    event StakeSlashed(address slashed, bytes32 overlay, uint256 amount);
    event StakeFrozen(address frozen, bytes32 overlay, uint256 time);

    error TransferFailed();
    error Frozen();
    error Unauthorized();
    error OnlyRedistributor();
    error OnlyPauser();
    error BelowMinimumStake();
    error NotStaked();
    error AlreadyStaked();
    error HeightDecreaseNotAllowed();
    error InvalidWithdrawalAmount();
    error UpdateQueueFull();

    constructor(
        address _bzzToken,
        uint64 _NetworkId,
        uint64 _waitBase,
        uint64 _waitOverlayChange,
        uint64 _waitWithdrawal
    ) {
        NetworkId = _NetworkId;
        bzzToken = _bzzToken;
        WAIT_BASE = _waitBase;
        WAIT_OVERLAY_CHANGE = _waitOverlayChange;
        WAIT_WITHDRAWAL = _waitWithdrawal;
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function createDeposit(bytes32 _setNonce, uint256 _amount, uint8 _height) external whenNotPaused {
        if (!addressNotFrozen(msg.sender)) revert Frozen();

        StakeState memory plannedStake = _previewStake(msg.sender, true);
        if (plannedStake.initialized && plannedStake.balance > 0) revert AlreadyStaked();
        if (_amount < _minimumStakeForHeight(_height)) revert BelowMinimumStake();

        bytes32 newOverlay = _deriveOverlay(msg.sender, _setNonce);
        _pullTokens(msg.sender, _amount);

        uint64 effectiveFromRound = _enqueueUpdate(
            msg.sender,
            UpdateKind.CreateDeposit,
            WAIT_BASE,
            _setNonce,
            _amount,
            _height
        );

        emit DepositCreated(msg.sender, effectiveFromRound, _amount, newOverlay, _height);
    }

    function addTokens(uint256 _amount) external whenNotPaused {
        if (!addressNotFrozen(msg.sender)) revert Frozen();

        StakeState memory plannedStake = _previewStake(msg.sender, true);
        if (!plannedStake.initialized || plannedStake.balance == 0) revert NotStaked();

        _pullTokens(msg.sender, _amount);
        uint64 effectiveFromRound = _enqueueUpdate(msg.sender, UpdateKind.AddTokens, WAIT_BASE, 0, _amount, 0);

        emit TokensAdded(msg.sender, effectiveFromRound, _amount);
    }

    function changeOverlay(bytes32 _setNonce) external whenNotPaused {
        if (!addressNotFrozen(msg.sender)) revert Frozen();

        StakeState memory plannedStake = _previewStake(msg.sender, true);
        if (!plannedStake.initialized || plannedStake.balance == 0) revert NotStaked();

        bytes32 newOverlay = _deriveOverlay(msg.sender, _setNonce);
        if (newOverlay == plannedStake.overlay) return;

        uint64 effectiveFromRound = _enqueueUpdate(
            msg.sender,
            UpdateKind.ChangeOverlay,
            WAIT_OVERLAY_CHANGE,
            _setNonce,
            0,
            0
        );

        emit OverlayChanged(msg.sender, effectiveFromRound, newOverlay);
    }

    function increaseHeight(uint8 _height) external whenNotPaused {
        if (!addressNotFrozen(msg.sender)) revert Frozen();

        StakeState memory plannedStake = _previewStake(msg.sender, true);
        if (!plannedStake.initialized || plannedStake.balance == 0) revert NotStaked();
        if (_height < plannedStake.height) revert HeightDecreaseNotAllowed();
        if (_height == plannedStake.height) return;
        if (plannedStake.balance < _minimumStakeForHeight(_height)) revert BelowMinimumStake();

        uint64 effectiveFromRound = _enqueueUpdate(msg.sender, UpdateKind.IncreaseHeight, WAIT_BASE, 0, 0, _height);
        emit HeightIncreased(msg.sender, effectiveFromRound, _height);
    }

    function withdraw(uint256 _amount) external whenNotPaused {
        if (!addressNotFrozen(msg.sender)) revert Frozen();
        if (_amount == 0) revert InvalidWithdrawalAmount();

        StakeState memory plannedStake = _previewStake(msg.sender, true);
        if (!plannedStake.initialized || plannedStake.balance == 0) revert NotStaked();
        if (_amount >= plannedStake.balance) revert BelowMinimumStake();
        if (plannedStake.balance - _amount < _minimumStakeForHeight(plannedStake.height)) revert BelowMinimumStake();

        uint64 effectiveFromRound = _enqueueUpdate(
            msg.sender,
            UpdateKind.WithdrawTokens,
            WAIT_WITHDRAWAL,
            0,
            _amount,
            0
        );
        emit Withdrawal(msg.sender, effectiveFromRound, _amount);
    }

    function exit() external whenNotPaused {
        if (!addressNotFrozen(msg.sender)) revert Frozen();

        StakeState memory plannedStake = _previewStake(msg.sender, true);
        if (!plannedStake.initialized || plannedStake.balance == 0) revert NotStaked();

        uint64 effectiveFromRound = _enqueueUpdate(msg.sender, UpdateKind.ExitStake, WAIT_WITHDRAWAL, 0, 0, 0);
        emit Withdrawal(msg.sender, effectiveFromRound, plannedStake.balance);
    }

    function applyUpdates(address _owner) public {
        _applyReadyUpdates(_owner);
    }

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

        if (payout > 0) {
            if (!ERC20(bzzToken).transfer(msg.sender, payout)) revert TransferFailed();
        }
    }

    function freezeDeposit(address _owner, uint256 _time) external {
        if (!hasRole(REDISTRIBUTOR_ROLE, msg.sender)) revert OnlyRedistributor();

        _applyReadyUpdates(_owner);

        if (_stakes[_owner].initialized) {
            _stakes[_owner].frozenUntilBlock = block.number + _time;
            emit StakeFrozen(_owner, _stakes[_owner].overlay, _time);
        }
    }

    function slashDeposit(address _owner, uint256 _amount) external {
        if (!hasRole(REDISTRIBUTOR_ROLE, msg.sender)) revert OnlyRedistributor();

        _applyReadyUpdates(_owner);

        StakeState storage stake = _stakes[_owner];
        bytes32 previousOverlay = stake.overlay;

        if (stake.initialized) {
            if (stake.balance > _amount) {
                stake.balance -= _amount;
                stake.lastUpdatedBlockNumber = block.number;
            } else if (_queueLength(_owner) > 0) {
                stake.balance = 0;
                stake.lastUpdatedBlockNumber = block.number;
            } else {
                delete _stakes[_owner];
            }
        }

        emit StakeSlashed(_owner, previousOverlay, _amount);
    }

    function changeNetworkId(uint64 _NetworkId) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert Unauthorized();
        NetworkId = _NetworkId;
    }

    function pause() public {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert OnlyPauser();
        _pause();
    }

    function unPause() public {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert OnlyPauser();
        _unpause();
    }

    function stakes(address _owner) public view returns (Stake memory) {
        return _toStakeView(_previewStake(_owner, false));
    }

    function nodeEffectiveStake(address _owner) public view returns (uint256) {
        if (!addressNotFrozen(_owner)) return 0;

        StakeState memory preview = _previewStake(_owner, false);
        return preview.initialized ? preview.balance : 0;
    }

    function lastUpdatedBlockNumberOfAddress(address _owner) public view returns (uint256) {
        return _stakes[_owner].initialized ? _stakes[_owner].lastUpdatedBlockNumber : 0;
    }

    function overlayOfAddress(address _owner) public view returns (bytes32) {
        StakeState memory preview = _previewStake(_owner, false);
        return preview.initialized ? preview.overlay : bytes32(0);
    }

    function heightOfAddress(address _owner) public view returns (uint8) {
        StakeState memory preview = _previewStake(_owner, false);
        return preview.initialized ? preview.height : 0;
    }

    function currentRound() public view returns (uint64) {
        return uint64(block.number / ROUND_LENGTH);
    }

    function addressNotFrozen(address _owner) internal view returns (bool) {
        StakeState storage stake = _stakes[_owner];
        return !stake.initialized || stake.frozenUntilBlock < block.number;
    }

    function _applyReadyUpdates(address _owner) internal {
        ScheduledUpdate[] storage queue = _updateQueues[_owner];
        uint256 head = _queueHeads[_owner];
        uint64 roundNumber = currentRound();

        while (head < queue.length && queue[head].effectiveFromRound <= roundNumber) {
            _applyStoredUpdate(_owner, queue[head]);
            delete queue[head];
            unchecked {
                ++head;
            }
        }

        if (head == queue.length) {
            delete _updateQueues[_owner];
            delete _queueHeads[_owner];
        } else {
            _queueHeads[_owner] = head;
        }
    }

    function _applyStoredUpdate(address _owner, ScheduledUpdate storage scheduled) internal {
        StakeState storage stake = _stakes[_owner];

        if (scheduled.kind == UpdateKind.CreateDeposit) {
            stake.overlay = _deriveOverlay(_owner, scheduled.nonce);
            stake.balance = scheduled.amount;
            stake.height = scheduled.height;
            stake.lastUpdatedBlockNumber = block.number;
            stake.initialized = true;
            return;
        }

        if (scheduled.kind == UpdateKind.AddTokens) {
            stake.balance += scheduled.amount;
            stake.lastUpdatedBlockNumber = block.number;
            stake.initialized = true;
            return;
        }

        if (scheduled.kind == UpdateKind.IncreaseHeight) {
            if (stake.initialized && scheduled.height > stake.height) {
                stake.height = scheduled.height;
                stake.lastUpdatedBlockNumber = block.number;
            }
            return;
        }

        if (scheduled.kind == UpdateKind.ChangeOverlay) {
            if (stake.initialized) {
                stake.overlay = _deriveOverlay(_owner, scheduled.nonce);
                stake.lastUpdatedBlockNumber = block.number;
            }
            return;
        }

        if (scheduled.kind == UpdateKind.WithdrawTokens) {
            if (stake.initialized) {
                if (scheduled.amount >= stake.balance) {
                    stake.balance = 0;
                } else {
                    stake.balance -= scheduled.amount;
                }
                stake.lastUpdatedBlockNumber = block.number;

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

    function _previewStake(address _owner, bool includeFutureUpdates) internal view returns (StakeState memory preview) {
        preview = _stakes[_owner];

        ScheduledUpdate[] storage queue = _updateQueues[_owner];
        uint256 head = _queueHeads[_owner];
        uint64 roundNumber = currentRound();

        for (uint256 i = head; i < queue.length; ) {
            ScheduledUpdate storage scheduled = queue[i];
            if (!includeFutureUpdates && scheduled.effectiveFromRound > roundNumber) {
                break;
            }

            preview = _applyPreviewUpdate(_owner, preview, scheduled);

            unchecked {
                ++i;
            }
        }
    }

    function _applyPreviewUpdate(
        address _owner,
        StakeState memory preview,
        ScheduledUpdate storage scheduled
    ) internal view returns (StakeState memory) {
        if (scheduled.kind == UpdateKind.CreateDeposit) {
            preview.overlay = _deriveOverlay(_owner, scheduled.nonce);
            preview.balance = scheduled.amount;
            preview.height = scheduled.height;
            preview.lastUpdatedBlockNumber = block.number;
            preview.initialized = true;
            return preview;
        }

        if (scheduled.kind == UpdateKind.AddTokens) {
            preview.balance += scheduled.amount;
            preview.lastUpdatedBlockNumber = block.number;
            preview.initialized = true;
            return preview;
        }

        if (scheduled.kind == UpdateKind.IncreaseHeight) {
            if (preview.initialized && scheduled.height > preview.height) {
                preview.height = scheduled.height;
                preview.lastUpdatedBlockNumber = block.number;
            }
            return preview;
        }

        if (scheduled.kind == UpdateKind.ChangeOverlay) {
            if (preview.initialized) {
                preview.overlay = _deriveOverlay(_owner, scheduled.nonce);
                preview.lastUpdatedBlockNumber = block.number;
            }
            return preview;
        }

        if (scheduled.kind == UpdateKind.WithdrawTokens) {
            if (preview.initialized) {
                if (scheduled.amount >= preview.balance) {
                    preview.balance = 0;
                } else {
                    preview.balance -= scheduled.amount;
                }
                preview.lastUpdatedBlockNumber = block.number;
            }
            return preview;
        }

        if (scheduled.kind == UpdateKind.ExitStake) {
            delete preview;
        }

        return preview;
    }

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
                kind: _kind,
                effectiveFromRound: effectiveFromRound,
                nonce: _nonce,
                amount: _amount,
                height: _height
            })
        );
    }

    function _lastScheduledRound(address _owner) internal view returns (uint64) {
        ScheduledUpdate[] storage queue = _updateQueues[_owner];
        if (_queueHeads[_owner] == queue.length) {
            return 0;
        }
        return queue[queue.length - 1].effectiveFromRound;
    }

    function _queueLength(address _owner) internal view returns (uint256) {
        return _updateQueues[_owner].length - _queueHeads[_owner];
    }

    function _pullTokens(address _owner, uint256 _amount) internal {
        if (_amount == 0) revert InvalidWithdrawalAmount();
        if (!ERC20(bzzToken).transferFrom(_owner, address(this), _amount)) revert TransferFailed();
    }

    function _minimumStakeForHeight(uint8 _height) internal pure returns (uint256) {
        return MIN_STAKE * (2 ** _height);
    }

    function _deriveOverlay(address _owner, bytes32 _setNonce) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(_owner, reverse(NetworkId), _setNonce));
    }

    function _toStakeView(StakeState memory _stake) internal pure returns (Stake memory) {
        if (!_stake.initialized) {
            return Stake({overlay: 0, balance: 0, lastUpdatedBlockNumber: 0, frozenUntilBlock: 0, height: 0});
        }

        return
            Stake({
                overlay: _stake.overlay,
                balance: _stake.balance,
                lastUpdatedBlockNumber: _stake.lastUpdatedBlockNumber,
                frozenUntilBlock: _stake.frozenUntilBlock,
                height: _stake.height
            });
    }

    function reverse(uint64 input) internal pure returns (uint64 v) {
        v = input;

        v = ((v & 0xFF00FF00FF00FF00) >> 8) | ((v & 0x00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000) >> 16) | ((v & 0x0000FFFF0000FFFF) << 16);
        v = (v >> 32) | (v << 32);
    }
}
