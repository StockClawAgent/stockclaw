// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";

contract PoolTest is Base {
    function test_onlyRouter() public {
        vm.expectRevert(StockClawPool.OnlyRouter.selector);
        pool.swap(address(usdg), address(tsla), 1, 0, alice);
    }

    function test_liquidityCap() public {
        // 250k USDG buys ~1000 TSLA > reserve(1000) after spread? 300k definitely exceeds.
        vm.prank(owner);
        usdg.mint(alice, 300_000e6);
        vm.prank(alice);
        vm.expectPartialRevert(FeeRouter.AdapterSwapFailed.selector);
        router.swap(_params(address(usdg), address(tsla), 300_000e6, 1, alice));
        vm.expectPartialRevert(StockClawPool.InsufficientLiquidity.selector);
        pool.quote(address(usdg), address(tsla), 300_000e6);
    }

    function test_followsOracle_noPriceImpact() public {
        uint256 q1 = pool.quote(address(usdg), address(tsla), 1_000e6);
        vm.prank(alice);
        router.swap(_params(address(usdg), address(tsla), 10_000e6, 1, alice));
        assertEq(pool.quote(address(usdg), address(tsla), 1_000e6), q1); // no curve
        _setPrice(260e8);
        assertLt(pool.quote(address(usdg), address(tsla), 1_000e6), q1);
    }

    function test_spreadBounds() public {
        vm.startPrank(owner);
        pool.setSpread(10);
        pool.setSpread(30);
        vm.expectRevert(abi.encodeWithSelector(StockClawPool.InvalidSpread.selector, uint16(9)));
        pool.setSpread(9);
        vm.expectRevert(abi.encodeWithSelector(StockClawPool.InvalidSpread.selector, uint16(31)));
        pool.setSpread(31);
        vm.stopPrank();
        vm.expectRevert();
        pool.setSpread(20);
    }

    function test_marketClosedHaltsQuote() public {
        vm.prank(owner);
        oracle.setMarketMode(PriceOracle.MarketMode.Closed);
        vm.expectRevert(PriceOracle.MarketClosed.selector);
        pool.quote(address(usdg), address(tsla), 1e6);
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

    function testFuzz_valueAtOracleNonDecreasing(uint256 a, uint256 b, bool dir, uint16 spread) public {
        a = bound(a, 1e6, 50_000e6);
        b = bound(b, 1e15, 50e18);
        spread = uint16(bound(spread, 10, 30));
        vm.prank(owner);
        pool.setSpread(spread);
        uint256 v0 = pool.valueUsd();
        vm.startPrank(alice);
        if (dir) {
            router.swap(_params(address(usdg), address(tsla), a, 1, alice));
            router.swap(_params(address(tsla), address(usdg), b, 1, alice));
        } else {
            router.swap(_params(address(tsla), address(usdg), b, 1, alice));
            router.swap(_params(address(usdg), address(tsla), a, 1, alice));
        }
        vm.stopPrank();
        assertGe(pool.valueUsd() + 1, v0); // +1 for usdValue rounding
        assertEq(tsla.balanceOf(address(pool)), pool.reserveStock());
        assertEq(usdg.balanceOf(address(pool)), pool.reserveUsdg());
    }
}
