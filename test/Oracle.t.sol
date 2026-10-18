// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";

contract OracleTest is Base {

    function _at(uint256 t) internal {
        vm.warp(t);
        _setPrice(PRICE);
        _eligible(alice);
    }

    // 2026-11-02 (Mon, after US DST ends): regular session 09:30-16:00 ET = 14:30-21:00 UTC
    uint256 constant NOV2 = 1793577600; // 2026-11-02 00:00 UTC
    uint256 constant NOV26 = 1795651200; // 2026-11-26 00:00 UTC (Thanksgiving)

    function _session() internal {
        vm.startPrank(owner);
        oracle.setKeeper(keeper);
        oracle.setMarketMode(PriceOracle.MarketMode.Session);
        vm.stopPrank();
    }

    function test_session_postDST_nov2() public {
        _session();
        _at(NOV2 + 6 hours); // keeper pushes in the morning
        vm.prank(keeper);
        oracle.setSession(uint64(NOV2 + 14 hours + 30 minutes), uint64(NOV2 + 21 hours));
        _at(NOV2 + 13 hours + 45 minutes); // old EDT hours -> must be CLOSED
        assertFalse(oracle.isMarketOpen());
        vm.prank(alice);
        vm.expectRevert(FeeRouter.MarketClosed.selector);
        router.swap(_params(address(usdg), address(tsla), 100e6, 1, alice));
        _at(NOV2 + 14 hours + 30 minutes);
        assertTrue(oracle.isMarketOpen());
        vm.prank(alice);
        router.swap(_params(address(usdg), address(tsla), 100e6, 1, alice));
        _at(NOV2 + 21 hours - 1);
        assertTrue(oracle.isMarketOpen());
        _at(NOV2 + 21 hours);
        assertFalse(oracle.isMarketOpen());
        vm.expectRevert(PriceOracle.MarketClosed.selector);
        oracle.priceE8(address(tsla));
        assertEq(oracle.priceE8(address(usdg)), 1e8); // USDG unaffected
    }

    function test_session_thanksgiving_noSessionPushed_closedAllDay() public {
        _session();
        _at(NOV26 - 3 days + 15 hours); // Mon Nov 23 session pushed and expired
        vm.prank(keeper);
        oracle.setSession(uint64(NOV26 - 3 days + 14 hours + 30 minutes), uint64(NOV26 - 3 days + 21 hours));
        for (uint256 h; h < 24; h++) {
            _at(NOV26 + h * 1 hours);
            assertFalse(oracle.isMarketOpen());
        }
    }

    function test_session_staleYesterday_closed() public {
        _session();
        _at(NOV2 + 15 hours);
        vm.prank(keeper);
        oracle.setSession(uint64(NOV2 + 14 hours + 30 minutes), uint64(NOV2 + 21 hours));
        assertTrue(oracle.isMarketOpen());
        _at(NOV2 + 1 days + 15 hours); // next day, keeper failed to push
        assertFalse(oracle.isMarketOpen());
    }

    function test_session_noSessionEver_closed() public {
        _session();
        _at(NOV2 + 15 hours);
        assertFalse(oracle.isMarketOpen());
    }

    function test_session_validation() public {
        _session();
        _at(NOV2 + 6 hours);
        vm.startPrank(keeper);
        vm.expectRevert(PriceOracle.BadSession.selector); // > 8h window
        oracle.setSession(uint64(NOV2 + 12 hours), uint64(NOV2 + 20 hours + 1));
        oracle.setSession(uint64(NOV2 + 12 hours), uint64(NOV2 + 20 hours)); // exactly 8h ok
        vm.expectRevert(PriceOracle.BadSession.selector); // close <= open
        oracle.setSession(uint64(NOV2 + 14 hours), uint64(NOV2 + 14 hours));
        vm.expectRevert(PriceOracle.BadSession.selector); // in the past
        oracle.setSession(uint64(NOV2 + 1 hours), uint64(NOV2 + 6 hours));
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(PriceOracle.NotOwnerOrKeeper.selector);
        oracle.setSession(uint64(NOV2 + 14 hours), uint64(NOV2 + 15 hours));
    }

    function test_emergencyModes_ownerOnly() public {
        _session();
        _at(NOV2 + 15 hours);
        vm.prank(keeper);
        oracle.setSession(uint64(NOV2 + 14 hours + 30 minutes), uint64(NOV2 + 21 hours));
        vm.prank(keeper);
        vm.expectRevert();
        oracle.setMarketMode(PriceOracle.MarketMode.ForceOpen);
        vm.prank(owner);
        oracle.setMarketMode(PriceOracle.MarketMode.ForceClosed);
        assertFalse(oracle.isMarketOpen()); // overrides a live session
        vm.prank(owner);
        oracle.setMarketMode(PriceOracle.MarketMode.ForceOpen); // testnet/demo only
        _at(NOV26 + 3 hours);
        assertTrue(oracle.isMarketOpen());
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

    function test_N1_timeScaledDelta() public {
        // same block: no move allowed at all
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(MockAggregatorV3.DeltaTooLarge.selector, int256(PRICE), int256(PRICE + 1e8)));
        feed.updateAnswer(int256(PRICE + 1e8));
        // 30 min later: 5% allowed (10%/h)
        vm.warp(block.timestamp + 30 minutes);
        assertEq(feed.allowedDeltaBps(), 500);
        vm.prank(updater);
        vm.expectRevert();
        feed.updateAnswer(int256(PRICE * 10_501 / 10_000));
        vm.prank(updater);
        feed.updateAnswer(int256(PRICE * 105 / 100));
        // cap: after 5h allowance is capped at 20%
        vm.warp(block.timestamp + 5 hours);
        assertEq(feed.allowedDeltaBps(), 2_000);
        // 60s keeper cadence: ~0.166% per push
        vm.warp(block.timestamp - 5 hours + 60); // (time travel only for the view)
        assertEq(feed.allowedDeltaBps(), 16);
    }

    function test_N1_compoundingInOneBlockImpossible() public {
        vm.warp(block.timestamp + 1 hours);
        vm.startPrank(updater);
        feed.updateAnswer(int256(PRICE * 90 / 100)); // first -10% ok after 1h
        vm.expectRevert();
        feed.updateAnswer(int256(PRICE * 81 / 100)); // second in same block: elapsed 0
        vm.stopPrank();
    }

    function test_nonPositiveAnswerRejected() public {
        vm.prank(updater);
        vm.expectRevert(MockAggregatorV3.InvalidAnswer.selector);
        feed.updateAnswer(0);
    }

    function test_maxDelta_ownerSettable_boundaries_andEvent() public {
        vm.expectEmit(address(feed));
        emit MockAggregatorV3.MaxDeltaSet(500, 1_000);
        vm.prank(owner);
        feed.setMaxDelta(500, 1_000); // 5%/h, cap 10%
        vm.warp(block.timestamp + 1 hours);
        vm.prank(updater);
        feed.updateAnswer(int256(PRICE * 105 / 100)); // exactly +5% after 1h: ok
        int256 cur = int256(PRICE * 105 / 100);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(MockAggregatorV3.DeltaTooLarge.selector, cur, cur * 10_501 / 10_000));
        feed.updateAnswer(cur * 10_501 / 10_000); // +5.01%: revert
        vm.prank(bob);
        vm.expectRevert();
        feed.setMaxDelta(1_000, 1_000);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(MockAggregatorV3.DeltaOutOfBounds.selector, uint16(0), uint16(100)));
        feed.setMaxDelta(0, 100);
        vm.expectRevert(abi.encodeWithSelector(MockAggregatorV3.DeltaOutOfBounds.selector, uint16(100), uint16(5_001)));
        feed.setMaxDelta(100, 5_001);
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
