// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";

contract OracleTest is Base {
    // 2026-10-19 is a Monday. 00:00 UTC = 1792368000
    uint256 constant MON = 1792368000;

    function _at(uint256 t) internal {
        vm.warp(t);
        _setPrice(PRICE);
        _eligible(alice);
    }

    function test_schedule_weekdaySession() public {
        vm.prank(owner);
        oracle.setMarketMode(PriceOracle.MarketMode.Schedule);
        _at(MON + 13 hours + 29 minutes);
        assertFalse(oracle.isMarketOpen());
        _at(MON + 13 hours + 30 minutes);
        assertTrue(oracle.isMarketOpen());
        _at(MON + 20 hours - 1);
        assertTrue(oracle.isMarketOpen());
        _at(MON + 20 hours);
        assertFalse(oracle.isMarketOpen());
        vm.expectRevert(PriceOracle.MarketClosed.selector);
        oracle.priceE8(address(tsla));
        assertEq(oracle.priceE8(address(usdg)), 1e8); // USDG unaffected
    }

    function test_schedule_weekendClosed() public {
        vm.prank(owner);
        oracle.setMarketMode(PriceOracle.MarketMode.Schedule);
        _at(MON - 2 days + 15 hours); // Saturday 15:00 UTC
        assertFalse(oracle.isMarketOpen());
        _at(MON - 1 days + 15 hours); // Sunday
        assertFalse(oracle.isMarketOpen());
        _at(MON + 4 days + 15 hours); // Friday
        assertTrue(oracle.isMarketOpen());
    }

    function test_offHours_swapHalts() public {
        vm.prank(owner);
        oracle.setMarketMode(PriceOracle.MarketMode.Schedule);
        _at(MON + 22 hours);
        vm.prank(alice);
        vm.expectRevert(FeeRouter.MarketClosed.selector);
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
        _at(MON + 1 days + 14 hours);
        vm.prank(alice);
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
    }

    function test_keeperCanSetMode_othersCannot() public {
        vm.prank(owner);
        oracle.setKeeper(keeper);
        vm.prank(keeper);
        oracle.setMarketMode(PriceOracle.MarketMode.Closed);
        assertFalse(oracle.isMarketOpen());
        vm.prank(keeper);
        oracle.setSchedule(14 * 60 + 30, 21 * 60); // EST shift
        vm.prank(bob);
        vm.expectRevert(PriceOracle.NotOwnerOrKeeper.selector);
        oracle.setMarketMode(PriceOracle.MarketMode.Open);
        vm.prank(owner);
        vm.expectRevert(PriceOracle.BadSchedule.selector);
        oracle.setSchedule(600, 600);
    }

    function test_staleness1hHalt() public {
        vm.warp(block.timestamp + 1 hours);
        oracle.priceE8(address(tsla)); // exactly 1h: ok
        vm.warp(block.timestamp + 1);
        vm.expectRevert();
        oracle.priceE8(address(tsla));
    }

    function test_feedUpdaterOnly() public {
        vm.prank(bob);
        vm.expectRevert(MockAggregatorV3.NotUpdater.selector);
        feed.updateAnswer(1);
    }

    function test_L3_maxDeltaPerUpdate() public {
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(MockAggregatorV3.DeltaTooLarge.selector, int256(PRICE), int256(2.5e8)));
        feed.updateAnswer(2.5e8); // 100x drop
        vm.prank(updater);
        feed.updateAnswer(int256(PRICE * 110 / 100)); // +10% ok
    }

    function test_nonPositiveAnswerRejected() public {
        vm.prank(updater);
        vm.expectRevert(MockAggregatorV3.InvalidAnswer.selector);
        feed.updateAnswer(0);
    }

    function test_maxDelta_ownerSettable_boundaries() public {
        vm.prank(owner);
        feed.setMaxDeltaBps(500); // 5%
        vm.prank(updater);
        feed.updateAnswer(int256(PRICE * 105 / 100)); // exactly +5%: ok
        int256 cur = int256(PRICE * 105 / 100);
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(MockAggregatorV3.DeltaTooLarge.selector, cur, cur * 10_501 / 10_000));
        feed.updateAnswer(cur * 10_501 / 10_000); // +5.01%: revert
        vm.prank(bob);
        vm.expectRevert();
        feed.setMaxDeltaBps(10_000);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(MockAggregatorV3.DeltaOutOfBounds.selector, uint16(0)));
        feed.setMaxDeltaBps(0);
        vm.expectRevert(abi.encodeWithSelector(MockAggregatorV3.DeltaOutOfBounds.selector, uint16(5_001)));
        feed.setMaxDeltaBps(5_001);
        vm.stopPrank();
    }

    function test_rejectedUpdate_leavesFeedStale_thenHalts() public {
        // a rejected jump doesn't refresh updatedAt -> after 1h trading halts (fail closed)
        vm.warp(block.timestamp + 50 minutes);
        vm.prank(updater);
        vm.expectRevert();
        feed.updateAnswer(int256(PRICE * 2));
        vm.warp(block.timestamp + 11 minutes);
        vm.expectRevert(abi.encodeWithSelector(PriceOracle.StalePrice.selector, address(tsla), block.timestamp - 61 minutes));
        oracle.priceE8(address(tsla));
    }
}
