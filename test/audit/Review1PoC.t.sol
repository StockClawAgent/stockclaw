// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Base.t.sol";
import {TokenTransfers} from "../../src/libraries/TokenTransfers.sol";

/// Gaius review-1 PoCs, flipped by Quintus: each test now PASSES when the finding is FIXED
/// (expects the revert). Unfixed / decision-pending items are marked and assert current behaviour.
contract Review1PoC is Base {
    AgentVault vault;
    uint256 agentPk = 0xA6E7;
    address agent;
    address eve = makeAddr("eve"); // non-keeper, non-eligible

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
        vault.grantAgent(agent, uint40(block.timestamp + 7 days));
        vault.setAllowedToken(address(usdg), true);
        vault.setAllowedToken(address(tsla), true);
        vm.stopPrank();
    }

    function _vi(uint128 amt, uint32 interval, uint16 execs, uint40 start, uint16 dev, uint128 minOut)
        internal view returns (FeeRouter.Intent memory)
    {
        return FeeRouter.Intent(address(vault), address(usdg), address(tsla), address(pool), amt, minOut, 0,
            interval, execs, dev, start, uint40(block.timestamp + 30 days), 1);
    }

    function _refresh() internal { _setPrice(PRICE); }

    // M-1 FIXED: rolling 24h window -> second $500 across midnight reverts
    function test_PoC_M1_midnightDoubleSpend() public {
        uint256 midnight = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(midnight - 1); _refresh();
        vm.startPrank(agent);
        for (uint256 k; k < 5; k++) vault.agentSwap(address(pool), address(usdg), address(tsla), 100e6, 1, block.timestamp + 60);
        vm.stopPrank();
        vm.warp(midnight); _refresh();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyCapExceeded.selector, 600e6, 500e6));
        vault.agentSwap(address(pool), address(usdg), address(tsla), 100e6, 1, block.timestamp + 60);
    }

    // M-2 FIXED: after a 4-day outage only ONE slice runs; the next reverts NotYet
    function test_PoC_M2_dcaCatchUp() public {
        FeeRouter.Intent memory i = _vi(100e6, 1 days, 30, uint40(block.timestamp), 300, 1);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.warp(block.timestamp + 4 days + 1); _refresh();
        vm.startPrank(keeper);
        vault.executeIntent(i, sig);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotYet.selector, uint256(i.startTime) + 5 days));
        vault.executeIntent(i, sig);
        vm.stopPrank();
        assertEq(router.execCount(router.hashIntent(i)), 1);
    }

    // H-1 FIXED: (a) minOut == 0 rejected, (b) mandatory oracle floor, (c) dev in (0,300], (d) vault floor
    function test_PoC_H1_zeroMinOutAccepted() public {
        FeeRouter.SwapParams memory p = _params(address(usdg), address(tsla), 100e6, 1, alice);
        p.minAmountOut = 0;
        vm.prank(alice);
        vm.expectRevert(FeeRouter.ZeroMinOut.selector);
        router.swap(p);

        FeeRouter.Intent memory i = _vi(100e6, 0, 1, uint40(block.timestamp), 0, 0); // dev=0, minOut=0
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.InvalidIntent.selector);
        vault.executeIntent(i, sig);

        // (d) agent passes minOut=0 via an adapter filling 5% below oracle -> vault oracle floor reverts
        vm.prank(agent);
        vm.expectRevert();
        vault.agentSwap(address(bad), address(usdg), address(tsla), 100e6, 0, block.timestamp + 60);
    }

    // M-3 FIXED: only keeper (or vault owner) can trigger vault intents
    function test_PoC_M3_anyoneExecutesVaultIntent() public {
        FeeRouter.Intent memory i = _vi(100e6, 0, 1, uint40(block.timestamp), 300, 1);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(eve);
        vm.expectRevert(AgentVault.NotKeeper.selector);
        vault.executeIntent(i, sig);
        vm.prank(alice); // owner allowed
        vault.executeIntent(i, sig);
    }

    // M-4 FIXED: ineligible recipient rejected
    function test_PoC_M4_ineligibleRecipient() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotEligible.selector, eve));
        router.swap(_params(address(usdg), address(tsla), 1_000e6, 1, eve));
    }

    // M-5: fee stays in input token (CTO decision). Blocked fee leg fails cleanly with TransferBlocked;
    // precheck covers the treasury leg via compliance adapter; real-token path covered by
    // test/fork/RobinhoodFork.t.sol (read-only fork of 46630).
    function test_PoC_M5_frozenTreasuryDoSesSells() public {
        tsla.setFrozen(safe, true);
        vm.prank(alice);
        vm.expectPartialRevert(TokenTransfers.TransferBlocked.selector);
        router.swap(_params(address(tsla), address(usdg), 1e18, 1, alice));
    }

    // L-1 FIXED: dev > 300 is a clean InvalidIntent (no panic)
    function test_PoC_L1_devBpsUnderflow() public {
        FeeRouter.Intent memory i = _vi(100e6, 0, 1, uint40(block.timestamp), 10_001, 1);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.InvalidIntent.selector);
        vault.executeIntent(i, sig);
    }

    // L-2 FIXED: $100/$500 are protocol hard maximums; raising reverts
    function test_PoC_L2_capsUnbounded() public {
        vm.prank(alice);
        vm.expectRevert(AgentVault.CapAboveProtocolMax.selector);
        vault.setCaps(agent, 1_000_000e6, 1_000_000e6);
    }

    // Info: cross-vault replay is blocked (account is in the signed struct)
    function test_noCrossVaultReplay() public {
        AgentVault v2 = new AgentVault(alice, router);
        vm.prank(alice); reg.linkAccount(address(v2));
        vm.prank(alice); v2.grantAgent(agent, uint40(block.timestamp + 1 days));
        FeeRouter.Intent memory i = _vi(100e6, 0, 1, uint40(block.timestamp), 300, 1);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(AgentVault.WrongAccount.selector);
        v2.executeIntent(i, sig);
    }

    // Info: agent cannot pull vault funds through router directly (ERC-1271 disabled)
    function test_noDirectRouterBypass() public {
        FeeRouter.Intent memory i = _vi(100e6, 0, 1, uint40(block.timestamp), 300, 1);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.InvalidSignature.selector);
        router.executeIntent(i, sig);
    }
}
