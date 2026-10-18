// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract AgentVaultTest is Base {
    AgentVault vault;
    uint256 agentPk = 0xA6E7;
    address agent;

    function setUp() public override {
        super.setUp();
        agent = vm.addr(agentPk);
        vault = new AgentVault(alice, router); // owner = user EOA
        vm.prank(alice);
        reg.linkAccount(address(vault)); // vault inherits alice's (owner EOA) eligibility
        vm.prank(owner);
        usdg.mint(address(vault), 10_000e6);
        tsla.mint(address(vault), 10e18);
        vm.prank(alice);
        vault.grantAgent(agent, uint40(block.timestamp + 7 days));
    }

    function _allowBoth() internal {
        vm.startPrank(alice);
        vault.setAllowedToken(address(usdg), true);
        vault.setAllowedToken(address(tsla), true);
        vm.stopPrank();
    }

    function _buy(uint256 usdAmt) internal returns (uint256) {
        vm.prank(agent);
        return vault.agentSwap(address(pool), address(usdg), address(tsla), usdAmt, 0, block.timestamp + 60);
    }

    function test_defaults() public view {
        (uint128 perTrade, uint40 exp, bool active, uint128 perDay) = vault.policies(agent);
        assertEq(perTrade, 100e6);
        assertEq(perDay, 500e6);
        assertTrue(active);
        assertEq(exp, block.timestamp + 7 days);
        assertEq(vault.owner(), alice);
    }

    function test_emptyAllowlist_nothingTradable() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.TokenNotAllowed.selector, address(usdg)));
        vault.agentSwap(address(pool), address(usdg), address(tsla), 1e6, 0, block.timestamp + 60);
    }

    function test_allowlist_requiresBothSides() public {
        vm.prank(alice);
        vault.setAllowedToken(address(usdg), true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.TokenNotAllowed.selector, address(tsla)));
        vault.agentSwap(address(pool), address(usdg), address(tsla), 1e6, 0, block.timestamp + 60);
    }

    // ---------------- per-trade boundary
    function test_perTrade_exactly100_ok() public {
        _allowBoth();
        _buy(100e6);
    }

    function test_perTrade_100plus1wei_reverts() public {
        _allowBoth();
        vm.expectRevert(abi.encodeWithSelector(AgentVault.PerTradeCapExceeded.selector, 100e6 + 1, 100e6));
        _buy(100e6 + 1);
    }

    function test_perTrade_stockInput_usdValued() public {
        _allowBoth();
        vm.startPrank(agent);
        vault.agentSwap(address(pool), address(tsla), address(usdg), 0.4e18, 0, block.timestamp + 60); // $100.00
        vm.expectRevert(abi.encodeWithSelector(AgentVault.PerTradeCapExceeded.selector, 100000001, 100e6));
        vault.agentSwap(address(pool), address(tsla), address(usdg), 0.4e18 + 4e9, 0, block.timestamp + 60);
        vm.stopPrank();
    }

    // ---------------- daily boundary
    function test_daily_exactly500_ok_then1weiReverts() public {
        _allowBoth();
        for (uint256 k; k < 5; k++) _buy(100e6);
        (uint256 left,) = vault.remainingToday(agent);
        assertEq(left, 0);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyCapExceeded.selector, 500e6 + 1, 500e6));
        _buy(1);
    }

    function test_daily_noPartialFill() public {
        _allowBoth();
        for (uint256 k; k < 4; k++) _buy(100e6);
        _buy(50e6); // 450 spent
        uint256 bal = usdg.balanceOf(address(vault));
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyCapExceeded.selector, 550e6, 500e6));
        _buy(100e6);
        assertEq(usdg.balanceOf(address(vault)), bal);
        _buy(50e6); // exactly to 500 still ok
    }

    function _spend500() internal {
        for (uint256 k; k < 5; k++) _buy(100e6);
    }

    function _warpTo(uint256 t) internal {
        vm.warp(t);
        _setPrice(PRICE);
    }

    function test_rolling_acrossMidnight_cappedAt500() public {
        _allowBoth();
        uint256 midnight = (block.timestamp / 1 days + 1) * 1 days;
        _warpTo(midnight - 30 minutes); // 23:30 UTC
        _spend500();
        _warpTo(midnight + 1 hours); // 01:00 next calendar day: old fixed-day design would allow $500 more
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyCapExceeded.selector, 500e6 + 1, 500e6));
        _buy(1);
        (uint256 left,) = vault.remainingToday(agent);
        assertEq(left, 0);
    }

    function test_rolling_releaseBoundary() public {
        _allowBoth();
        uint256 hourStart = (block.timestamp / 1 hours + 1) * 1 hours;
        _warpTo(hourStart + 30 minutes); // spend at H:30
        _spend500();
        _warpTo(hourStart + 24 hours); // exactly ~23.5h later: still counted
        vm.expectRevert();
        _buy(1);
        _warpTo(hourStart + 25 hours - 1); // last second of bucket window (24h59m59s after bucket start)
        vm.expectRevert();
        _buy(1);
        _warpTo(hourStart + 25 hours); // bucket expired (24.5h after spend)
        assertEq(vault.spentLast24h(agent), 0);
        _spend500();
    }

    function test_rolling_partialRelease() public {
        _allowBoth();
        uint256 h0 = (block.timestamp / 1 hours + 1) * 1 hours;
        _warpTo(h0);
        _buy(100e6);
        _buy(100e6); // $200 at hour 0
        _warpTo(h0 + 10 hours);
        _buy(100e6);
        _buy(100e6);
        _buy(100e6); // $300 at hour 10 -> $500 total
        _warpTo(h0 + 25 hours); // hour-0 bucket expired, hour-10 still in window
        assertEq(vault.spentLast24h(agent), 300e6);
        _buy(100e6);
        _buy(100e6);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyCapExceeded.selector, 500e6 + 1, 500e6));
        _buy(1);
    }

    function test_rolling_ringReuseResetsStaleBucket() public {
        _allowBoth();
        uint256 h0 = (block.timestamp / 1 hours + 1) * 1 hours;
        _warpTo(h0);
        _spend500();
        _warpTo(h0 + 25 hours); // same ring index (25 % 25 == 0) -> must not add stale 500
        _spend500();
        assertEq(vault.spentLast24h(agent), 500e6);
    }

    // ---------------- eligibility inherited from owner EOA
    function test_eligibility_vaultInheritsOwner() public {
        assertTrue(reg.isEligible(address(vault)));
        assertEq(reg.eligibleUntil(address(vault)), 0); // not set directly
        vm.prank(attester);
        reg.revoke(alice); // owner loses eligibility -> vault too
        assertFalse(reg.isEligible(address(vault)));
        _allowBoth();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotEligible.selector, address(vault)));
        vault.agentSwap(address(pool), address(usdg), address(tsla), 1e6, 0, block.timestamp + 60);
    }

    function test_eligibility_ownershipTransferBreaksLink() public {
        vm.prank(alice);
        vault.transferOwnership(bob);
        vm.prank(bob);
        vault.acceptOwnership();
        assertFalse(reg.isEligible(address(vault))); // bob never attested
    }

    function test_eligibility_onlyEligibleOwnerCanLink() public {
        AgentVault v2 = new AgentVault(bob, router);
        vm.prank(bob);
        vm.expectRevert(EligibilityRegistry.OwnerNotEligible.selector);
        reg.linkAccount(address(v2));
        vm.prank(alice); // eligible, but not the owner
        vm.expectRevert(EligibilityRegistry.NotAccountOwner.selector);
        reg.linkAccount(address(v2));
    }

    function test_marketClosed_vaultHalts() public {
        _allowBoth();
        vm.prank(owner);
        oracle.setMarketMode(PriceOracle.MarketMode.Closed);
        vm.expectRevert(PriceOracle.MarketClosed.selector);
        _buy(1e6); // USDG valuation is fine, but stock leg halts at router
    }

    // ---------------- expiry / revoke / owner controls
    function test_expiryBoundary() public {
        _allowBoth();
        vm.warp(block.timestamp + 7 days);
        _setPrice(PRICE);
        _buy(1e6); // at expiry: ok
        vm.warp(block.timestamp + 1);
        vm.expectRevert(AgentVault.AgentExpired.selector);
        _buy(1e6);
    }

    function test_revoke() public {
        _allowBoth();
        vm.prank(alice);
        vault.revokeAgent(agent);
        vm.expectRevert(AgentVault.NotAgent.selector);
        _buy(1e6);
    }

    function test_unknownAgent() public {
        _allowBoth();
        vm.prank(bob);
        vm.expectRevert(AgentVault.NotAgent.selector);
        vault.agentSwap(address(pool), address(usdg), address(tsla), 1e6, 0, block.timestamp + 60);
    }

    function test_ownerAdjustsCaps() public {
        _allowBoth();
        vm.prank(alice);
        vault.setCaps(agent, 200e6, 300e6);
        _buy(200e6);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyCapExceeded.selector, 400e6, 300e6));
        _buy(200e6);
        vm.prank(alice);
        vm.expectRevert(AgentVault.InvalidParams.selector);
        vault.setCaps(agent, 301e6, 300e6);
    }

    function test_onlyOwnerControls() public {
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vault.setCaps(agent, 1e12, 1e12);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vault.setAllowedToken(address(usdg), true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vault.withdraw(address(usdg), agent, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vault.grantAgent(agent, uint40(block.timestamp + 365 days));
        vm.stopPrank();
    }

    function test_outputAlwaysToVault() public {
        _allowBoth();
        uint256 before = tsla.balanceOf(address(vault));
        uint256 out = _buy(100e6);
        assertEq(tsla.balanceOf(address(vault)), before + out);
        assertEq(tsla.balanceOf(agent), 0);
    }

    // ---------------- intents through the vault
    function _vaultIntent(uint256 nonce) internal view returns (FeeRouter.Intent memory) {
        return FeeRouter.Intent({
            account: address(vault),
            tokenIn: address(usdg),
            tokenOut: address(tsla),
            adapter: address(pool),
            amountPerExec: 100e6,
            minOutPerExec: 1,
            limitPriceE8: 0,
            interval: 1 hours,
            maxExecs: 10,
            maxOracleDevBps: 200,
            startTime: uint40(block.timestamp),
            expiry: uint40(block.timestamp + 7 days),
            nonce: nonce
        });
    }

    function test_vaultIntent_capsChargedPerExec() public {
        _allowBoth();
        FeeRouter.Intent memory i = _vaultIntent(1);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        for (uint256 k; k < 5; k++) {
            vm.warp(i.startTime + k * 1 hours);
            _setPrice(PRICE);
            vm.prank(keeper);
            vault.executeIntent(i, sig);
        }
        vm.warp(i.startTime + 5 hours);
        _setPrice(PRICE);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyCapExceeded.selector, 600e6, 500e6));
        vault.executeIntent(i, sig);
        assertEq(usdg.allowance(address(vault), address(router)), 0);
    }

    function test_vaultIntent_cannotBypassViaRouterDirect() public {
        _allowBoth();
        FeeRouter.Intent memory i = _vaultIntent(2);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.InvalidSignature.selector);
        router.executeIntent(i, sig);
    }

    function test_vaultIntent_onlyKeeper() public {
        _allowBoth();
        FeeRouter.Intent memory i = _vaultIntent(5);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(bob);
        vm.expectRevert(AgentVault.NotKeeper.selector);
        vault.executeIntent(i, sig);
    }

    function test_vaultIntent_nonAgentSigRejected() public {
        _allowBoth();
        FeeRouter.Intent memory i = _vaultIntent(3);
        bytes memory sig = _sign(0xBAD, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(AgentVault.BadAgentSignature.selector);
        vault.executeIntent(i, sig);
    }

    function test_vaultIntent_cancel() public {
        _allowBoth();
        FeeRouter.Intent memory i = _vaultIntent(4);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(alice);
        vault.cancelIntent(4);
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.NonceIsCancelled.selector);
        vault.executeIntent(i, sig);
    }

    function testFuzz_perTradeBoundary(uint256 amt) public {
        _allowBoth();
        amt = bound(amt, 1e6, 1_000e6);
        if (amt > 100e6) {
            vm.expectRevert(abi.encodeWithSelector(AgentVault.PerTradeCapExceeded.selector, amt, 100e6));
        }
        _buy(amt);
    }

    function testFuzz_dailyNeverExceeded(uint256[8] memory amts) public {
        _allowBoth();
        uint256 spent;
        for (uint256 k; k < 8; k++) {
            uint256 a = bound(amts[k], 1e6, 100e6);
            vm.prank(agent);
            try vault.agentSwap(address(pool), address(usdg), address(tsla), a, 0, block.timestamp + 60) {
                spent += a;
            } catch {
                assertGt(spent + a, 500e6);
            }
        }
        assertLe(spent, 500e6);
    }
}
