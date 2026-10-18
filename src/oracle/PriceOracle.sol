// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice Token -> USD price registry over Chainlink-style feeds, with staleness checks.
/// USDG is pinned at $1.00 (documented assumption; replace with a USDG/USD feed if one exists).
/// All USD values are returned with 6 decimals (same as USDG) so "$100" == 100e6.
/// Market-hours halt: stock prices (and therefore all stock trading) revert with MarketClosed
/// outside the configured session. Mode is set by owner or keeper:
///   Closed   - halted (holidays, incidents)
///   Open     - forced open (testing / demo)
///   Schedule - open Mon-Fri between openMinute and closeMinute (UTC minutes of day)
contract PriceOracle is Ownable2Step {
    enum MarketMode {
        Schedule,
        Open,
        Closed
    }

    // slot: keeper(20) + mode(1) + openMinute(2) + closeMinute(2)
    address public keeper;
    MarketMode public marketMode;
    uint16 public openMinute = 13 * 60 + 30; // 09:30 ET (EDT) = 13:30 UTC
    uint16 public closeMinute = 20 * 60; // 16:00 ET (EDT) = 20:00 UTC

    struct Feed {
        AggregatorV3Interface feed; // 20
        uint32 maxStaleness; // 4
        uint8 feedDecimals; // 1
        uint8 tokenDecimals; // 1
    }

    address public immutable usdg;
    mapping(address token => Feed) public feeds;

    event FeedSet(address indexed token, address feed, uint32 maxStaleness);
    event MarketModeSet(MarketMode mode);
    event ScheduleSet(uint16 openMinute, uint16 closeMinute);
    event KeeperSet(address keeper);

    error NoFeed(address token);
    error StalePrice(address token, uint256 updatedAt);
    error BadPrice(address token);
    error MarketClosed();
    error NotOwnerOrKeeper();
    error BadSchedule();

    constructor(address owner_, address usdg_) Ownable(owner_) {
        usdg = usdg_;
    }

    modifier onlyOwnerOrKeeper() {
        if (msg.sender != owner() && msg.sender != keeper) revert NotOwnerOrKeeper();
        _;
    }

    function setKeeper(address k) external onlyOwner {
        keeper = k;
        emit KeeperSet(k);
    }

    function setMarketMode(MarketMode m) external onlyOwnerOrKeeper {
        marketMode = m;
        emit MarketModeSet(m);
    }

    /// @dev DST shifts (13:30 vs 14:30 UTC) are pushed by the keeper; minutes are UTC.
    function setSchedule(uint16 open_, uint16 close_) external onlyOwnerOrKeeper {
        if (open_ >= close_ || close_ > 1440) revert BadSchedule();
        openMinute = open_;
        closeMinute = close_;
        emit ScheduleSet(open_, close_);
    }

    function isMarketOpen() public view returns (bool) {
        MarketMode m = marketMode;
        if (m == MarketMode.Open) return true;
        if (m == MarketMode.Closed) return false;
        // Calendar math, not randomness.
        // slither-disable-next-line weak-prng
        uint256 dow = (block.timestamp / 1 days + 4) % 7; // 0 = Sunday (1970-01-01 was Thursday)
        if (dow == 0 || dow == 6) return false;
        // slither-disable-next-line weak-prng
        uint256 minute = (block.timestamp % 1 days) / 60;
        return minute >= openMinute && minute < closeMinute;
    }

    function setFeed(address token, AggregatorV3Interface feed, uint32 maxStaleness) external onlyOwner {
        feeds[token] = Feed(feed, maxStaleness, feed.decimals(), IERC20Metadata(token).decimals());
        emit FeedSet(token, address(feed), maxStaleness);
    }

    /// @return price USD per 1 whole token, 8 decimals.
    function priceE8(address token) public view returns (uint256 price) {
        if (token == usdg) return 1e8;
        if (!isMarketOpen()) revert MarketClosed();
        Feed memory f = feeds[token];
        if (address(f.feed) == address(0)) revert NoFeed(token);
        (, int256 answer,, uint256 updatedAt,) = f.feed.latestRoundData();
        if (answer <= 0) revert BadPrice(token);
        if (block.timestamp > updatedAt + f.maxStaleness) revert StalePrice(token, updatedAt);
        price = uint256(answer);
        if (f.feedDecimals > 8) price /= 10 ** (f.feedDecimals - 8);
        else if (f.feedDecimals < 8) price *= 10 ** (8 - f.feedDecimals);
    }

    /// @return usd value with 6 decimals.
    function usdValue(address token, uint256 amount) public view returns (uint256 usd) {
        if (token == usdg) return amount; // 6dp, 1:1
        uint8 d = feeds[token].tokenDecimals;
        // amount * price(1e8) / 10^d -> 1e8 scale; /100 -> 1e6
        usd = amount * priceE8(token) / (10 ** d) / 100;
    }

    /// @notice Oracle-implied output for amountIn of tokenIn into tokenOut.
    function convert(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256) {
        uint8 dIn = tokenIn == usdg ? 6 : feeds[tokenIn].tokenDecimals;
        uint8 dOut = tokenOut == usdg ? 6 : feeds[tokenOut].tokenDecimals;
        return amountIn * priceE8(tokenIn) * (10 ** dOut) / priceE8(tokenOut) / (10 ** dIn);
    }
}
