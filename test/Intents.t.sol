// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";
import {TokenChecks} from "../src/libraries/TokenChecks.sol";

contract IntentsTest is Base {
    function _intent(uint128 amt, uint64 limit, uint32 interval, uint16 execs, uint256 nonce)
        internal
        view
        returns (FeeRouter.Intent memory)
    {
        return FeeRouter.Intent({
            account: alice,
            tokenIn: address(usdg),
            tokenOut: address(tsla),
            adapter: address(pool),
            amountPerExec: amt,
            minOutPerExec: 0,
            limitPriceE8: limit,
            interval: interval,
            maxExecs: execs,
            maxOracleDevBps: 200,
            startTime: uint40(block.timestamp),
            expiry: uint40(block.timestamp + 30 days),
            nonce: nonce
        });
    }

    function test_limitBuy_executesWhenPriceAtOrBelow() public {
        FeeRouter.Intent memory i = _intent(1_000e6, 240e8, 0, 1, 1);
        i.maxOracleDevBps = 500; // pool lags oracle by ~4% in this scenario
        bytes memory sig = _sign(alicePk, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.LimitNotMet.selector, PRICE, uint64(240e8)));
        router.executeIntent(i, sig);

        _setPrice(240e8); // pool still at ~250 -> within 5% band
        vm.prank(keeper);
        uint256 out = router.executeIntent(i, sig);
        assertGt(out, 0);
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.IntentExhausted.selector);
        router.executeIntent(i, sig);
    }

    function test_limitSell() public {
        FeeRouter.Intent memory i = _intent(1e18, 260e8, 0, 1, 2);
        i.tokenIn = address(tsla);
        i.tokenOut = address(usdg);
        i.maxOracleDevBps = 0;
        bytes memory sig = _sign(alicePk, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.LimitNotMet.selector, PRICE, uint64(260e8)));
        router.executeIntent(i, sig);
    }

    function test_dca_schedule() public {
        FeeRouter.Intent memory i = _intent(100e6, 0, 1 days, 3, 3);
        bytes memory sig = _sign(alicePk, router.hashIntent(i));
        vm.prank(keeper);
        router.executeIntent(i, sig);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotYet.selector, uint256(i.startTime) + 1 days));
        router.executeIntent(i, sig);
        for (uint256 k = 1; k < 3; k++) {
            vm.warp(i.startTime + k * 1 days);
            _setPrice(PRICE);
            vm.prank(keeper);
            router.executeIntent(i, sig);
        }
        assertEq(router.execCount(router.hashIntent(i)), 3);
        assertEq(usdg.balanceOf(safe), 3 * 0.3e6);
    }

    function test_cancelNonce() public {
        FeeRouter.Intent memory i = _intent(100e6, 0, 1 days, 3, 4);
        bytes memory sig = _sign(alicePk, router.hashIntent(i));
        vm.prank(alice);
        router.cancelNonce(4);
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.NonceIsCancelled.selector);
        router.executeIntent(i, sig);
    }

    function test_badSig_notKeeper_expired() public {
        FeeRouter.Intent memory i = _intent(100e6, 0, 0, 1, 5);
        bytes memory bad = _sign(0xB0B, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.InvalidSignature.selector);
        router.executeIntent(i, bad);

        bytes memory sig = _sign(alicePk, router.hashIntent(i));
        vm.prank(bob);
        vm.expectRevert(FeeRouter.NotKeeper.selector);
        router.executeIntent(i, sig);

        vm.prank(owner);
        router.setPermissionlessExecution(true);
        vm.prank(bob);
        router.executeIntent(i, sig);

        FeeRouter.Intent memory j = _intent(100e6, 0, 0, 1, 6);
        j.expiry = uint40(block.timestamp + 10);
        sig = _sign(alicePk, router.hashIntent(j));
        vm.warp(block.timestamp + 11);
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.Expired.selector);
        router.executeIntent(j, sig);
    }

    function test_tamperedIntentRejected() public {
        FeeRouter.Intent memory i = _intent(100e6, 0, 0, 1, 7);
        bytes memory sig = _sign(alicePk, router.hashIntent(i));
        i.amountPerExec = 10_000e6;
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.InvalidSignature.selector);
        router.executeIntent(i, sig);
    }

    function test_oracleDeviationGuard() public {
        // Oracle says TSLA is cheaper (245) than pool (250): buying gives ~2% less than oracle-implied.
        _setPrice(245e8);
        FeeRouter.Intent memory i = _intent(100e6, 0, 0, 1, 8);
        i.maxOracleDevBps = 100; // tolerate 1%
        bytes memory sig = _sign(alicePk, router.hashIntent(i));
        vm.prank(keeper);
        vm.expectRevert(); // InsufficientOutput from pool/router
        router.executeIntent(i, sig);
    }

    function test_frozenAccount_failsCleanly_noFundsMoved() public {
        FeeRouter.Intent memory i = _intent(100e6, 0, 1 days, 2, 9);
        bytes memory sig = _sign(alicePk, router.hashIntent(i));
        tsla.setFrozen(alice, true);
        uint256 bal = usdg.balanceOf(alice);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(TokenChecks.AccountFrozen.selector, address(tsla), alice));
        router.executeIntent(i, sig);
        assertEq(usdg.balanceOf(alice), bal);
        assertEq(router.execCount(router.hashIntent(i)), 0);
        tsla.setFrozen(alice, false); // retry after unfreeze works
        vm.prank(keeper);
        router.executeIntent(i, sig);
    }

    function test_stockPausedDuringDCA() public {
        FeeRouter.Intent memory i = _intent(100e6, 0, 1 days, 2, 10);
        bytes memory sig = _sign(alicePk, router.hashIntent(i));
        tsla.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(TokenChecks.TokenPaused.selector, address(tsla)));
        router.executeIntent(i, sig);
    }

    function test_crossChainReplay_domainBindsChainId() public {
        FeeRouter.Intent memory i = _intent(100e6, 0, 0, 1, 11);
        bytes32 h1 = router.hashIntent(i);
        vm.chainId(46630);
        assertTrue(router.hashIntent(i) != h1);
    }
}
