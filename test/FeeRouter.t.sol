// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";
import {TokenTransfers} from "../src/libraries/TokenTransfers.sol";
import {MockComplianceAdapter} from "../src/mocks/MockComplianceAdapter.sol";
import {ITokenComplianceAdapter} from "../src/interfaces/ITokenComplianceAdapter.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract FeeRouterTest is Base {
    function test_defaultFeeIs30() public view {
        assertEq(router.feeBps(), 30);
        assertEq(router.feeTreasury(), safe);
    }

    function test_quoteEqualsDelivered_oracleAnchored() public {
        uint256 amt = 1_000e6;
        (uint256 q, uint256 fee) = router.quote(address(pool), address(usdg), address(tsla), amt);
        // (1000 - 0.3% fee) / $250 * (1 - 20 bps spread)
        assertEq(fee, 3e6);
        assertEq(q, uint256(997e6) * 1e18 / 250e6 * 9_980 / 10_000);
        vm.prank(alice);
        assertEq(router.swap(_params(address(usdg), address(tsla), amt, q, alice)), q);
    }

    function test_buy_feeFromInputToTreasury() public {
        uint256 amt = 1_000e6;
        (uint256 q,) = router.quote(address(pool), address(usdg), address(tsla), amt);
        vm.prank(alice);
        uint256 out = router.swap(_params(address(usdg), address(tsla), amt, q, alice));
        assertEq(out, q);
        assertEq(usdg.balanceOf(safe), amt * 30 / 10_000);
        assertEq(tsla.balanceOf(alice), 100e18 + out);
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(tsla.balanceOf(address(router)), 0);
    }

    function test_sell() public {
        vm.prank(alice);
        uint256 out = router.swap(_params(address(tsla), address(usdg), 1e18, 0, alice));
        assertGt(out, 240e6);
        assertEq(tsla.balanceOf(safe), 1e18 * 30 / 10_000);
    }

    function test_setFee_capAt50() public {
        vm.startPrank(owner);
        router.setFeeBps(50);
        assertEq(router.feeBps(), 50);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.FeeAboveCap.selector, uint16(51)));
        router.setFeeBps(51);
        vm.stopPrank();
    }

    function test_onlyOwnerAdmin() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        router.setFeeBps(40);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        router.setFeeTreasury(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        router.pause();
        vm.stopPrank();
    }

    function test_feeTreasuryChange() public {
        address newSafe = makeAddr("newSafe");
        vm.prank(owner);
        router.setFeeTreasury(newSafe);
        vm.prank(alice);
        router.swap(_params(address(usdg), address(tsla), 1_000e6, 0, alice));
        assertEq(usdg.balanceOf(newSafe), 3e6);
    }

    function test_revert_notEligible() public {
        vm.prank(owner);
        usdg.mint(bob, 1_000e6);
        vm.startPrank(bob);
        usdg.approve(address(router), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotEligible.selector, bob));
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, bob));
        vm.stopPrank();
    }

    function test_revert_eligibilityExpired() public {
        vm.warp(block.timestamp + 366 days);
        _setPrice(PRICE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotEligible.selector, alice));
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
    }

    function test_revert_deadline_minOut_adapter() public {
        FeeRouter.SwapParams memory p = _params(address(usdg), address(tsla), 100e6, 0, alice);
        p.deadline = block.timestamp - 1;
        vm.prank(alice);
        vm.expectRevert(FeeRouter.Expired.selector);
        router.swap(p);

        p = _params(address(usdg), address(tsla), 100e6, 1e18, alice);
        vm.prank(alice);
        vm.expectPartialRevert(FeeRouter.AdapterSwapFailed.selector); // pool InsufficientOutput
        router.swap(p);

        p.adapter = bob;
        p.minAmountOut = 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.AdapterNotAllowed.selector, bob));
        router.swap(p);
    }

    function test_revert_paused() public {
        vm.prank(owner);
        router.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
    }

    // ------------------------------------------------ issuer restrictions
    function test_revert_stockPaused() public {
        tsla.setPaused(true);
        vm.prank(alice);
        vm.expectPartialRevert(FeeRouter.AdapterSwapFailed.selector); // pool's stock transfer reverted
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
        assertEq(usdg.balanceOf(alice), 100_000e6); // nothing moved
        assertEq(usdg.balanceOf(safe), 0);
        // selling a paused stock: the pull itself is blocked
        vm.prank(alice);
        vm.expectPartialRevert(TokenTransfers.TransferBlocked.selector);
        router.swap(_params(address(tsla), address(usdg), 1e18, 0, alice));
    }

    function test_revert_senderFrozen() public {
        tsla.setFrozen(alice, true);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenTransfers.TransferBlocked.selector, address(tsla), alice, address(router),
                abi.encodeWithSelector(MockStockToken.Frozen.selector, alice)
            )
        );
        router.swap(_params(address(tsla), address(usdg), 1e18, 0, alice));
        assertEq(tsla.balanceOf(alice), 100e18);
    }

    function test_revert_ineligibleRecipient() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotEligible.selector, bob));
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, bob));
        assertFalse(router.precheck(alice, address(usdg), address(tsla), 100e6, bob));
    }

    function test_revert_recipientFrozen() public {
        _eligible(bob);
        tsla.setFrozen(bob, true);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenTransfers.TransferBlocked.selector, address(tsla), address(router), bob,
                abi.encodeWithSelector(MockStockToken.Frozen.selector, bob)
            )
        );
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, bob));
        assertEq(usdg.balanceOf(alice), 100_000e6);
        assertEq(tsla.balanceOf(address(router)), 0);
    }

    function test_revert_registry() public {
        tsla.setRegistryEnforced(true);
        tsla.setRegistered(address(pool), true);
        tsla.setRegistered(address(router), true);
        // alice not registered
        vm.prank(alice);
        vm.expectPartialRevert(TokenTransfers.TransferBlocked.selector);
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
        tsla.setRegistered(alice, true);
        vm.prank(alice);
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
        assertTrue(router.precheck(alice, address(usdg), address(tsla), 100e6, alice));
    }

    function test_complianceAdapter_defaultNone_thenPluggable() public {
        assertEq(address(router.complianceAdapter(address(tsla))), address(0));
        tsla.setFrozen(alice, true);
        assertTrue(router.precheck(alice, address(usdg), address(tsla), 100e6, alice)); // unknown without adapter
        MockComplianceAdapter ca = new MockComplianceAdapter();
        vm.prank(owner);
        router.setComplianceAdapter(address(tsla), ITokenComplianceAdapter(address(ca)));
        assertFalse(router.precheck(alice, address(usdg), address(tsla), 100e6, alice));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                FeeRouter.ComplianceBlocked.selector, address(tsla), address(router), alice, bytes32("FROZEN")
            )
        );
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
    }

    function test_marketClosed_halts() public {
        vm.prank(owner);
        oracle.setMarketMode(PriceOracle.MarketMode.Closed);
        assertFalse(router.precheck(alice, address(usdg), address(tsla), 100e6, alice));
        vm.prank(alice);
        vm.expectRevert(FeeRouter.MarketClosed.selector);
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
    }

    // ------------------------------------------------ Permit2
    function test_swapWithPermit2() public {
        vm.prank(alice);
        usdg.approve(address(permit2), type(uint256).max);
        ISignatureTransfer.PermitTransferFrom memory pm = ISignatureTransfer.PermitTransferFrom(
            ISignatureTransfer.TokenPermissions(address(usdg), 500e6), 7, block.timestamp + 60
        );
        bytes memory sig = _sign(alicePk, permit2.digest(pm, address(router)));
        vm.prank(alice);
        uint256 out = router.swapWithPermit2(_params(address(usdg), address(tsla), 500e6, 0, alice), pm, sig);
        assertGt(out, 0);
        assertEq(usdg.balanceOf(safe), 1.5e6);
        // replay fails
        vm.prank(alice);
        vm.expectRevert(MockPermit2.NonceUsed.selector);
        router.swapWithPermit2(_params(address(usdg), address(tsla), 500e6, 0, alice), pm, sig);
    }

    function test_permit2_tokenMismatch() public {
        ISignatureTransfer.PermitTransferFrom memory pm = ISignatureTransfer.PermitTransferFrom(
            ISignatureTransfer.TokenPermissions(address(tsla), 1e18), 1, block.timestamp + 60
        );
        vm.prank(alice);
        vm.expectRevert(FeeRouter.PermitMismatch.selector);
        router.swapWithPermit2(_params(address(usdg), address(tsla), 100e6, 0, alice), pm, "");
    }

    // ------------------------------------------------ fuzz
    function testFuzz_feeAccounting(uint256 amt, uint16 bps) public {
        amt = bound(amt, 1, 5_000e6); // within oracle band
        bps = uint16(bound(bps, 0, 50));
        vm.prank(owner);
        router.setFeeBps(bps);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        try router.swap(_params(address(usdg), address(tsla), amt, 0, alice)) {
            assertEq(usdg.balanceOf(safe), amt * bps / 10_000);
            assertEq(before - usdg.balanceOf(alice), amt);
        } catch {
            // only acceptable failure: dust whose output rounds below minOut=1 / oracle floor
            assertLt(amt, 1e6);
        }
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(tsla.balanceOf(address(router)), 0);
    }

    function testFuzz_setFee(uint16 bps) public {
        vm.prank(owner);
        if (bps > 50) {
            vm.expectRevert(abi.encodeWithSelector(FeeRouter.FeeAboveCap.selector, bps));
            router.setFeeBps(bps);
        } else {
            router.setFeeBps(bps);
            assertEq(router.feeBps(), bps);
        }
    }

    function testFuzz_slippage(uint256 amt, uint256 minOut) public {
        amt = bound(amt, 1e6, 5_000e6);
        (uint256 q,) = router.quote(address(pool), address(usdg), address(tsla), amt);
        minOut = bound(minOut, 1, q * 2);
        vm.prank(alice);
        if (minOut > q) {
            vm.expectRevert();
            router.swap(_params(address(usdg), address(tsla), amt, minOut, alice));
        } else {
            uint256 out = router.swap(_params(address(usdg), address(tsla), amt, minOut, alice));
            assertGe(out, minOut);
        }
    }

    // ---- H-1(a)(b)
    function test_zeroMinOutRejected() public {
        FeeRouter.SwapParams memory p = _params(address(usdg), address(tsla), 100e6, 1, alice);
        p.minAmountOut = 0;
        vm.prank(alice);
        vm.expectRevert(FeeRouter.ZeroMinOut.selector);
        router.swap(p);
    }

    function test_mandatoryOracleFloor() public {
        // adapter fills 5% below oracle -> router's mandatory 3% floor rejects even with minOut=1
        vm.prank(alice);
        vm.expectPartialRevert(FeeRouter.InsufficientOutput.selector);
        router.swap(_badParams(address(usdg), address(tsla), 100e6, alice));
        bad.setHaircut(200); // 2%: within default 3%
        vm.prank(alice);
        router.swap(_badParams(address(usdg), address(tsla), 100e6, alice));
        vm.prank(owner);
        router.setMaxSlippageBps(100); // owner tightens to 1%
        vm.prank(alice);
        vm.expectPartialRevert(FeeRouter.InsufficientOutput.selector);
        router.swap(_badParams(address(usdg), address(tsla), 100e6, alice));
    }

    function test_maxSlippageBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.SlippageOutOfBounds.selector, uint16(301)));
        router.setMaxSlippageBps(301);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.SlippageOutOfBounds.selector, uint16(0)));
        router.setMaxSlippageBps(0);
        vm.stopPrank();
    }
}
