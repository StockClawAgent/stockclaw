// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITokenComplianceAdapter} from "../interfaces/ITokenComplianceAdapter.sol";
import {MockStockToken} from "./MockStockToken.sol";

/// @notice Example adapter for MockStockToken (the real one is written once issuer ABI is verified). TEST ONLY.
contract MockComplianceAdapter is ITokenComplianceAdapter {
    function check(address token, address from, address to, uint256)
        external
        view
        returns (bool, bytes32)
    {
        MockStockToken t = MockStockToken(token);
        if (t.paused()) return (false, "PAUSED");
        if (t.isFrozen(from) || t.isFrozen(to)) return (false, "FROZEN");
        return (true, bytes32(0));
    }
}
