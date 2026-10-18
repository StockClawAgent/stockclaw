// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Base.t.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Safe-like 1271 owner: returns magic for digests it has "approved".
contract Mock1271Owner {
    mapping(bytes32 => bool) public ok;
    function approve(bytes32 h) external { ok[h] = true; }
    function isValidSignature(bytes32 h, bytes calldata) external view returns (bytes4) {
        return ok[h] ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
    function call(address t, bytes calldata d) external { (bool s, bytes memory r) = t.call(d); if (!s) assembly { revert(add(r, 32), mload(r)) } }
}

/// Gaius review-5: R4-1 sell cap + owner sell approvals (baa80e9).
contract Review5 is Base {
    AgentVault vault;
    uint256 agentPk = 0xA6E7;
    address agent;
    uint256 constant SLICE = 0.39e18; // $97.50 at $250

    function setUp() public override {
        super.setUp();
        agent = vm.addr(agentPk);
        vault = _mkVault(alice);
    }

    function _mkVault(address own) internal returns (AgentVault v) {
        v = new AgentVault(own, router);
        if (own == alice) { vm.prank(alice); reg.linkAccount(address(v)); }
        vm.prank(owner); usdg.mint(address(v), 10_000e6);
        tsla.mint(address(v), 40e18);
        vm.startPrank(own);
        v.grantAgent(agent, uint40(block.timestamp + 7 days));
        v.setAllowedToken(address(usdg), true);
        v.setAllowedToken(address(tsla), true);
        vm.stopPrank();
    }

    function _sell(AgentVault v) internal { vm.prank(agent); v.agentSwap(address(pool), address(tsla), address(usdg), SLICE, 1, block.timestamp + 60); }
    function _sellReverts(AgentVault v) internal {
        vm.prank(agent); vm.expectPartialRevert(AgentVault.VaultSellCapExceeded.selector);
        v.agentSwap(address(pool), address(tsla), address(usdg), SLICE, 1, block.timestamp + 60);
    }
    function _burnCap() internal { for (uint256 k; k < 5; k++) _sell(vault); } // $487.50
    function _sig(AgentVault v, uint128 amt, uint40 exp, uint64 n) internal view returns (bytes memory) {
        return _sign(alicePk, v.sellApprovalDigest(amt, exp, n));
    }

    // ------------------------------------------------ cap basics
    function test_liquidationStopsAt500() public { _burnCap(); _sellReverts(vault); assertEq(vault.vaultSpentLast24h(), 0); }

    function test_sellAndBuyWindowsIndependent() public {
        _burnCap();
        vm.startPrank(agent);
        for (uint256 k; k < 5; k++) vault.agentSwap(address(pool), address(usdg), address(tsla), 100e6, 1, block.timestamp + 60);
        vm.stopPrank();
        assertEq(vault.vaultSpentLast24h(), 500e6);
        _sellReverts(vault);
    }

    function test_agentCannotSetCapOrApprove() public {
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent)); vault.setSellCap(400e6);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent)); vault.approveSell(1e12, uint40(block.timestamp + 1 days), 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent)); vault.cancelSellApproval(1);
        vm.stopPrank();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper)); vault.approveSell(1e12, uint40(block.timestamp + 1 days), 1);
        // agent self-signed approval rejected
        bytes32 d = vault.sellApprovalDigest(1e12, uint40(block.timestamp + 1 days), 2);
        bytes memory s = _sign(agentPk, d);
        vm.expectRevert(AgentVault.BadSellApproval.selector);
        vault.approveSellWithSig(1e12, uint40(block.timestamp + 1 days), 2, s);
    }

    function test_ownerCannotRaiseSellCap() public {
        vm.prank(alice); vm.expectRevert(AgentVault.CapAboveProtocolMax.selector); vault.setSellCap(500e6 + 1);
    }

    function test_allowanceDoesNotBypassPerTradeCap() public {
        vm.prank(alice); vault.approveSell(10_000e6, uint40(block.timestamp + 1 days), 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.PerTradeCapExceeded.selector, 250e6, 100e6));
        vault.agentSwap(address(pool), address(tsla), address(usdg), 1e18, 1, block.timestamp + 60);
    }

    function test_allowanceConsumedOnIntentPath() public {
        _burnCap();
        vm.prank(alice); vault.approveSell(100e6, uint40(block.timestamp + 1 days), 1);
        FeeRouter.Intent memory i = FeeRouter.Intent(address(vault), address(tsla), address(usdg), address(pool),
            uint128(SLICE), 1, 0, 60, 10, 300, uint40(block.timestamp), uint40(block.timestamp + 30 days), 9);
        bytes memory sig = _sign(agentPk, router.hashIntent(i));
        vm.prank(keeper); vault.executeIntent(i, sig); // $12.5 cap + $85 allowance
        (,uint128 rem,,) = _allow();
        assertEq(rem, 100e6 - (97.5e6 - 12.5e6));
        vm.warp(block.timestamp + 60); _setPrice(PRICE);
        vm.prank(keeper); vm.expectPartialRevert(AgentVault.VaultSellCapExceeded.selector);
        vault.executeIntent(i, sig); // needs 97.5 > 15 left: atomic, nothing consumed
        (,rem,,) = _allow();
        assertEq(rem, 15e6);
    }
    function _allow() internal view returns (uint256, uint128 amt, uint40 exp, uint64 n) {
        (amt, exp, n) = vault.sellAllowance(); return (0, amt, exp, n);
    }

    // ------------------------------------------------ replacement & nonce semantics
    /// FINDING R5-1: approvals REPLACE. A front-run spends the old allowance, then the new one applies.
    function test_FINDING_replaceRaceSpendsOldThenNew() public {
        _burnCap(); // cap exhausted
        vm.prank(alice); vault.approveSell(300e6, uint40(block.timestamp + 1 days), 1);
        // owner wants to reduce to $100; agent front-runs with 3 sells of old allowance
        for (uint256 k; k < 3; k++) _sell(vault);
        vm.prank(alice); vault.approveSell(100e6, uint40(block.timestamp + 1 days), 2);
        _sell(vault); // old ~$292.5 spent + another $97.5 from the new $100
        // total agent sells beyond cap: ~$390 although the owner "meant" max $300 then $100
    }

    /// FINDING R5-2 (Medium): unordered nonces + replace semantics => an OLDER signed approval that was
    /// never submitted can be relayed AFTER a newer, smaller one and resurrect the larger allowance.
    function test_FINDING_staleSignedApprovalOverridesNewer() public {
        uint40 exp = uint40(block.timestamp + 7 days);
        bytes memory big = _sig(vault, 5_000e6, exp, 10);   // signed Monday, held by relayer/server
        vm.prank(alice); vault.approveSell(50e6, exp, 11);  // owner later sets a small allowance
        vault.approveSellWithSig(5_000e6, exp, 10, big);    // anyone relays the stale one
        (, uint128 amt,,) = _allow();
        assertEq(amt, 5_000e6);
    }

    function test_cancelBurnsUnsubmittedNonce() public {
        uint40 exp = uint40(block.timestamp + 1 days);
        bytes memory s = _sig(vault, 1_000e6, exp, 7);
        vm.prank(alice); vault.cancelSellApproval(7);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.SellNonceUsed.selector, 7));
        vault.approveSellWithSig(1_000e6, exp, 7, s);
    }

    function test_cancelFrontRunByRelayStillCleared() public {
        uint40 exp = uint40(block.timestamp + 1 days);
        bytes memory s = _sig(vault, 1_000e6, exp, 7);
        vm.prank(keeper); vault.approveSellWithSig(1_000e6, exp, 7, s); // relay front-runs cancel
        vm.prank(alice); vault.cancelSellApproval(7);
        (, uint128 amt,,) = _allow();
        assertEq(amt, 0);
    }

    function test_nonceSingleUse() public {
        vm.prank(alice); vault.approveSell(10e6, uint40(block.timestamp + 1 days), 3);
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(AgentVault.SellNonceUsed.selector, 3));
        vault.approveSell(10e6, uint40(block.timestamp + 1 days), 3);
    }

    // ------------------------------------------------ domain separation
    function test_crossVaultReplayRejected() public {
        AgentVault v2 = _mkVault(alice);
        uint40 exp = uint40(block.timestamp + 1 days);
        bytes memory s = _sig(vault, 1_000e6, exp, 1);
        vm.expectRevert(AgentVault.BadSellApproval.selector);
        v2.approveSellWithSig(1_000e6, exp, 1, s);
        assertTrue(vault.sellApprovalDigest(1, exp, 1) != v2.sellApprovalDigest(1, exp, 1));
    }

    function test_intentSigNotUsableAsApproval() public {
        FeeRouter.Intent memory i = FeeRouter.Intent(address(vault), address(tsla), address(usdg), address(pool),
            1, 1, 0, 0, 1, 300, uint40(block.timestamp), uint40(block.timestamp + 1 days), 1);
        bytes memory s = _sign(alicePk, router.hashIntent(i));
        vm.expectRevert(AgentVault.BadSellApproval.selector);
        vault.approveSellWithSig(1_000e6, uint40(block.timestamp + 1 days), 1, s);
    }

    function test_expiryBounds() public {
        vm.startPrank(alice);
        vm.expectRevert(AgentVault.BadSellApproval.selector); vault.approveSell(1e6, uint40(block.timestamp), 1);
        vm.expectRevert(AgentVault.BadSellApproval.selector); vault.approveSell(1e6, uint40(block.timestamp + 7 days + 1), 2);
        vault.approveSell(200e6, uint40(block.timestamp + 7 days), 3);
        vm.stopPrank();
        _burnCap();
        vm.warp(block.timestamp + 7 days); _setPrice(PRICE); // at expiry second: still usable (>=)
        // cap window rolled off after 7d, so sell from cap; check allowance via view
        (, uint256 allow,,) = vault.exitRemaining();
        assertEq(allow, 200e6);
        vm.warp(block.timestamp + 1);
        (, allow,,) = vault.exitRemaining();
        assertEq(allow, 0);
    }

    // ------------------------------------------------ 1271 owner + ownership transfer
    function test_safeOwner1271() public {
        Mock1271Owner safe1271 = new Mock1271Owner();
        AgentVault v = new AgentVault(address(safe1271), router);
        uint40 exp = uint40(block.timestamp + 1 days);
        bytes32 d = v.sellApprovalDigest(300e6, exp, 1);
        vm.expectRevert(AgentVault.BadSellApproval.selector);
        v.approveSellWithSig(300e6, exp, 1, "");
        safe1271.approve(d);
        v.approveSellWithSig(300e6, exp, 1, "");
        (uint128 amt,,) = v.sellAllowance();
        assertEq(amt, 300e6);
    }

    /// FINDING R5-3 (low): ownership transfer keeps the active allowance (and agents) of the old owner.
    function test_FINDING_allowanceSurvivesOwnershipTransfer() public {
        vm.prank(alice); vault.approveSell(1_000e6, uint40(block.timestamp + 7 days), 1);
        vm.prank(alice); vault.transferOwnership(bob);
        vm.prank(bob); vault.acceptOwnership();
        (uint128 amt,,) = vault.sellAllowance();
        assertEq(amt, 1_000e6);
        // old owner's unsubmitted signatures are dead (checked against current owner)
        uint40 exp = uint40(block.timestamp + 1 days);
        bytes memory s = _sig(vault, 1, exp, 2);
        vm.expectRevert(AgentVault.BadSellApproval.selector);
        vault.approveSellWithSig(1, exp, 2, s);
    }

    function test_ownerSwapUncappedOwnerOnly() public {
        FeeRouter.SwapParams memory p = FeeRouter.SwapParams(address(pool), address(tsla), address(usdg), 10e18, 1, address(vault), block.timestamp + 60);
        vm.prank(alice); vault.ownerSwap(p); // $2,500 sell, no caps
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vault.ownerSwap(p);
    }
}
