// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IDexAdapter} from "./interfaces/IDexAdapter.sol";
import {PriceOracle} from "./oracle/PriceOracle.sol";
import {TokenTransfers} from "./libraries/TokenTransfers.sol";

/// @title StockClawPool
/// @notice Oracle-anchored USDG/stock pool (CTO decision). Every fill is at the oracle price minus a
/// bounded owner-set spread (10-30 bps), capped by the output reserve. No curve, no price impact:
/// `quote()` returns exactly what `swap()` delivers in the same block. Owner-only liquidity.
/// Pool value at oracle price never decreases on a swap (it gains the spread).
/// Acts directly as an IDexAdapter for the router (tokens are pushed in before `swap`).
/// Inherits the oracle's halts: stale feed (>1h) or market closed => quote/swap revert.
/// F1/R3-3: reserves are ACCOUNTED, never re-synced from raw balances. `swap` fills exactly the
/// router-supplied `amountIn` (after checking it arrived); tokens sent directly to the pool never enter
/// reserves or pricing and can only be swept by the owner via `skim`.
contract StockClawPool is IDexAdapter, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable stock;
    address public immutable usdg;
    PriceOracle public immutable oracle;

    uint16 public constant MIN_SPREAD_BPS = 10;
    uint16 public constant MAX_SPREAD_BPS = 30;

    // slot: reserves packed (2 x 112) + spreadBps (16)
    uint112 public reserveStock;
    uint112 public reserveUsdg;
    uint16 public spreadBps;

    address public router; // only caller allowed to swap

    event Swap(address indexed tokenIn, uint256 amountIn, uint256 amountOut, address indexed recipient);
    event LiquidityChanged(uint112 reserveStock, uint112 reserveUsdg);
    event SpreadSet(uint16 bps);
    event RouterSet(address router);
    event Skimmed(address indexed to, uint256 stockAmount, uint256 usdgAmount);

    error OnlyRouter();
    error BadPair();
    error ZeroInput();
    error InsufficientOutput(uint256 out, uint256 minOut);
    error InsufficientLiquidity(uint256 out, uint256 reserve);
    error InvalidSpread(uint16 bps);
    error Overflow();
    error InputNotReceived(uint256 received, uint256 amountIn);
    error ReserveExceedsBalance();

    constructor(address owner_, address stock_, address usdg_, PriceOracle oracle_, uint16 spreadBps_)
        Ownable(owner_)
    {
        if (spreadBps_ < MIN_SPREAD_BPS || spreadBps_ > MAX_SPREAD_BPS) revert InvalidSpread(spreadBps_);
        stock = stock_;
        usdg = usdg_;
        oracle = oracle_;
        spreadBps = spreadBps_;
    }

    // ---------------------------------------------------------------- admin
    function setRouter(address r) external onlyOwner {
        router = r;
        emit RouterSet(r);
    }

    function setSpread(uint16 bps) external onlyOwner {
        if (bps < MIN_SPREAD_BPS || bps > MAX_SPREAD_BPS) revert InvalidSpread(bps);
        spreadBps = bps;
        emit SpreadSet(bps);
    }

    /// @notice Owner seeds liquidity (pulls tokens). Demo only; no LP shares. Reserves grow by exactly the
    /// amounts deposited; any stray balance already in the pool is NOT absorbed (use `skim`).
    function addLiquidity(uint256 stockAmt, uint256 usdgAmt) external onlyOwner nonReentrant {
        IERC20(stock).safeTransferFrom(msg.sender, address(this), stockAmt);
        IERC20(usdg).safeTransferFrom(msg.sender, address(this), usdgAmt);
        _setReserves(uint256(reserveStock) + stockAmt, uint256(reserveUsdg) + usdgAmt);
        emit LiquidityChanged(reserveStock, reserveUsdg);
    }

    /// @notice Owner withdraws liquidity from reserves (accounted amounts only; excess goes via `skim`).
    function removeLiquidity(uint256 stockAmt, uint256 usdgAmt, address to) external onlyOwner nonReentrant {
        if (stockAmt > reserveStock) revert InsufficientLiquidity(stockAmt, reserveStock);
        if (usdgAmt > reserveUsdg) revert InsufficientLiquidity(usdgAmt, reserveUsdg);
        _setReserves(uint256(reserveStock) - stockAmt, uint256(reserveUsdg) - usdgAmt);
        IERC20(stock).safeTransfer(to, stockAmt);
        IERC20(usdg).safeTransfer(to, usdgAmt);
        emit LiquidityChanged(reserveStock, reserveUsdg);
    }

    /// @notice Owner sweeps `balance - reserve` of both tokens (direct transfers/donations) to `to`.
    /// Reserves are unchanged. No excess on either side => no-op. A restricted stock token that refuses
    /// the transfer (pause/freeze/registry) reverts the whole call with TransferBlocked.
    function skim(address to) external onlyOwner nonReentrant returns (uint256 stockOut, uint256 usdgOut) {
        stockOut = _excess(stock, reserveStock);
        usdgOut = _excess(usdg, reserveUsdg);
        if (stockOut == 0 && usdgOut == 0) return (0, 0);
        if (stockOut != 0) TokenTransfers.transfer(stock, to, stockOut);
        if (usdgOut != 0) TokenTransfers.transfer(usdg, to, usdgOut);
        emit Skimmed(to, stockOut, usdgOut);
    }

    function _excess(address token, uint256 reserve) internal view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        return bal > reserve ? bal - reserve : 0;
    }

    /// @dev Writes accounted reserves; the pool must actually hold at least that much of each token.
    function _setReserves(uint256 s, uint256 u) internal {
        if (s > type(uint112).max || u > type(uint112).max) revert Overflow();
        if (IERC20(stock).balanceOf(address(this)) < s || IERC20(usdg).balanceOf(address(this)) < u) {
            revert ReserveExceedsBalance();
        }
        reserveStock = uint112(s);
        reserveUsdg = uint112(u);
    }

    // ---------------------------------------------------------------- views
    function supportsPair(address tokenIn, address tokenOut) external view returns (bool) {
        return (tokenIn == stock && tokenOut == usdg) || (tokenIn == usdg && tokenOut == stock);
    }

    /// @notice Exact output for `amountIn` at oracle price minus spread. Reverts if it exceeds reserves.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256 out) {
        (, uint256 rOut) = _reserves(tokenIn, tokenOut);
        out = oracle.convert(tokenIn, tokenOut, amountIn) * (10_000 - spreadBps) / 10_000;
        if (out > rOut) revert InsufficientLiquidity(out, rOut);
    }

    /// @notice Reserves valued in USD (6 dp) at the current oracle price.
    function valueUsd() external view returns (uint256) {
        return oracle.usdValue(stock, reserveStock) + reserveUsdg;
    }

    // ---------------------------------------------------------------- swap
    /// @notice Fills exactly `amountIn` (the router pushes it in first). Requires that at least
    /// `amountIn` of `tokenIn` arrived on top of the accounted reserve; any surplus (donation) is
    /// ignored for pricing and stays outside reserves.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (msg.sender != router) revert OnlyRouter();
        if (amountIn == 0) revert ZeroInput();
        (uint256 rIn, uint256 rOut) = _reserves(tokenIn, tokenOut);
        uint256 received = _excess(tokenIn, rIn);
        if (received < amountIn) revert InputNotReceived(received, amountIn);
        out = quote(tokenIn, tokenOut, amountIn);
        if (out == 0 || out < minOut) revert InsufficientOutput(out, minOut);

        uint256 newIn = rIn + amountIn;
        uint256 newOut = rOut - out;
        (uint256 rS, uint256 rU) = tokenIn == stock ? (newIn, newOut) : (newOut, newIn);

        if (rS > type(uint112).max || rU > type(uint112).max) revert Overflow();
        reserveStock = uint112(rS);
        reserveUsdg = uint112(rU);
        IERC20(tokenOut).safeTransfer(recipient, out);
        emit Swap(tokenIn, amountIn, out, recipient);
    }

    function _reserves(address tokenIn, address tokenOut) internal view returns (uint256, uint256) {
        if (tokenIn == stock && tokenOut == usdg) return (reserveStock, reserveUsdg);
        if (tokenIn == usdg && tokenOut == stock) return (reserveUsdg, reserveStock);
        revert BadPair();
    }
}
