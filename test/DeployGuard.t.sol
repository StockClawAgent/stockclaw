// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

contract DeployGuardTest is Test {
    Deploy d = new Deploy();

    function test_revertsOnLocalChain() public {
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, block.chainid));
        d.run();
    }

    function test_revertsOnMainnet4663() public {
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, uint256(4663)));
        d.run();
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, uint256(4663)));
        d.deployCore(address(this), address(1), address(2));
    }

    function testFuzz_revertsOnAnyOtherChain(uint64 id) public {
        vm.assume(id != 46630 && id != 0);
        vm.chainId(id);
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, uint256(id)));
        d.deployCore(address(this), address(1), address(2));
    }

    /// In-memory EVM simulation only (no RPC, no broadcast).
    function test_coreWiresOn46630() public {
        vm.chainId(46630);
        Deploy.Core memory c = d.deployCore(address(this), address(0x5AFE), address(2));
        assertEq(c.router.feeBps(), 30);
        assertEq(c.router.feeTreasury(), address(0x5AFE));
        assertEq(address(c.router.permit2()), d.PERMIT2());
    }
}
