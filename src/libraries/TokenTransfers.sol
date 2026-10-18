// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice SafeERC20-equivalent transfers that convert ANY failure (revert, false return, no code)
/// into one clear error. Restricted stock tokens revert on freeze/pause/registry with unknown
/// selectors; we treat every such revert as "blocked" and keep the issuer's revert data.
library TokenTransfers {
    error TransferBlocked(address token, address from, address to, bytes reason);

    function transfer(address token, address to, uint256 amount) internal {
        _call(token, address(this), to, abi.encodeWithSelector(0xa9059cbb, to, amount));
    }

    function transferFrom(address token, address from, address to, uint256 amount) internal {
        _call(token, from, to, abi.encodeWithSelector(0x23b872dd, from, to, amount));
    }

    function _call(address token, address from, address to, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || token.code.length == 0 || (ret.length != 0 && (ret.length < 32 || !abi.decode(ret, (bool))))) {
            revert TransferBlocked(token, from, to, ret);
        }
    }
}
