// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";

contract PoolTest is Base {
    function test_onlyRouter() public {
        vm.expectRevert(StockClawPool.OnlyRouter.selector);
        pool.swap(address(usdg), address(tsla), 1, 0, alice);
    }

    function test_oracleBand_bigTradeReverts() public {
        vm.prank(alice);
        vm.expectRevert(); // OutsideOracleBand
        router.swap(_params(address(usdg), address(tsla), 50_000e6, 0, alice));
    }

    function test_staleOracleBlocksSwaps() public {
        vm.warp(block.timestamp + 2 hours);
        vm.prank(alice);
        vm.expectRevert();
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
    }

    function test_badPair() public {
        vm.expectRevert(StockClawPool.BadPair.selector);
        pool.quote(address(usdg), address(usdg), 1);
    }

    function testFuzz_kNonDecreasing(uint256 a, uint256 b, bool dir) public {
        a = bound(a, 1e6, 5_000e6);
        b = bound(b, 1e15, 10e18);
        uint256 k0 = uint256(pool.reserveStock()) * pool.reserveUsdg();
        vm.startPrank(alice);
        if (dir) {
            router.swap(_params(address(usdg), address(tsla), a, 0, alice));
            router.swap(_params(address(tsla), address(usdg), b, 0, alice));
        } else {
            router.swap(_params(address(tsla), address(usdg), b, 0, alice));
            router.swap(_params(address(usdg), address(tsla), a, 0, alice));
        }
        vm.stopPrank();
        uint256 k1 = uint256(pool.reserveStock()) * pool.reserveUsdg();
        assertGe(k1, k0);
        assertEq(tsla.balanceOf(address(pool)), pool.reserveStock());
        assertEq(usdg.balanceOf(address(pool)), pool.reserveUsdg());
    }
}
