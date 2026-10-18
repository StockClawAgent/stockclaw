// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice Chainlink-compatible feed pushed by our keeper (updater-only). Testnet stand-in until
/// real stock/USD feeds are confirmed on 46630. Staleness is enforced by consumers (OracleLib).
contract MockAggregatorV3 is AggregatorV3Interface, Ownable2Step {
    uint8 public immutable decimals;
    string public description;
    address public updater;
    /// N-1: time-scaled move limit. An update may move the price by at most
    ///   min(maxDeltaBpsPerHour * elapsed / 1h, maxDeltaCapBps)
    /// vs. the last accepted answer, where elapsed = time since that answer. Multiple updates in one
    /// block (elapsed 0) cannot move the price at all, so one-block compounding is impossible.
    /// A rejected push leaves the feed untouched; the allowance grows until the next push, or the
    /// feed goes stale (>1h in PriceOracle) and trading halts (fail closed).
    uint16 public maxDeltaBpsPerHour = 1_000; // 10% / hour
    uint16 public maxDeltaCapBps = 2_000; // never more than 20% in one update

    uint80 internal _round;
    int256 internal _answer;
    uint64 internal _updatedAt;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);
    event UpdaterSet(address updater);
    event MaxDeltaSet(uint16 perHourBps, uint16 capBps);

    error NotUpdater();
    error InvalidAnswer();
    error DeltaTooLarge(int256 previous, int256 answer);

    constructor(address owner_, address updater_, uint8 decimals_, string memory description_) Ownable(owner_) {
        updater = updater_;
        decimals = decimals_;
        description = description_;
    }

    function setUpdater(address u) external onlyOwner {
        updater = u;
        emit UpdaterSet(u);
    }

    error DeltaOutOfBounds(uint16 perHourBps, uint16 capBps);

    /// @notice Owner-set: perHour in (0, 5000], cap in [perHour/60, 5000] bps (cap >= 1 min of drift).
    function setMaxDelta(uint16 perHourBps, uint16 capBps) external onlyOwner {
        if (perHourBps == 0 || perHourBps > 5_000 || capBps == 0 || capBps > 5_000) {
            revert DeltaOutOfBounds(perHourBps, capBps);
        }
        maxDeltaBpsPerHour = perHourBps;
        maxDeltaCapBps = capBps;
        emit MaxDeltaSet(perHourBps, capBps);
    }

    /// @notice Max allowed move (bps) for an update at the current time.
    function allowedDeltaBps() public view returns (uint256 bps) {
        bps = uint256(maxDeltaBpsPerHour) * (block.timestamp - _updatedAt) / 1 hours;
        if (bps > maxDeltaCapBps) bps = maxDeltaCapBps;
    }

    function updateAnswer(int256 answer) external {
        if (msg.sender != updater) revert NotUpdater();
        if (answer <= 0) revert InvalidAnswer();
        int256 prev = _answer;
        if (prev > 0) {
            int256 diff = answer > prev ? answer - prev : prev - answer;
            if (diff * 10_000 > prev * int256(allowedDeltaBps())) revert DeltaTooLarge(prev, answer);
        }
        _round++;
        _answer = answer;
        _updatedAt = uint64(block.timestamp);
        emit AnswerUpdated(answer, _round, block.timestamp);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_round, _answer, _updatedAt, _updatedAt, _round);
    }
}
