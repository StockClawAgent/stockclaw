// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";
import {TokenChecks} from "../src/libraries/TokenChecks.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract FeeRouterTest is Base {
    function test_defaultFeeIs30() public view {
        assertEq(router.feeBps(), 30);
        assertEq(router.feeTreasury(), safe);
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
        vm.expectRevert(); // pool InsufficientOutput
        router.swap(p);

        p.adapter = bob;
        p.minAmountOut = 0;
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
        vm.expectRevert(abi.encodeWithSelector(TokenChecks.TokenPaused.selector, address(tsla)));
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
        assertEq(usdg.balanceOf(alice), 100_000e6); // nothing moved
        assertFalse(router.precheck(alice, address(usdg), address(tsla), 100e6, alice));
    }

    function test_revert_senderFrozen() public {
        tsla.setFrozen(alice, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenChecks.AccountFrozen.selector, address(tsla), alice));
        router.swap(_params(address(tsla), address(usdg), 1e18, 0, alice));
    }

    function test_revert_recipientFrozen() public {
        tsla.setFrozen(bob, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenChecks.AccountFrozen.selector, address(tsla), bob));
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, bob));
    }

    function test_revert_registry() public {
        tsla.setRegistryEnforced(true);
        tsla.setRegistered(address(pool), true);
        tsla.setRegistered(address(router), true);
        // alice not registered
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TokenChecks.TransferRestricted.selector, address(tsla), address(router), alice)
        );
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
        tsla.setRegistered(alice, true);
        vm.prank(alice);
        router.swap(_params(address(usdg), address(tsla), 100e6, 0, alice));
        assertTrue(router.precheck(alice, address(usdg), address(tsla), 100e6, alice));
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
            // only acceptable failure: zero output for dust
            assertEq(pool.quote(address(usdg), address(tsla), amt - amt * bps / 10_000), 0);
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
        minOut = bound(minOut, 0, q * 2);
        vm.prank(alice);
        if (minOut > q) {
            vm.expectRevert();
            router.swap(_params(address(usdg), address(tsla), amt, minOut, alice));
        } else {
            uint256 out = router.swap(_params(address(usdg), address(tsla), amt, minOut, alice));
            assertGe(out, minOut);
        }
    }
}
