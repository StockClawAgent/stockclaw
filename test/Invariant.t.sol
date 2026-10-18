// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";

contract Handler is Test {
    FeeRouter router;
    StockClawPool pool;
    MockUSDG usdg;
    MockStockToken tsla;
    address trader;
    uint256 public feesExpected;

    constructor(FeeRouter r, StockClawPool p, MockUSDG u, MockStockToken t, address tr) {
        router = r;
        pool = p;
        usdg = u;
        tsla = t;
        trader = tr;
    }

    function buy(uint256 amt) external {
        amt = bound(amt, 1e6, 2_000e6);
        vm.prank(trader);
        try router.swap(FeeRouter.SwapParams(address(pool), address(usdg), address(tsla), amt, 1, trader, block.timestamp)) {
            feesExpected += amt * router.feeBps() / 10_000;
        } catch {}
    }

    function sell(uint256 amt) external {
        amt = bound(amt, 1e15, 8e18);
        vm.prank(trader);
        try router.swap(FeeRouter.SwapParams(address(pool), address(tsla), address(usdg), amt, 1, trader, block.timestamp)) {} catch {}
    }
}

contract InvariantTest is Base {
    Handler h;
    uint256 v0;

    function setUp() public override {
        super.setUp();
        h = new Handler(router, pool, usdg, tsla, alice);
        v0 = pool.valueUsd();
        targetContract(address(h));
    }

    function invariant_routerHoldsNothing() public view {
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(tsla.balanceOf(address(router)), 0);
    }

    /// Oracle price is constant in this handler: pool value at oracle never decreases (gains spread).
    function invariant_poolValueAtOracleNonDecreasing() public view {
        assertGe(pool.valueUsd() + 2, v0); // tolerance: usdValue rounding
    }

    function invariant_reservesMatchBalances() public view {
        assertEq(tsla.balanceOf(address(pool)), pool.reserveStock());
        assertEq(usdg.balanceOf(address(pool)), pool.reserveUsdg());
    }

    function invariant_usdgFeesToTreasury() public view {
        assertEq(usdg.balanceOf(safe), h.feesExpected());
    }
}
