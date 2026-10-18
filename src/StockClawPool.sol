// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IDexAdapter} from "./interfaces/IDexAdapter.sol";
import {PriceOracle} from "./oracle/PriceOracle.sol";

/// @title StockClawPool
/// @notice Demo constant-product (x*y=k) USDG/stock pool, owner-only liquidity, oracle-band guard:
/// a swap reverts if the post-trade pool price deviates more than `bandBps` from the oracle.
/// Acts directly as an IDexAdapter for the router (tokens are pushed in before `swap`).
/// No LP fee: the protocol fee is charged once, in the router.
contract StockClawPool is IDexAdapter, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable stock;
    address public immutable usdg;
    PriceOracle public immutable oracle;

    // slot: reserves packed (2 x 112) + bandBps (16)
    uint112 public reserveStock;
    uint112 public reserveUsdg;
    uint16 public bandBps;

    address public router; // only caller allowed to swap

    event Swap(address indexed tokenIn, uint256 amountIn, uint256 amountOut, address indexed recipient);
    event LiquidityChanged(uint112 reserveStock, uint112 reserveUsdg);
    event BandSet(uint16 bps);
    event RouterSet(address router);

    error OnlyRouter();
    error BadPair();
    error ZeroInput();
    error InsufficientOutput(uint256 out, uint256 minOut);
    error OutsideOracleBand(uint256 poolPriceE8, uint256 oraclePriceE8);
    error InvalidBand();
    error Overflow();

    constructor(address owner_, address stock_, address usdg_, PriceOracle oracle_, uint16 bandBps_)
        Ownable(owner_)
    {
        if (bandBps_ == 0 || bandBps_ > 5_000) revert InvalidBand();
        stock = stock_;
        usdg = usdg_;
        oracle = oracle_;
        bandBps = bandBps_;
    }

    // ---------------------------------------------------------------- admin
    function setRouter(address r) external onlyOwner {
        router = r;
        emit RouterSet(r);
    }

    function setBand(uint16 bps) external onlyOwner {
        if (bps == 0 || bps > 5_000) revert InvalidBand();
        bandBps = bps;
        emit BandSet(bps);
    }

    /// @notice Owner seeds liquidity (pulls tokens). Demo only; no LP shares.
    function addLiquidity(uint256 stockAmt, uint256 usdgAmt) external onlyOwner nonReentrant {
        IERC20(stock).safeTransferFrom(msg.sender, address(this), stockAmt);
        IERC20(usdg).safeTransferFrom(msg.sender, address(this), usdgAmt);
        _sync();
    }

    function removeLiquidity(uint256 stockAmt, uint256 usdgAmt, address to) external onlyOwner nonReentrant {
        IERC20(stock).safeTransfer(to, stockAmt);
        IERC20(usdg).safeTransfer(to, usdgAmt);
        _sync();
    }

    function _sync() internal {
        uint256 s = IERC20(stock).balanceOf(address(this));
        uint256 u = IERC20(usdg).balanceOf(address(this));
        if (s > type(uint112).max || u > type(uint112).max) revert Overflow();
        reserveStock = uint112(s);
        reserveUsdg = uint112(u);
        emit LiquidityChanged(uint112(s), uint112(u));
    }

    // ---------------------------------------------------------------- views
    function getAmountOut(uint256 amountIn, uint256 rIn, uint256 rOut) public pure returns (uint256) {
        return amountIn * rOut / (rIn + amountIn); // rounds down -> k never decreases
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        (uint256 rIn, uint256 rOut) = _reserves(tokenIn, tokenOut);
        return getAmountOut(amountIn, rIn, rOut);
    }

    /// @notice Pool price, USD (USDG) per 1 whole stock, 8 dp.
    function poolPriceE8(uint256 rStock, uint256 rUsdg) public view returns (uint256) {
        (,,, uint8 sd) = oracle.feeds(stock);
        // rUsdg(6dp)/rStock(sd dp) -> *1e8
        return rUsdg * (10 ** sd) * 100 / rStock;
    }

    // ---------------------------------------------------------------- swap
    function swap(address tokenIn, address tokenOut, uint256, uint256 minOut, address recipient)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (msg.sender != router) revert OnlyRouter();
        (uint256 rIn, uint256 rOut) = _reserves(tokenIn, tokenOut);
        uint256 amountIn = IERC20(tokenIn).balanceOf(address(this)) - rIn; // actually received
        if (amountIn == 0) revert ZeroInput();
        out = getAmountOut(amountIn, rIn, rOut);
        if (out < minOut) revert InsufficientOutput(out, minOut);

        uint256 newIn = rIn + amountIn;
        uint256 newOut = rOut - out;
        (uint256 rS, uint256 rU) = tokenIn == stock ? (newIn, newOut) : (newOut, newIn);
        _checkBand(rS, rU);

        if (rS > type(uint112).max || rU > type(uint112).max) revert Overflow();
        reserveStock = uint112(rS);
        reserveUsdg = uint112(rU);
        IERC20(tokenOut).safeTransfer(recipient, out);
        emit Swap(tokenIn, amountIn, out, recipient);
    }

    function _checkBand(uint256 rS, uint256 rU) internal view {
        uint256 p = poolPriceE8(rS, rU);
        uint256 o = oracle.priceE8(stock); // reverts if stale
        uint256 diff = p > o ? p - o : o - p;
        if (diff * 10_000 > o * bandBps) revert OutsideOracleBand(p, o);
    }

    function _reserves(address tokenIn, address tokenOut) internal view returns (uint256, uint256) {
        if (tokenIn == stock && tokenOut == usdg) return (reserveStock, reserveUsdg);
        if (tokenIn == usdg && tokenOut == stock) return (reserveUsdg, reserveStock);
        revert BadPair();
    }
}
