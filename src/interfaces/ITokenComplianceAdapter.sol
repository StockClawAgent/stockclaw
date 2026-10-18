// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Optional, per-token compliance pre-check. Default: none configured (the transfer itself
/// is the source of truth and a revert is surfaced as `TransferBlocked`). Implement one adapter per
/// issuer once Robinhood's real stock-token restriction functions are verified.
interface ITokenComplianceAdapter {
    /// @return ok whether `from -> to` of `amount` should succeed; reason an issuer-specific code.
    function check(address token, address from, address to, uint256 amount)
        external
        view
        returns (bool ok, bytes32 reason);
}
