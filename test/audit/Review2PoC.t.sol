// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Base.t.sol";
import {TokenTransfers} from "../../src/libraries/TokenTransfers.sol";
import {Deploy} from "../../script/Deploy.s.sol";

/// Gaius review-2 PoCs against 18c6f08, flipped by Quintus where fixed (N-1, N-2, N-5).
/// Unflipped tests still assert current (accepted / pending) behaviour.
contract Review2PoC is Base {
    AgentVault vault;
    uint256 agentPk = 0xA6E7;
    address agent;

    function setUp() public override {
        super.setUp();
        agent = vm.addr(agentPk);
        vault = new AgentVault(alice, router);
        vm.prank(alice);
        reg.linkAccount(address(vault));
        vm.prank(owner);
        usdg.mint(address(vault), 10_000e6);
        tsla.mint(address(vault), 10e18);
        vm.startPrank(alice);
        vault.grantAgent(agent, uint40(block.timestamp + 30 days));
        vault.setAllowedToken(address(usdg), true);
        vault.setAllowedToken(address(tsla), true);
        vm.stopPrank();
    }

    function _buy(uint256 amt) internal {
        vm.prank(agent);
        vault.agentSwap(address(pool), address(usdg), address(tsla), amt, 1, block.timestamp + 60);
    }

    // ---------------- Oracle
    // N-1 FIXED: time-scaled bound -> no move possible within one block
    function test_R2_oracleCompoundsInOneBlock() public {
        vm.startPrank(updater);
        vm.expectRevert();
        feed.updateAnswer(int256(PRICE) * 90 / 100);
        vm.stopPrank();
        assertEq(oracle.priceE8(address(tsla)), PRICE);
    }

    // N-1b FIXED: owner raising the limit still can't move price within one block; emits event
    function test_R2_ownerRaisesDelta() public {
        vm.prank(owner);
        feed.setMaxDelta(5_000, 5_000);
        vm.startPrank(updater);
        vm.expectRevert();
        feed.updateAnswer(int256(PRICE / 2));
        vm.stopPrank();
    }

    // Oracle sanity: zero / negative rejected at the feed; stale rejected at consumer
    function test_R2_oracleRejectsBadAndStale() public {
        vm.startPrank(updater);
        vm.expectRevert(MockAggregatorV3.InvalidAnswer.selector);
        feed.updateAnswer(0);
        vm.expectRevert(MockAggregatorV3.InvalidAnswer.selector);
        feed.updateAnswer(-1);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert();
        oracle.priceE8(address(tsla));
    }

    // N-1c: compounding a manipulated price within a block is no longer possible (see above).
    function test_R2_poolBandBlocksWhileOracleOff() public {
        vm.startPrank(updater);
        vm.expectRevert();
        feed.updateAnswer(int256(PRICE) * 90 / 100);
        vm.stopPrank();
    }

    // N-2 FIXED: EXACT deploy settings (oracle-anchored pool, 20 bps spread, 1h staleness, default
    // maxSlippage 300, fee 30) -> after a +1% oracle push, buys and sells both go through.
    function test_R2_band20bps_liveness() public {
        StockClawPool p20 = new StockClawPool(owner, address(tsla), address(usdg), oracle, 20);
        vm.startPrank(owner);
        p20.setRouter(address(router));
        router.setAdapter(address(p20), true);
        tsla.approve(address(p20), type(uint256).max);
        usdg.approve(address(p20), type(uint256).max);
        vm.stopPrank();
        tsla.mint(owner, 1_000e18);
        vm.prank(owner);
        p20.addLiquidity(1_000e18, 250_000e6);
        _setPrice(PRICE * 101 / 100);
        FeeRouter.SwapParams memory sp = _params(address(usdg), address(tsla), 100e6, 1, alice);
        sp.adapter = address(p20);
        vm.prank(alice);
        assertGt(router.swap(sp), 0);
        sp.tokenIn = address(tsla); sp.tokenOut = address(usdg); sp.amountIn = 0.4e18;
        vm.prank(alice);
        assertGt(router.swap(sp), 0);
        // and a further -5% push one hour later still trades
        _setPrice(PRICE * 96 / 100);
        sp.deadline = block.timestamp + 60;
        vm.prank(alice);
        assertGt(router.swap(sp), 0);
    }

    // ---------------- Rolling window (25 hourly buckets)
    function test_R2_window_blockedFor24hFreedBy25h() public {
        uint256 h = (block.timestamp / 1 hours + 1) * 1 hours;
        vm.warp(h + 59 minutes); _setPrice(PRICE);           // spend at the END of hour H
        for (uint256 k; k < 5; k++) _buy(100e6);
        vm.warp(h + 59 minutes + 24 hours - 1); _setPrice(PRICE);
        vm.prank(agent);
        vm.expectRevert();
        vault.agentSwap(address(pool), address(usdg), address(tsla), 1e6, 1, block.timestamp + 60);
        vm.warp(h + 25 hours); _setPrice(PRICE);            // first second bucket H ages out
        _buy(100e6);
        (uint256 left,) = vault.remainingToday(agent);
        assertEq(left, 400e6);
    }

    // stale bucket reuse: ring index cur%25 reused exactly 25h later must reset, not accumulate
    function test_R2_window_staleBucketReset() public {
        uint256 h = (block.timestamp / 1 hours + 1) * 1 hours;
        vm.warp(h); _setPrice(PRICE);
        _buy(100e6);
        vm.warp(h + 25 hours); _setPrice(PRICE);             // same ring slot
        _buy(100e6);
        assertEq(vault.spentLast24h(agent), 100e6);
        vm.warp(h + 50 hours); _setPrice(PRICE);
        assertEq(vault.spentLast24h(agent), 0);
    }

    // any 24h period sums <= cap: spread spends every hour for 60h, never exceeds 500
    function test_R2_window_neverExceedsInAny24h() public {
        uint256 h = (block.timestamp / 1 hours + 1) * 1 hours;
        uint256[60] memory spent;
        for (uint256 t; t < 60; t++) {
            vm.warp(h + t * 1 hours + 30 minutes); _setPrice(PRICE);
            (uint256 left,) = vault.remainingToday(agent);
            uint256 amt = left >= 100e6 ? 100e6 : left;
            if (amt > 0) { _buy(amt); spent[t] = amt; }
        }
        for (uint256 s; s + 24 <= 60; s++) {
            uint256 sum;
            for (uint256 t = s; t < s + 24; t++) sum += spent[t];
            assertLe(sum, 500e6);
        }
    }

    // ---------------- DCA
    // Info: no catch-up, but a late slice + boundary-aligned next slice can run ~1s apart.
    function test_R2_dca_lateSliceThenBoundary() public {
        uint40 start = uint40(block.timestamp);
        FeeRouter.Intent memory i = FeeRouter.Intent(address(vault), address(usdg), address(tsla), address(pool),
            100e6, 1, 0, 1 days, 10, 300, start, uint40(block.timestamp + 30 days), 7);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.warp(start + 2 days - 1); _setPrice(PRICE);
        vm.prank(keeper); vault.executeIntent(i, sig);
        vm.warp(start + 2 days); _setPrice(PRICE);
        vm.prank(keeper); vault.executeIntent(i, sig);   // second slice 1s later
        assertEq(router.execCount(router.hashIntent(i)), 2);
    }

    // ---------------- Fee leg
    // M-5 still open: frozen treasury blocks every stock sell (clean error, but DoS); precheck only
    // sees it when a compliance adapter is configured (default none).
    function test_R2_feeLegFreezeStillDoS() public {
        tsla.setFrozen(safe, true);
        assertTrue(router.precheck(alice, address(tsla), address(usdg), 1e18, alice));
        vm.prank(alice);
        vm.expectPartialRevert(TokenTransfers.TransferBlocked.selector);
        router.swap(_params(address(tsla), address(usdg), 1e18, 1, alice));
    }

    // Deploy guard: MOCK_TOKENS path cannot run off-testnet
    function test_R2_mockDeployGuardedOffTestnet() public {
        Deploy d = new Deploy();
        vm.setEnv("MOCK_TOKENS", "1");
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, uint256(1)));
        d.run();
        vm.setEnv("MOCK_TOKENS", "0");
    }
}
