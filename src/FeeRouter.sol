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
import {TokenChecks} from "./libraries/TokenChecks.sol";
import {PriceOracle} from "./oracle/PriceOracle.sol";
import {EligibilityRegistry} from "./EligibilityRegistry.sol";

/// @title StockClaw FeeRouter ("StockClawRouter" in ARCHITECTURE.md)
/// @notice Fee-wrapping router for USDG <-> stock-token swaps on Robinhood Chain testnet (46630).
///  - Fee: default 30 bps, owner-settable, hard cap 50 bps; taken from the INPUT token before the
///    swap and sent to `feeTreasury` (a 2-of-3 Safe, constructor param).
///  - Inputs pulled by ERC-20 approval or Permit2 SignatureTransfer.
///  - EIP-712 signed intents (DCA / limit) with unordered nonces, executed by keepers.
///    Signatures validated with SignatureChecker (EOA ecrecover or ERC-1271 smart accounts).
///  - Every swap enforces: eligibility, adapter allowlist, deadline, oracle-deviation floor, minOut.
///  - Pausable; ReentrancyGuard; router holds no balances between calls.
contract FeeRouter is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint16 public constant DEFAULT_FEE_BPS = 30;
    uint16 public constant MAX_FEE_BPS = 50;
    uint16 internal constant BPS = 10_000;

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

    // slot: feeTreasury(20) + feeBps(2) + permissionless(1)
    address public feeTreasury;
    uint16 public feeBps;
    bool public permissionlessExecution;

    ISignatureTransfer public immutable permit2;
    PriceOracle public immutable oracle;
    EligibilityRegistry public immutable eligibility;

    mapping(address => bool) public isAdapter;
    mapping(address => bool) public isKeeper;
    mapping(address account => mapping(uint256 nonce => bool)) public nonceCancelled;
    mapping(bytes32 intentHash => uint16) public execCount;

    event Swapped(
        address indexed account, address indexed recipient, address indexed adapter,
        address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 fee
    );
    event IntentExecuted(bytes32 indexed intentHash, address indexed account, uint16 execNumber, uint256 amountOut);
    event NonceCancelled(address indexed account, uint256 nonce);
    event FeeUpdated(uint16 feeBps);
    event FeeTreasuryUpdated(address treasury);
    event AdapterSet(address adapter, bool allowed);
    event KeeperSet(address keeper, bool allowed);
    event PermissionlessSet(bool v);

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

    function setKeeper(address k, bool v) external onlyOwner {
        isKeeper[k] = v;
        emit KeeperSet(k, v);
    }

    function setPermissionlessExecution(bool v) external onlyOwner {
        permissionlessExecution = v;
        emit PermissionlessSet(v);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Router holds nothing between calls; recovers mistaken transfers only.
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    // ================================================================ views
    function quote(address adapter, address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 netOut, uint256 fee)
    {
        fee = amountIn * feeBps / BPS;
        netOut = IDexAdapter(adapter).quote(tokenIn, tokenOut, amountIn - fee);
    }

    function hashIntent(Intent calldata i) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(INTENT_TYPEHASH, i)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice MCP/keeper pre-flight: issuer restrictions + eligibility. Never reverts.
    function precheck(address account, address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        external
        view
        returns (bool ok)
    {
        return eligibility.isEligible(account) && !paused()
            && TokenChecks.canTransfer(tokenIn, account, address(this), amountIn)
            && TokenChecks.canTransfer(tokenOut, address(this), recipient, 0);
    }

    // ================================================================ direct swaps
    function swap(SwapParams calldata p) external nonReentrant whenNotPaused returns (uint256) {
        _validate(msg.sender, p.adapter, p.tokenIn, p.tokenOut, p.amountIn, p.recipient, p.deadline);
        uint256 received = _pullApproved(p.tokenIn, msg.sender, p.amountIn);
        return _swapHeld(msg.sender, p.adapter, p.tokenIn, p.tokenOut, received, p.minAmountOut, p.recipient, 0);
    }

    function swapWithPermit2(
        SwapParams calldata p,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (uint256) {
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
    /// (no escrow => nothing can be stranded in this contract). Keeper-only unless permissionless;
    /// the account itself may always execute its own intent (used by AgentVault, which enforces caps).
    function executeIntent(Intent calldata i, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 amountOut)
    {
        bytes32 h = hashIntent(i);
        if (msg.sender != i.account) {
            if (!permissionlessExecution && !isKeeper[msg.sender]) revert NotKeeper();
            if (!SignatureChecker.isValidSignatureNow(i.account, h, signature)) revert InvalidSignature();
        }
        if (nonceCancelled[i.account][i.nonce]) revert NonceIsCancelled();
        if (i.maxExecs == 0 || (i.maxExecs > 1 && i.interval == 0)) revert InvalidIntent();
        uint16 n = execCount[h];
        if (n >= i.maxExecs) revert IntentExhausted();
        uint256 nextAt = uint256(i.startTime) + uint256(n) * i.interval;
        if (block.timestamp < nextAt) revert NotYet(nextAt);
        _validate(i.account, i.adapter, i.tokenIn, i.tokenOut, i.amountPerExec, i.account, i.expiry);
        _checkLimit(i);

        execCount[h] = n + 1; // effects before interactions

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
        if (!eligibility.isEligible(account)) revert NotEligible(account);
        // Issuer pre-flight (freeze / pause / registry) -> clean custom errors.
        TokenChecks.requireTransferable(tokenIn, account, address(this), amountIn);
        TokenChecks.requireTransferable(tokenOut, address(this), recipient, 0);
    }

    function _pullApproved(address token, address from, uint256 amount) internal returns (uint256) {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        return IERC20(token).balanceOf(address(this)) - before;
    }

    /// @param oracleDevBps if non-zero, enforce output >= oracle-implied * (1 - dev).
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
        if (fee != 0) IERC20(tokenIn).safeTransfer(feeTreasury, fee);

        if (oracleDevBps != 0) {
            uint256 floor = oracle.convert(tokenIn, tokenOut, toSwap) * (BPS - oracleDevBps) / BPS;
            if (floor > minOut) minOut = floor;
        }

        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).safeTransfer(adapter, toSwap);
        IDexAdapter(adapter).swap(tokenIn, tokenOut, toSwap, minOut, address(this));
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        emit Swapped(account, recipient, adapter, tokenIn, tokenOut, received, amountOut, fee);
    }
}
