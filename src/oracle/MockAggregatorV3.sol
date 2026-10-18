// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice Chainlink-compatible feed pushed by our keeper (updater-only). Testnet stand-in until
/// real stock/USD feeds are confirmed on 46630. Staleness is enforced by consumers (OracleLib).
contract MockAggregatorV3 is AggregatorV3Interface, Ownable {
    uint8 public immutable decimals;
    string public description;
    address public updater;

    uint80 internal _round;
    int256 internal _answer;
    uint64 internal _updatedAt;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);
    event UpdaterSet(address updater);

    error NotUpdater();
    error InvalidAnswer();

    constructor(address owner_, address updater_, uint8 decimals_, string memory description_) Ownable(owner_) {
        updater = updater_;
        decimals = decimals_;
        description = description_;
    }

    function setUpdater(address u) external onlyOwner {
        updater = u;
        emit UpdaterSet(u);
    }

    function updateAnswer(int256 answer) external {
        if (msg.sender != updater) revert NotUpdater();
        if (answer <= 0) revert InvalidAnswer();
        _round++;
        _answer = answer;
        _updatedAt = uint64(block.timestamp);
        emit AnswerUpdated(answer, _round, block.timestamp);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_round, _answer, _updatedAt, _updatedAt, _round);
    }
}
