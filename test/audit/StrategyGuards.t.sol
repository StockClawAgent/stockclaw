// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Base.t.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Gaius strategies-review: onchain guards every strategy path relies on.
/// S1 (DCA) and S2 (buy-limit -> take-profit) both reduce to agent-signed intents via
/// AgentVault.executeIntent, or agentSwap. Tests marked FINDING assert CURRENT behaviour of an open issue.
contract StrategyGuards is Base {
    AgentVault vault;
    uint256 agentPk = 0xA6E7;
    address agent;
    uint256 agent2Pk = 0xB0B2;
    address agent2;
    MockStockToken amd; // never allowlisted

    function setUp() public override {
        super.setUp();
        agent = vm.addr(agentPk);
        agent2 = vm.addr(agent2Pk);
        amd = new MockStockToken("AMD (test)", "AMD");
        vault = new AgentVault(alice, router);
        vm.prank(alice);
        reg.linkAccount(address(vault));
        vm.prank(owner);
        usdg.mint(address(vault), 10_000e6);
        tsla.mint(address(vault), 10e18);
        vm.startPrank(alice);
        vault.grantAgent(agent, uint40(block.timestamp + 7 days));
        vault.setAllowedToken(address(usdg), true);
        vault.setAllowedToken(address(tsla), true);
        vm.stopPrank();
    }

    function _intent(uint128 amt, uint32 interval, uint16 execs, uint256 nonce) internal view returns (FeeRouter.Intent memory) {
        return FeeRouter.Intent(address(vault), address(usdg), address(tsla), address(pool), amt, 1, 0,
            interval, execs, 300, uint40(block.timestamp), uint40(block.timestamp + 30 days), nonce);
    }

    function _unauth(address who) internal {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who));
    }

    // ---------------------------------------------------------------- (b) agent key has no owner powers
    function test_agentCannotRaiseOrSetCaps() public {
        vm.startPrank(agent);
        _unauth(agent); vault.setCaps(agent, 100e6, 500e6);
        _unauth(agent); vault.setCaps(agent, 50e6, 100e6); // not even lowering
        vm.stopPrank();
    }

    function test_agentCannotChangeAllowlist() public {
        vm.prank(agent); _unauth(agent); vault.setAllowedToken(address(amd), true);
        vm.prank(agent); _unauth(agent); vault.setAllowedToken(address(tsla), false);
    }

    function test_agentCannotGrantRevokeOrExtendKeys() public {
        vm.startPrank(agent);
        _unauth(agent); vault.grantAgent(agent2, uint40(block.timestamp + 1 days));
        _unauth(agent); vault.grantAgent(agent, uint40(block.timestamp + 365 days)); // self-extend
        _unauth(agent); vault.revokeAgent(agent);
        vm.stopPrank();
    }

    function test_agentCannotWithdrawOwnerSwapOrTakeOwnership() public {
        vm.startPrank(agent);
        _unauth(agent); vault.withdraw(address(usdg), agent, 1e6);
        FeeRouter.SwapParams memory p = FeeRouter.SwapParams(address(pool), address(usdg), address(tsla), 1_000e6, 1, agent, block.timestamp + 60);
        _unauth(agent); vault.ownerSwap(p); // uncapped path, owner-only
        _unauth(agent); vault.transferOwnership(agent);
        vm.stopPrank();
    }

    function test_keeperHasNoOwnerPowersOnVault() public {
        vm.startPrank(keeper);
        _unauth(keeper); vault.setCaps(agent, 100e6, 500e6);
        _unauth(keeper); vault.setAllowedToken(address(amd), true);
        _unauth(keeper); vault.grantAgent(keeper, uint40(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function test_ownerCannotExceedProtocolMax() public {
        vm.startPrank(alice);
        vm.expectRevert(AgentVault.CapAboveProtocolMax.selector); vault.setCaps(agent, 101e6, 500e6);
        vm.expectRevert(AgentVault.CapAboveProtocolMax.selector); vault.setCaps(agent, 100e6, 501e6);
        vm.stopPrank();
    }

    /// No strategyHash exists onchain: there is nothing for the agent (or anyone) to re-pin onchain.
    /// "Strategy switch" == agent signs new intents; this proves such a switch is still clamped (see below)
    /// and that the onchain intent struct carries no strategy binding (documented, finding S-3).

    // ---------------------------------------------------------------- (a) strategy trades are clamped
    function test_S1_dcaClampedAt500Rolling() public {
        FeeRouter.Intent memory i = _intent(100e6, 60, 50, 11); // aggressive "strategy": $100/min x 50
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        for (uint256 k; k < 5; k++) { vm.prank(keeper); vault.executeIntent(i, sig); vm.warp(block.timestamp + 60); _setPrice(PRICE); }
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyCapExceeded.selector, 600e6, 500e6));
        vault.executeIntent(i, sig);
    }

    function test_intentOverPerTradeCapReverts() public {
        FeeRouter.Intent memory i = _intent(100e6 + 1, 0, 1, 12);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.PerTradeCapExceeded.selector, 100e6 + 1, 100e6));
        vault.executeIntent(i, sig);
    }

    function testFuzz_agentSwapPerTradeClamp(uint256 amt) public {
        amt = bound(amt, 1e6, 5_000e6);
        vm.prank(agent);
        if (amt > 100e6) vm.expectRevert(abi.encodeWithSelector(AgentVault.PerTradeCapExceeded.selector, amt, 100e6));
        vault.agentSwap(address(pool), address(usdg), address(tsla), amt, 1, block.timestamp + 60);
    }

    function test_S2_takeProfitSellAlsoChargedAgainstCaps() public {
        // S2: buy fills, then server signs a sell-limit. Sells consume the same cap (USD of tokenIn).
        vm.startPrank(agent);
        for (uint256 k; k < 4; k++) vault.agentSwap(address(pool), address(usdg), address(tsla), 100e6, 1, block.timestamp + 60);
        vm.stopPrank();
        FeeRouter.Intent memory tp = FeeRouter.Intent(address(vault), address(tsla), address(usdg), address(pool),
            0.8e18, 1, uint64(PRICE), 0, 1, 300, uint40(block.timestamp), uint40(block.timestamp + 1 days), 21); // 0.8 TSLA = $200
        bytes memory sig = _sign(agentPk, router.hashIntent(tp));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.PerTradeCapExceeded.selector, 200e6, 100e6));
        vault.executeIntent(tp, sig);
    }

    function test_nonAllowlistedTokenReverts() public {
        FeeRouter.Intent memory i = _intent(50e6, 0, 1, 13);
        i.tokenOut = address(amd);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.TokenNotAllowed.selector, address(amd)));
        vault.executeIntent(i, sig);
    }

    function test_recipientAlwaysVault() public {
        uint256 before = tsla.balanceOf(address(vault));
        uint256 agentBefore = tsla.balanceOf(agent);
        vm.prank(agent);
        vault.agentSwap(address(pool), address(usdg), address(tsla), 50e6, 1, block.timestamp + 60);
        assertGt(tsla.balanceOf(address(vault)), before);
        assertEq(tsla.balanceOf(agent), agentBefore);
    }

    // ---------------------------------------------------------------- intent authorization
    function test_unknownSignerIntentRejected() public {
        FeeRouter.Intent memory i = _intent(50e6, 0, 1, 14);
        bytes memory sig = _sign(0xDEAD, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(AgentVault.BadAgentSignature.selector);
        vault.executeIntent(i, sig);
    }

    function test_revokedAgentIntentsStop() public {
        FeeRouter.Intent memory i = _intent(50e6, 60, 10, 15);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(alice); vault.revokeAgent(agent);
        vm.prank(keeper);
        vm.expectRevert(AgentVault.NotAgent.selector);
        vault.executeIntent(i, sig);
    }

    function test_onlyKeeperOrOwnerExecutes() public {
        FeeRouter.Intent memory i = _intent(50e6, 0, 1, 16);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotKeeper.selector);
        vault.executeIntent(i, sig);
    }

    function test_keeperCannotBypassVaultViaRouter() public {
        FeeRouter.Intent memory i = _intent(500e6, 0, 1, 17);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.InvalidSignature.selector); // vault ERC-1271 disabled
        router.executeIntent(i, sig);
    }

    function test_intentForOtherAccountRejected() public {
        AgentVault other = new AgentVault(bob, router);
        FeeRouter.Intent memory i = _intent(50e6, 0, 1, 18);
        i.account = address(other);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(AgentVault.WrongAccount.selector);
        vault.executeIntent(i, sig);
    }

    function test_agentCanOnlyCancelNotCreatePermissions() public {
        // Agents may cancel (safe direction). Cancelled intent cannot be revived.
        FeeRouter.Intent memory i = _intent(50e6, 60, 10, 19);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(agent); vault.cancelIntent(19);
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.NonceIsCancelled.selector);
        vault.executeIntent(i, sig);
    }

    // ---------------------------------------------------------------- FINDINGS (assert current behaviour)
    /// FINDING S-2: the $500 "protocol max" is per AGENT KEY, not per vault. Re-issuing a key
    /// (server's create_session_key = revoke + grant new key, signed with the server-held owner key)
    /// resets the window: $1,000 spent from one vault inside one hour. Flip to expectRevert once fixed.
    function test_FINDING_S2_capIsPerAgentNotPerVault() public {
        vm.startPrank(agent);
        for (uint256 k; k < 5; k++) vault.agentSwap(address(pool), address(usdg), address(tsla), 100e6, 1, block.timestamp + 60);
        vm.stopPrank();
        vm.startPrank(alice);
        vault.revokeAgent(agent);
        vault.grantAgent(agent2, uint40(block.timestamp + 7 days)); // "edit limits" in the dashboard
        vm.stopPrank();
        // S-2 FIXED (CTO decision, Quintus): vault-wide rolling $500 shared by all agent keys
        vm.prank(agent2);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.VaultDailyCapExceeded.selector, 600e6, 500e6));
        vault.agentSwap(address(pool), address(usdg), address(tsla), 100e6, 1, block.timestamp + 60);
        assertEq(vault.vaultSpentLast24h(), 500e6);
    }

    /// S-4 FIXED (CTO decision, Quintus): roles split. Market mode is owner-only; the keeper may only
    /// push a bounded session (<= 8h, closing in the future); prices come from a separate updater key.
    function test_FINDING_S4_keeperControlsMarketMode() public {
        vm.prank(owner); oracle.setKeeper(keeper);
        vm.prank(keeper);
        vm.expectRevert();
        oracle.setMarketMode(PriceOracle.MarketMode.ForceOpen);
        assertTrue(feed.updater() != keeper);
        vm.prank(keeper);
        vm.expectRevert(MockAggregatorV3.NotUpdater.selector);
        feed.updateAnswer(int256(PRICE));
    }
}
