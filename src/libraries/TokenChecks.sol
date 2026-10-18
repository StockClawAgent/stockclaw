// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRestrictedToken} from "../interfaces/IRestrictedToken.sol";

/// @notice Best-effort pre-flight checks for issuer-restricted tokens. Every probe is wrapped in
/// try/catch: a token without the function (or that reverts) is treated as "no restriction known".
/// The actual transfer remains the source of truth; these only produce cleaner errors earlier.
library TokenChecks {
    error TokenPaused(address token);
    error AccountFrozen(address token, address account);
    error TransferRestricted(address token, address from, address to);

    function isPaused(address token) internal view returns (bool) {
        try IRestrictedToken(token).paused() returns (bool p) {
            return p;
        } catch {
            return false;
        }
    }

    function isFrozen(address token, address account) internal view returns (bool) {
        try IRestrictedToken(token).isFrozen(account) returns (bool f) {
            return f;
        } catch {
            return false;
        }
    }

    function canTransfer(address token, address from, address to, uint256 amount) internal view returns (bool) {
        if (isPaused(token) || isFrozen(token, from) || isFrozen(token, to)) return false;
        try IRestrictedToken(token).canTransfer(from, to, amount) returns (bool ok) {
            return ok;
        } catch {
            return true;
        }
    }

    function requireTransferable(address token, address from, address to, uint256 amount) internal view {
        if (isPaused(token)) revert TokenPaused(token);
        if (isFrozen(token, from)) revert AccountFrozen(token, from);
        if (isFrozen(token, to)) revert AccountFrozen(token, to);
        try IRestrictedToken(token).canTransfer(from, to, amount) returns (bool ok) {
            if (!ok) revert TransferRestricted(token, from, to);
        } catch {}
    }
}
