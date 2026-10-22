// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Base.t.sol";

/// Gaius review-3: oracle rate limit (N-1) and oracle-anchored pool (N-2) properties.
contract Review3 is Base {
    function _push(uint256 p) internal { vm.prank(updater); feed.updateAnswer(int256(p)); }

    // ------------------------------------------------ N-1 oracle rate limit
    function test_sameBlockChangeReverts() public {
        vm.warp(block.timestamp + 1 hours);
        _push(PRICE * 105 / 100); // 5% after 1h ok
        vm.expectRevert(); // elapsed 0 => allowed 0 bps: no in-block compounding
        _push(PRICE * 106 / 100);
    }

    function test_idleThenCapAt20pct() public {
        vm.warp(block.timestamp + 5 hours); // would be 50% linear; capped at 20%
        vm.expectRevert();
        _push(PRICE * 121 / 100);
        _push(PRICE * 120 / 100);
    }

    /// FINDING R3-4 (info): 30 pushes/hour compound >10%/h; 24h ~ 9.8x upward walk.
    function test_compoundingPerHour() public {
        uint256 p = PRICE;
        uint256 t = block.timestamp;
        for (uint256 k; k < 30; k++) {
            t += 120; vm.warp(t);
            p = p * (10_000 + 32) / 10_000; // 0.32% per 2 min (allowed 33 bps)
            _push(p);
        }
        assertGt(p, PRICE * 110 / 100); // > 10% inside one hour
        assertLt(p, PRICE * 111 / 100);
    }

    function test_oneSecondAllowsTinyMove() public {
        vm.warp(block.timestamp + 36); // 1000 bps/h * 36s = 10 bps
        _push(PRICE * 10_010 / 10_000);
        vm.warp(block.timestamp + 36);
        vm.expectRevert();
        _push(PRICE * 10_010 / 10_000 * 10_011 / 10_000);
    }

    // ------------------------------------------------ N-2 oracle-anchored pool
    /// Pool value at oracle price never decreases on a router swap (spread accrues to pool).
    function testFuzz_poolValueNonDecreasing(uint256 amt, bool buy) public {
        uint256 v0 = pool.valueUsd();
        if (buy) {
            amt = bound(amt, 1e6, 50_000e6);
            vm.prank(alice); router.swap(_params(address(usdg), address(tsla), amt, 0, alice));
        } else {
            amt = bound(amt, 1e15, 90e18);
            vm.prank(alice); router.swap(_params(address(tsla), address(usdg), amt, 0, alice));
        }
        assertGe(pool.valueUsd(), v0);
    }

    /// FINDING R3-2: inventory sells at the (possibly lagging) oracle with no size/inventory limit.
    /// If the true price is X% above the oracle, an eligible trader buys the whole stock side at
    /// X% - (fee+spread) discount. Here: true price +10% (oracle lags 1h), trader buys out the pool.
    function test_FINDING_lagArbDrainsInventory() public {
        uint256 stockBefore = tsla.balanceOf(address(pool));
        uint256 cost = 0; uint256 got = 0;
        uint256 b0 = tsla.balanceOf(alice);
        vm.prank(owner); usdg.mint(alice, 300_000e6);
        uint256 amt = 240_000e6; // ~ entire 1,000 TSLA side at $250
        vm.prank(alice); router.swap(_params(address(usdg), address(tsla), amt, 0, alice));
        got = tsla.balanceOf(alice) - b0; cost = amt;
        assertGt(got, stockBefore * 90 / 100); // >90% of inventory in one tx
        uint256 trueValue = got * (PRICE * 110 / 100) / 1e8 / 1e12; // USD 6dp at "true" price
        assertGt(trueValue, cost * 109 / 100 - cost * 50 / 10_000 - cost); // profit ≈ 10% - 50 bps
        assertGt(trueValue, cost); // profitable
    }

    /// R3-3 (low) FIXED with F1: tokens sent directly to the pool are NOT credited to the next swap.
    function test_FIXED_donationNotCreditedToNextSwapper() public {
        vm.prank(alice); usdg.transfer(address(pool), 1_000e6); // stray transfer
        uint256 q = pool.quote(address(usdg), address(tsla), uint256(10e6) - uint256(10e6) * router.feeBps() / 10_000);
        uint256 b0 = tsla.balanceOf(bob);
        _eligible(bob);
        vm.prank(owner); usdg.mint(bob, 10e6);
        vm.startPrank(bob); usdg.approve(address(router), 10e6);
        router.swap(_params(address(usdg), address(tsla), 10e6, 0, bob)); vm.stopPrank();
        assertEq(tsla.balanceOf(bob) - b0, q); // bob gets exactly the quote for his $10
    }
}
