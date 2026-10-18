// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Base.t.sol";

/// Gaius review-4: stock->USDG exit exemption (5491737) and N-4 route check (8c0bc7b).
contract Review4 is Base {
    AgentVault vault;
    uint256 agentPk = 0xA6E7;
    address agent;
    MockStockToken amd;
    MockAggregatorV3 amdFeed;
    StockClawPool amdPool;

    function setUp() public override {
        super.setUp();
        agent = vm.addr(agentPk);
        amd = new MockStockToken("AMD (test)", "AMD");
        amdFeed = new MockAggregatorV3(owner, updater, 8, "AMD / USD");
        vm.prank(updater); amdFeed.updateAnswer(150e8);
        amdPool = new StockClawPool(owner, address(amd), address(usdg), oracle, 20);
        vm.startPrank(owner);
        oracle.setFeed(address(amd), amdFeed, 1 hours);
        router.setAdapter(address(amdPool), true);
        amdPool.setRouter(address(router));
        vm.stopPrank();
        amd.mint(owner, 1_000e18);
        vm.startPrank(owner);
        amd.approve(address(amdPool), type(uint256).max);
        usdg.approve(address(amdPool), type(uint256).max);
        amdPool.addLiquidity(1_000e18, 150_000e6);
        vm.stopPrank();

        vault = new AgentVault(alice, router);
        vm.prank(alice); reg.linkAccount(address(vault));
        vm.prank(owner); usdg.mint(address(vault), 10_000e6);
        tsla.mint(address(vault), 40e18); // $10,000 of TSLA
        amd.mint(address(vault), 10e18);
        vm.startPrank(alice);
        vault.grantAgent(agent, uint40(block.timestamp + 7 days));
        vault.setAllowedToken(address(usdg), true);
        vault.setAllowedToken(address(tsla), true);
        vault.setAllowedToken(address(amd), true);
        vm.stopPrank();
    }

    function _sell(address adapter, address tin, uint256 amt) internal returns (uint256) {
        vm.prank(agent);
        return vault.agentSwap(adapter, tin, address(usdg), amt, 1, block.timestamp + 60);
    }
    function _buy(uint256 usd) internal {
        vm.prank(agent);
        vault.agentSwap(address(pool), address(usdg), address(tsla), usd, 1, block.timestamp + 60);
    }

    // ------------------------------------------------ classification
    function test_classification() public view {
        assertTrue(vault.isExemptExit(address(pool), address(tsla), address(usdg)));
        assertFalse(vault.isExemptExit(address(pool), address(usdg), address(tsla)));       // buy
        assertFalse(vault.isExemptExit(address(pool), address(amd), address(usdg)));        // wrong pool for pair
        assertFalse(vault.isExemptExit(address(amdPool), address(tsla), address(usdg)));
        assertFalse(vault.isExemptExit(address(pool), address(tsla), address(amd)));        // stock->stock
        assertFalse(vault.isExemptExit(address(pool), address(usdg), address(usdg)));
        assertFalse(vault.isExemptExit(address(0xBEEF), address(tsla), address(usdg)));
        assertFalse(vault.isExemptExit(address(0), address(tsla), address(usdg)));
    }

    function test_buysStillCountFully_afterExemptSells() public {
        for (uint256 k; k < 5; k++) _sell(address(pool), address(tsla), 0.39e18); // ~$97.5 each, exempt from buy cap (R4-1 sell cap $500)
        assertEq(vault.spentLast24h(agent), 0);
        assertEq(vault.vaultSpentLast24h(), 0);
        for (uint256 k; k < 5; k++) _buy(100e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyCapExceeded.selector, 600e6, 500e6));
        vault.agentSwap(address(pool), address(usdg), address(tsla), 100e6, 1, block.timestamp + 60);
    }

    function test_exemptSellStillPerTradeCapped() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.PerTradeCapExceeded.selector, 250e6, 100e6));
        vault.agentSwap(address(pool), address(tsla), address(usdg), 1e18, 1, block.timestamp + 60);
    }

    function test_exemptSellNotAllowlistedReverts() public {
        vm.prank(alice); vault.setAllowedToken(address(amd), false);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.TokenNotAllowed.selector, address(amd)));
        vault.agentSwap(address(amdPool), address(amd), address(usdg), 0.5e18, 1, block.timestamp + 60);
    }

    function test_exemptSellMarketClosedReverts() public {
        vm.prank(owner); oracle.setMarketMode(PriceOracle.MarketMode.ForceClosed);
        vm.prank(agent);
        vm.expectRevert();
        vault.agentSwap(address(pool), address(tsla), address(usdg), 0.2e18, 1, block.timestamp + 60);
    }

    function test_mismatchedPoolRejectedByRouter() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.PairNotSupported.selector, address(amdPool), address(tsla), address(usdg)));
        vault.agentSwap(address(amdPool), address(tsla), address(usdg), 0.2e18, 1, block.timestamp + 60);
    }

    /// Lying adapter (BadAdapter: supportsPair==true for everything, fills 5% under oracle):
    /// exemption is still keyed on the real tokenIn/tokenOut, and the oracle floor (<=3%) blocks the haircut.
    function test_lyingAdapterCannotMakeBuyExemptOrUnderfill() public {
        assertFalse(vault.isExemptExit(address(bad), address(usdg), address(tsla)));
        assertTrue(vault.isExemptExit(address(bad), address(tsla), address(usdg))); // trust assumption
        vm.prank(agent);
        vm.expectRevert(); // InsufficientOutput (floor) wrapped by router
        vault.agentSwap(address(bad), address(tsla), address(usdg), 0.2e18, 1, block.timestamp + 60);
    }

    function test_exemptOutputIsUsdgIntoVault() public {
        uint256 v0 = usdg.balanceOf(address(vault)); uint256 a0 = usdg.balanceOf(agent);
        uint256 out = _sell(address(pool), address(tsla), 0.2e18);
        assertEq(usdg.balanceOf(address(vault)) - v0, out);
        assertEq(usdg.balanceOf(agent), a0);
        assertGe(out, 50e6 * 9_700 / 10_000 * 9_970 / 10_000); // floor applied
    }

    function test_intentPathConsistent_sellDcaExempt_buyDcaCounts() public {
        FeeRouter.Intent memory s = FeeRouter.Intent(address(vault), address(tsla), address(usdg), address(pool),
            0.39e18, 1, 0, 60, 50, 300, uint40(block.timestamp), uint40(block.timestamp + 30 days), 7);
        bytes memory sig = _sign(agentPk, router.hashIntent(s));
        uint256 t = block.timestamp;
        for (uint256 k; k < 5; k++) { vm.prank(keeper); vault.executeIntent(s, sig); t += 60; vm.warp(t); _setPrice(PRICE); }
        assertEq(vault.vaultSpentLast24h(), 0); // ~$487.5 sold, nothing counted against buys
        FeeRouter.Intent memory b = FeeRouter.Intent(address(vault), address(usdg), address(tsla), address(pool),
            100e6, 1, 0, 60, 50, 300, uint40(block.timestamp), uint40(block.timestamp + 30 days), 8);
        bytes memory sigb = _sign(agentPk, router.hashIntent(b));
        for (uint256 k; k < 5; k++) { vm.prank(keeper); vault.executeIntent(b, sigb); t += 60; vm.warp(t); _setPrice(PRICE); }
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyCapExceeded.selector, 600e6, 500e6));
        vault.executeIntent(b, sigb);
    }

    /// R4-1 FIXED (Quintus, user/CTO decision): agent sells have a per-vault $500/24h sell cap;
    /// liquidation beyond it needs owner approval. ~$500 of the $10,000 TSLA can be sold, then revert.
    function test_FINDING_unboundedLiquidationInOneDay() public {
        uint256 slices;
        for (uint256 k; k < 5; k++) { _sell(address(pool), address(tsla), 0.39e18); slices++; } // $487.5
        vm.prank(agent);
        vm.expectPartialRevert(AgentVault.VaultSellCapExceeded.selector);
        vault.agentSwap(address(pool), address(tsla), address(usdg), 0.39e18, 1, block.timestamp + 60);
        assertEq(vault.vaultSpentLast24h(), 0); // buy window untouched
        assertEq(vault.vaultSoldLast24h(), 487.5e6);
    }

    /// Churn round trips: each buy leg counts, so churn volume is bounded by $500/24h of buys.
    function test_churnBoundedByBuys() public {
        for (uint256 k; k < 5; k++) { _buy(100e6); _sell(address(pool), address(tsla), 0.39e18); }
        vm.prank(agent);
        vm.expectRevert();
        vault.agentSwap(address(pool), address(usdg), address(tsla), 1e6, 1, block.timestamp + 60);
    }
}
