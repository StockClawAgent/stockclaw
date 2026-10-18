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
        _eligible(address(vault));
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
        (uint128 perTrade, uint40 exp, bool active, uint128 perDay,,) = vault.policies(agent);
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

    function test_daily_resetsAtUtcMidnight() public {
        _allowBoth();
        for (uint256 k; k < 5; k++) _buy(100e6);
        uint256 nextDay = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(nextDay - 1);
        _setPrice(PRICE);
        vm.expectRevert();
        _buy(1);
        vm.warp(nextDay);
        _buy(100e6);
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
            minOutPerExec: 0,
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
