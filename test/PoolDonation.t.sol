// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";
import {TokenTransfers} from "../src/libraries/TokenTransfers.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// F1 / R3-3 regression: direct transfers ("donations") into the pool must never enter reserves or pricing.
contract PoolDonationTest is Base {
    address griefer = address(0xBEEF); // NOT eligible

    function _net(uint256 amt) internal view returns (uint256) {
        return amt - amt * router.feeBps() / 10_000;
    }

    function _donateUsdg(uint256 amt) internal {
        vm.prank(owner);
        usdg.mint(griefer, amt);
        vm.prank(griefer);
        usdg.transfer(address(pool), amt);
    }

    /// Former DoS: a donation larger than the stock side used to make every buy revert InsufficientLiquidity.
    function test_donationAboveStockSide_buyStillFillsAtQuote() public {
        uint256 rs = pool.reserveStock();
        uint256 ru = pool.reserveUsdg();
        _donateUsdg(rs * PRICE / 1e8 / 1e12 * 101 / 100); // stock side value + 1%
        assertEq(pool.reserveUsdg(), ru); // donation not in reserves

        uint256 q = pool.quote(address(usdg), address(tsla), _net(10e6));
        uint256 b0 = tsla.balanceOf(alice);
        vm.prank(alice);
        router.swap(_params(address(usdg), address(tsla), 10e6, 1, alice));
        assertEq(tsla.balanceOf(alice) - b0, q);
        assertEq(pool.reserveStock(), rs - q);
        assertEq(pool.reserveUsdg(), ru + _net(10e6));

        // repeated buys keep working; no owner intervention needed
        vm.prank(alice);
        router.swap(_params(address(usdg), address(tsla), 10e6, 1, alice));
    }

    /// Former windfall: a donation just under the threshold handed the next buyer almost the whole stock side.
    function test_donationJustUnderThreshold_noWindfall() public {
        uint256 rs = pool.reserveStock();
        _donateUsdg(rs * PRICE / 1e8 / 1e12 * 99 / 100);
        uint256 q = pool.quote(address(usdg), address(tsla), _net(10e6));
        uint256 b0 = tsla.balanceOf(alice);
        vm.prank(alice);
        router.swap(_params(address(usdg), address(tsla), 10e6, 1, alice));
        uint256 got = tsla.balanceOf(alice) - b0;
        assertEq(got, q);
        assertLt(got, 1e17); // ~0.04 TSLA for $10, nowhere near the 1,000 TSLA side
    }

    function test_stockDonation_sellFillsAtQuote() public {
        tsla.mint(griefer, 50e18);
        vm.prank(griefer);
        tsla.transfer(address(pool), 50e18);
        uint256 q = pool.quote(address(tsla), address(usdg), _net(1e18));
        uint256 b0 = usdg.balanceOf(alice);
        vm.prank(alice);
        router.swap(_params(address(tsla), address(usdg), 1e18, 1, alice));
        assertEq(usdg.balanceOf(alice) - b0, q);
    }

    /// addLiquidity(0,0) no longer absorbs donations into reserves.
    function test_addLiquidityDoesNotSyncDonation() public {
        uint256 ru = pool.reserveUsdg();
        _donateUsdg(1_000e6);
        vm.prank(owner);
        pool.addLiquidity(0, 0);
        assertEq(pool.reserveUsdg(), ru);
        vm.prank(owner);
        pool.addLiquidity(0, 5e6);
        assertEq(pool.reserveUsdg(), ru + 5e6);
    }

    function test_removeLiquidity_accountedOnly() public {
        uint256 ru = pool.reserveUsdg();
        _donateUsdg(1_000e6);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StockClawPool.InsufficientLiquidity.selector, ru + 1, ru));
        pool.removeLiquidity(0, ru + 1, owner);
        vm.prank(owner);
        pool.removeLiquidity(0, 100e6, owner);
        assertEq(pool.reserveUsdg(), ru - 100e6);
        assertEq(usdg.balanceOf(address(pool)), ru - 100e6 + 1_000e6);
    }

    // ---------------------------------------------------------------- swap input check
    function test_swapRevertsWhenLessThanAmountInArrived() public {
        vm.prank(owner);
        pool.setRouter(address(this)); // act as router
        vm.prank(owner);
        usdg.mint(address(this), 10e6);
        usdg.transfer(address(pool), 9e6);
        vm.expectRevert(abi.encodeWithSelector(StockClawPool.InputNotReceived.selector, 9e6, 10e6));
        pool.swap(address(usdg), address(tsla), 10e6, 1, address(this));
        // exact amount arrived => fills at quote
        usdg.transfer(address(pool), 1e6);
        uint256 q = pool.quote(address(usdg), address(tsla), 10e6);
        assertEq(pool.swap(address(usdg), address(tsla), 10e6, 1, address(this)), q);
        assertEq(tsla.balanceOf(address(this)), q);
    }

    function test_swapZeroInputReverts() public {
        vm.prank(owner);
        pool.setRouter(address(this));
        vm.expectRevert(StockClawPool.ZeroInput.selector);
        pool.swap(address(usdg), address(tsla), 0, 1, address(this));
    }

    // ---------------------------------------------------------------- skim
    function test_skim_sweepsExactExcessBothTokens() public {
        uint256 rs = pool.reserveStock();
        uint256 ru = pool.reserveUsdg();
        _donateUsdg(777e6);
        tsla.mint(griefer, 3e18);
        vm.prank(griefer);
        tsla.transfer(address(pool), 3e18);
        address to = makeAddr("sweepTo");
        vm.expectEmit(true, false, false, true, address(pool));
        emit StockClawPool.Skimmed(to, 3e18, 777e6);
        vm.prank(owner);
        (uint256 s, uint256 u) = pool.skim(to);
        assertEq(s, 3e18);
        assertEq(u, 777e6);
        assertEq(tsla.balanceOf(to), 3e18);
        assertEq(usdg.balanceOf(to), 777e6);
        assertEq(pool.reserveStock(), rs);
        assertEq(pool.reserveUsdg(), ru);
        assertEq(tsla.balanceOf(address(pool)), rs);
        assertEq(usdg.balanceOf(address(pool)), ru);
    }

    function test_skim_onlyOwner() public {
        _donateUsdg(1e6);
        vm.prank(griefer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, griefer));
        pool.skim(griefer);
    }

    function test_skim_noExcessIsNoop() public {
        uint256 rs = pool.reserveStock();
        uint256 ru = pool.reserveUsdg();
        address to = makeAddr("sweepTo");
        vm.recordLogs();
        vm.prank(owner);
        (uint256 s, uint256 u) = pool.skim(to);
        assertEq(s, 0);
        assertEq(u, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(tsla.balanceOf(to), 0);
        assertEq(usdg.balanceOf(to), 0);
        assertEq(pool.reserveStock(), rs);
        assertEq(pool.reserveUsdg(), ru);
    }

    /// Restricted stock token refusing the transfer => clear TransferBlocked, nothing moves.
    function test_skim_blockedStockTransferReverts() public {
        tsla.mint(griefer, 1e18);
        vm.prank(griefer);
        tsla.transfer(address(pool), 1e18);
        _donateUsdg(1e6);
        address to = makeAddr("frozenTo");
        tsla.setFrozen(to, true);
        vm.prank(owner);
        vm.expectPartialRevert(TokenTransfers.TransferBlocked.selector);
        pool.skim(to);
        assertEq(usdg.balanceOf(to), 0);
        // to an allowed recipient it works
        vm.prank(owner);
        pool.skim(owner);
    }

    function testFuzz_donationNeverChangesFill(uint256 donation, uint256 amt) public {
        donation = bound(donation, 1, 5_000_000e6);
        amt = bound(amt, 1e6, 50_000e6);
        uint256 q = pool.quote(address(usdg), address(tsla), _net(amt));
        _donateUsdg(donation);
        uint256 b0 = tsla.balanceOf(alice);
        vm.prank(alice);
        router.swap(_params(address(usdg), address(tsla), amt, 1, alice));
        assertEq(tsla.balanceOf(alice) - b0, q);
        assertEq(usdg.balanceOf(address(pool)) - pool.reserveUsdg(), donation);
    }
}
