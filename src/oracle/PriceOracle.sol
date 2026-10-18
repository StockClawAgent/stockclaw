// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice Token -> USD price registry over Chainlink-style feeds, with staleness checks.
/// USDG is pinned at $1.00 (documented assumption; replace with a USDG/USD feed if one exists).
/// All USD values are returned with 6 decimals (same as USDG) so "$100" == 100e6.
contract PriceOracle is Ownable2Step {
    struct Feed {
        AggregatorV3Interface feed; // 20
        uint32 maxStaleness; // 4
        uint8 feedDecimals; // 1
        uint8 tokenDecimals; // 1
    }

    address public immutable usdg;
    mapping(address token => Feed) public feeds;

    event FeedSet(address indexed token, address feed, uint32 maxStaleness);

    error NoFeed(address token);
    error StalePrice(address token, uint256 updatedAt);
    error BadPrice(address token);

    constructor(address owner_, address usdg_) Ownable(owner_) {
        usdg = usdg_;
    }

    function setFeed(address token, AggregatorV3Interface feed, uint32 maxStaleness) external onlyOwner {
        feeds[token] = Feed(feed, maxStaleness, feed.decimals(), IERC20Metadata(token).decimals());
        emit FeedSet(token, address(feed), maxStaleness);
    }

    /// @return price USD per 1 whole token, 8 decimals.
    function priceE8(address token) public view returns (uint256 price) {
        if (token == usdg) return 1e8;
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
