// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Optional surface of Robinhood Chain stock tokens (assumed; confirm against real ABI).
/// All calls are made via try/catch so tokens that don't implement them still work.
interface IRestrictedToken {
    function paused() external view returns (bool);
    function isFrozen(address account) external view returns (bool);
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);
}
