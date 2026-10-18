// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IDexAdapter} from "./interfaces/IDexAdapter.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";
import {TokenTransfers} from "./libraries/TokenTransfers.sol";
import {ITokenComplianceAdapter} from "./interfaces/ITokenComplianceAdapter.sol";
import {PriceOracle} from "./oracle/PriceOracle.sol";
import {EligibilityRegistry} from "./EligibilityRegistry.sol";

/// @title StockClaw FeeRouter ("StockClawRouter" in ARCHITECTURE.md)
/// @notice Fee-wrapping router for USDG <-> stock-token swaps on Robinhood Chain testnet (46630).
///  - Fee: default 30 bps, owner-settable in [0, 50] bps (hard cap 50); taken from the INPUT token before the
///    swap and sent to `feeTreasury` (a 2-of-3 Safe, constructor param).
///  - Inputs pulled by ERC-20 approval or Permit2 SignatureTransfer.
///  - EIP-712 signed intents (DCA / limit) with unordered nonces, executed by keepers.
///    Signatures validated with SignatureChecker (EOA ecrecover or ERC-1271 smart accounts).
///  - Every swap enforces: eligibility (owner-EOA keyed), market hours, adapter allowlist, deadline,
///    optional per-token compliance adapter, oracle-deviation floor, minOut.
///  - Restricted-token reverts (freeze/pause/registry) surface as TokenTransfers.TransferBlocked or
///    AdapterSwapFailed; the whole tx reverts so no funds are ever left in the router.
///  - DCA: no catch-up. Missed intervals are skipped; only the next slice runs.
///  - Pausable; ReentrancyGuard; router holds no balances between calls.
contract FeeRouter is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint16 public constant DEFAULT_FEE_BPS = 30;
    uint16 public constant MAX_FEE_BPS = 50;
    uint16 internal constant BPS = 10_000;
    /// Mandatory oracle floor: output must be >= oracle-implied * (1 - maxSlippageBps). Callers and
    /// intents may only tighten it.
    uint16 public constant MAX_SLIPPAGE_CAP_BPS = 300;

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent(address account,address tokenIn,address tokenOut,address adapter,uint128 amountPerExec,uint128 minOutPerExec,uint64 limitPriceE8,uint32 interval,uint16 maxExecs,uint16 maxOracleDevBps,uint40 startTime,uint40 expiry,uint256 nonce)"
    );

    struct SwapParams {
        address adapter;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut; // received by recipient
        address recipient;
        uint256 deadline;
    }

    /// @notice Signed DCA (maxExecs > 1, interval > 0) or limit order (maxExecs == 1, limitPriceE8 != 0).
    struct Intent {
        address account; // funds owner & signer (EOA or ERC-1271 account)
        address tokenIn;
        address tokenOut;
        address adapter;
        uint128 amountPerExec;
        uint128 minOutPerExec;
        uint64 limitPriceE8; // 0 = none. Buy (tokenIn=USDG): oracle(tokenOut) <= limit. Sell: oracle(tokenIn) >= limit.
        uint32 interval; // DCA spacing (s)
        uint16 maxExecs;
        uint16 maxOracleDevBps; // max shortfall of output vs oracle-implied output
        uint40 startTime;
        uint40 expiry;
        uint256 nonce; // unordered; cancel via cancelNonce
    }

    /// Per-intent execution state, one slot.
    struct IntentState {
        uint16 execs; // slices actually executed
        uint40 nextExecAt; // 0 => startTime
    }

    // slot: feeTreasury(20) + feeBps(2) + maxSlippageBps(2)
    address public feeTreasury;
    uint16 public feeBps;
    uint16 public maxSlippageBps = MAX_SLIPPAGE_CAP_BPS;
    /// Single keeper (key held in cloud KMS, execute-only, no custody).
    address public keeper;

    ISignatureTransfer public immutable permit2;
    PriceOracle public immutable oracle;
    EligibilityRegistry public immutable eligibility;

    mapping(address => bool) public isAdapter;
    mapping(address account => mapping(uint256 nonce => bool)) public nonceCancelled;
    mapping(bytes32 intentHash => IntentState) public intentState;
    mapping(address token => ITokenComplianceAdapter) public complianceAdapter;

    event Swapped(
        address indexed account, address indexed recipient, address indexed adapter,
        address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 fee
    );
    event IntentExecuted(bytes32 indexed intentHash, address indexed account, uint16 execNumber, uint256 amountOut);
    event NonceCancelled(address indexed account, uint256 nonce);
    event FeeUpdated(uint16 feeBps);
    event FeeTreasuryUpdated(address treasury);
    event AdapterSet(address adapter, bool allowed);
    event KeeperSet(address keeper);
    event MaxSlippageSet(uint16 bps);
    event ComplianceAdapterSet(address indexed token, address adapter);

    error FeeAboveCap(uint16 bps);
    error ZeroAddress();
    error ZeroAmount();
    error Expired();
    error AdapterNotAllowed(address adapter);
    error SameToken();
    error NotEligible(address account);
    error InsufficientOutput(uint256 out, uint256 minOut);
    error InvalidSignature();
    error NonceIsCancelled();
    error IntentExhausted();
    error NotYet(uint256 nextAt);
    error LimitNotMet(uint256 oraclePriceE8, uint64 limitPriceE8);
    error NotKeeper();
    error InvalidIntent();
    error PermitMismatch();
    error MarketClosed();
    error ZeroMinOut();
    error SlippageOutOfBounds(uint16 bps);
    error ComplianceBlocked(address token, address from, address to, bytes32 reason);
    error AdapterSwapFailed(address adapter, bytes reason);
    error PairNotSupported(address adapter, address tokenIn, address tokenOut);

    constructor(
        address owner_,
        address feeTreasury_,
        ISignatureTransfer permit2_,
        PriceOracle oracle_,
        EligibilityRegistry eligibility_
    ) Ownable(owner_) EIP712("StockClawRouter", "1") {
        if (feeTreasury_ == address(0)) revert ZeroAddress();
        feeTreasury = feeTreasury_;
        feeBps = DEFAULT_FEE_BPS;
        permit2 = permit2_;
        oracle = oracle_;
        eligibility = eligibility_;
    }

    // ================================================================ admin
    function setFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeAboveCap(bps);
        feeBps = bps;
        emit FeeUpdated(bps);
    }

    function setFeeTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        feeTreasury = t;
        emit FeeTreasuryUpdated(t);
    }

    function setAdapter(address a, bool allowed) external onlyOwner {
        if (a == address(0)) revert ZeroAddress();
        isAdapter[a] = allowed;
        emit AdapterSet(a, allowed);
    }

    function setMaxSlippageBps(uint16 bps) external onlyOwner {
        if (bps == 0 || bps > MAX_SLIPPAGE_CAP_BPS) revert SlippageOutOfBounds(bps);
        maxSlippageBps = bps;
        emit MaxSlippageSet(bps);
    }

    function setKeeper(address k) external onlyOwner {
        keeper = k;
        emit KeeperSet(k);
    }

    /// @notice Pluggable per-token compliance pre-check; address(0) = none (default).
    function setComplianceAdapter(address token, ITokenComplianceAdapter a) external onlyOwner {
        complianceAdapter[token] = a;
        emit ComplianceAdapterSet(token, address(a));
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Router holds nothing between calls; recovers mistaken transfers only.
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        TokenTransfers.transfer(token, to, amount);
    }

    // ================================================================ views
    function execCount(bytes32 h) external view returns (uint16) {
        return intentState[h].execs;
    }

    function quote(address adapter, address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 netOut, uint256 fee)
    {
        fee = amountIn * feeBps / BPS;
        netOut = IDexAdapter(adapter).quote(tokenIn, tokenOut, amountIn - fee);
    }

    /// @notice N-4: adapter is registered AND serves exactly this token pair. Never reverts.
    function isRouteSupported(address adapter, address tokenIn, address tokenOut) public view returns (bool) {
        if (!isAdapter[adapter]) return false;
        try IDexAdapter(adapter).supportsPair(tokenIn, tokenOut) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function hashIntent(Intent calldata i) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(INTENT_TYPEHASH, i)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice MCP/keeper pre-flight (never reverts): eligibility, pause, market hours, and the
    /// optional compliance adapters. Issuer restrictions without an adapter are only detected on execution.
    function precheck(address account, address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        external
        view
        returns (bool ok)
    {
        if (!eligibility.isEligible(account) || paused() || !oracle.isMarketOpen()) return false;
        if (recipient != account && !eligibility.isEligible(recipient)) return false;
        return _complianceOk(tokenIn, account, address(this), amountIn)
            && _complianceOk(tokenIn, address(this), feeTreasury, 0)
            && _complianceOk(tokenOut, address(this), recipient, 0);
    }

    function _complianceOk(address token, address from, address to, uint256 amt) internal view returns (bool) {
        ITokenComplianceAdapter a = complianceAdapter[token];
        if (address(a) == address(0)) return true;
        try a.check(token, from, to, amt) returns (bool ok, bytes32) {
            return ok;
        } catch {
            return false;
        }
    }

    // ================================================================ direct swaps
    function swap(SwapParams calldata p) external nonReentrant whenNotPaused returns (uint256) {
        if (p.minAmountOut == 0) revert ZeroMinOut();
        _validate(msg.sender, p.adapter, p.tokenIn, p.tokenOut, p.amountIn, p.recipient, p.deadline);
        uint256 received = _pullApproved(p.tokenIn, msg.sender, p.amountIn);
        return _swapHeld(msg.sender, p.adapter, p.tokenIn, p.tokenOut, received, p.minAmountOut, p.recipient, 0);
    }

    function swapWithPermit2(
        SwapParams calldata p,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (uint256) {
        if (p.minAmountOut == 0) revert ZeroMinOut();
        _validate(msg.sender, p.adapter, p.tokenIn, p.tokenOut, p.amountIn, p.recipient, p.deadline);
        if (permit.permitted.token != p.tokenIn) revert PermitMismatch();
        uint256 before = IERC20(p.tokenIn).balanceOf(address(this));
        permit2.permitTransferFrom(
            permit, ISignatureTransfer.SignatureTransferDetails(address(this), p.amountIn), msg.sender, signature
        );
        uint256 received = IERC20(p.tokenIn).balanceOf(address(this)) - before;
        return _swapHeld(msg.sender, p.adapter, p.tokenIn, p.tokenOut, received, p.minAmountOut, p.recipient, 0);
    }

    // ================================================================ intents
    function cancelNonce(uint256 nonce) external {
        nonceCancelled[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    /// @notice Execute one slice of a signed intent. Funds are pulled from `account` by allowance
    /// (no escrow => nothing can be stranded in this contract). Keeper-only (single KMS-held keeper);
    /// the account itself may always execute its own intent (used by AgentVault, which enforces caps).
    function executeIntent(Intent calldata i, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 amountOut)
    {
        bytes32 h = hashIntent(i);
        if (msg.sender != i.account) {
            if (msg.sender != keeper) revert NotKeeper();
            if (!SignatureChecker.isValidSignatureNow(i.account, h, signature)) revert InvalidSignature();
        }
        if (nonceCancelled[i.account][i.nonce]) revert NonceIsCancelled();
        if (
            i.maxExecs == 0 || (i.maxExecs > 1 && i.interval == 0) || i.maxOracleDevBps == 0
                || i.maxOracleDevBps > MAX_SLIPPAGE_CAP_BPS
        ) revert InvalidIntent();
        if (i.minOutPerExec == 0) revert ZeroMinOut();
        IntentState memory st = intentState[h];
        uint16 n = st.execs;
        if (n >= i.maxExecs) revert IntentExhausted();
        uint256 nextAt = st.nextExecAt == 0 ? i.startTime : st.nextExecAt;
        if (block.timestamp < nextAt) revert NotYet(nextAt);
        _validate(i.account, i.adapter, i.tokenIn, i.tokenOut, i.amountPerExec, i.account, i.expiry);
        _checkLimit(i);

        // Effects before interactions. No catch-up: advance to the first interval boundary strictly
        // in the future, so missed slices are skipped rather than executed back-to-back.
        uint256 nextBoundary = type(uint40).max;
        if (i.interval != 0) {
            uint256 elapsed = (block.timestamp - i.startTime) / i.interval;
            nextBoundary = uint256(i.startTime) + (elapsed + 1) * i.interval;
        }
        intentState[h] = IntentState(n + 1, uint40(nextBoundary));

        uint256 received = _pullApproved(i.tokenIn, i.account, i.amountPerExec);
        amountOut =
            _swapHeld(i.account, i.adapter, i.tokenIn, i.tokenOut, received, i.minOutPerExec, i.account, i.maxOracleDevBps);
        emit IntentExecuted(h, i.account, n + 1, amountOut);
    }

    function _checkLimit(Intent calldata i) internal view {
        if (i.limitPriceE8 == 0) return;
        if (i.tokenIn == oracle.usdg()) {
            uint256 p = oracle.priceE8(i.tokenOut);
            if (p > i.limitPriceE8) revert LimitNotMet(p, i.limitPriceE8);
        } else {
            uint256 p = oracle.priceE8(i.tokenIn);
            if (p < i.limitPriceE8) revert LimitNotMet(p, i.limitPriceE8);
        }
    }

    // ================================================================ internals
    function _validate(
        address account,
        address adapter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address recipient,
        uint256 deadline
    ) internal view {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (tokenIn == tokenOut) revert SameToken();
        if (!isAdapter[adapter]) revert AdapterNotAllowed(adapter);
        if (!isRouteSupported(adapter, tokenIn, tokenOut)) revert PairNotSupported(adapter, tokenIn, tokenOut);
        if (!eligibility.isEligible(account)) revert NotEligible(account);
        if (recipient != account && !eligibility.isEligible(recipient)) revert NotEligible(recipient);
        if (!oracle.isMarketOpen()) revert MarketClosed();
        _requireCompliance(tokenIn, account, address(this), amountIn);
        _requireCompliance(tokenIn, address(this), feeTreasury, 0);
        _requireCompliance(tokenOut, address(this), recipient, 0);
    }

    function _requireCompliance(address token, address from, address to, uint256 amt) internal view {
        ITokenComplianceAdapter a = complianceAdapter[token];
        if (address(a) == address(0)) return;
        (bool ok, bytes32 reason) = a.check(token, from, to, amt);
        if (!ok) revert ComplianceBlocked(token, from, to, reason);
    }

    function _pullApproved(address token, address from, uint256 amount) internal returns (uint256) {
        uint256 before = IERC20(token).balanceOf(address(this));
        TokenTransfers.transferFrom(token, from, address(this), amount);
        return IERC20(token).balanceOf(address(this)) - before;
    }

    /// @param oracleDevBps optional tighter oracle deviation (0 = protocol default maxSlippageBps).
    function _swapHeld(
        address account,
        address adapter,
        address tokenIn,
        address tokenOut,
        uint256 received,
        uint256 minOut,
        address recipient,
        uint16 oracleDevBps
    ) internal returns (uint256 amountOut) {
        uint256 fee = received * feeBps / BPS;
        uint256 toSwap = received - fee;
        if (fee != 0) TokenTransfers.transfer(tokenIn, feeTreasury, fee);

        {
            uint16 dev = maxSlippageBps;
            if (oracleDevBps != 0 && oracleDevBps < dev) dev = oracleDevBps; // may only tighten
            uint256 floor = oracle.convert(tokenIn, tokenOut, toSwap) * (BPS - dev) / BPS;
            if (floor > minOut) minOut = floor;
        }

        // Balance-delta measurement around the adapter call is intentional (defensive vs. adapters that
        // misreport). Safe: every external entry point is nonReentrant, adapters are owner-allowlisted,
        // and the router holds no balances between calls (invariant-tested).
        // slither-disable-next-line reentrancy-balance
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        TokenTransfers.transfer(tokenIn, adapter, toSwap);
        try IDexAdapter(adapter).swap(tokenIn, tokenOut, toSwap, minOut, address(this)) {}
        catch (bytes memory reason) {
            revert AdapterSwapFailed(adapter, reason);
        }
        // slither-disable-next-line reentrancy-balance
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        TokenTransfers.transfer(tokenOut, recipient, amountOut);
        emit Swapped(account, recipient, adapter, tokenIn, tokenOut, received, amountOut, fee);
    }
}
