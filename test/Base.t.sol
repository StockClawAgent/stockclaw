// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {StockClawPool} from "../src/StockClawPool.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {PriceOracle} from "../src/oracle/PriceOracle.sol";
import {MockAggregatorV3} from "../src/oracle/MockAggregatorV3.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockPermit2} from "../src/mocks/MockPermit2.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";

/// Test-only adapter that fills at oracle price minus `haircutBps` (default 5%), ignoring minOut.
contract BadAdapter {
    PriceOracle oracle;
    uint256 public haircutBps = 500;

    constructor(PriceOracle o) {
        oracle = o;
    }

    function setHaircut(uint256 b) external {
        haircutBps = b;
    }

    function quote(address a, address b, uint256 amt) public view returns (uint256) {
        return oracle.convert(a, b, amt) * (10_000 - haircutBps) / 10_000;
    }

    function swap(address a, address b, uint256 amt, uint256, address to) external returns (uint256 out) {
        out = quote(a, b, amt);
        MockUSDG(b).transfer(to, out);
    }
}

abstract contract Base is Test {
    address owner = makeAddr("owner");
    address safe = makeAddr("safe2of3"); // fee treasury (2-of-3 Safe on testnet)
    address updater = makeAddr("updater");
    address attester = makeAddr("attester");
    address keeper = makeAddr("keeper");
    uint256 alicePk = 0xA11CE;
    address alice;
    address bob = makeAddr("bob");

    MockUSDG usdg;
    MockStockToken tsla;
    MockAggregatorV3 feed;
    PriceOracle oracle;
    EligibilityRegistry reg;
    MockPermit2 permit2;
    FeeRouter router;
    StockClawPool pool;
    BadAdapter bad;

    uint256 constant PRICE = 250e8; // $250 / TSLA

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        alice = vm.addr(alicePk);
        usdg = new MockUSDG(owner);
        tsla = new MockStockToken("Tesla (test)", "TSLA"); // issuer = this
        feed = new MockAggregatorV3(owner, updater, 8, "TSLA / USD");
        vm.prank(updater);
        feed.updateAnswer(int256(PRICE));
        oracle = new PriceOracle(owner, address(usdg));
        vm.prank(owner);
        oracle.setFeed(address(tsla), feed, 1 hours);
        reg = new EligibilityRegistry(owner, attester);
        permit2 = new MockPermit2();
        router = new FeeRouter(owner, safe, ISignatureTransfer(address(permit2)), oracle, reg);
        pool = new StockClawPool(owner, address(tsla), address(usdg), oracle, 20);
        bad = new BadAdapter(oracle);

        vm.startPrank(owner);
        router.setAdapter(address(pool), true);
        router.setAdapter(address(bad), true); // test-only: fills below oracle to exercise floors
        router.setKeeper(keeper);
        oracle.setMarketMode(PriceOracle.MarketMode.ForceOpen); // schedule tested separately
        pool.setRouter(address(router));
        usdg.mint(owner, 10_000_000e6);
        vm.stopPrank();
        tsla.mint(owner, 10_000e18);
        vm.startPrank(owner);
        tsla.approve(address(pool), type(uint256).max);
        usdg.approve(address(pool), type(uint256).max);
        pool.addLiquidity(1_000e18, 250_000e6);
        tsla.transfer(address(bad), 1_000e18);
        usdg.transfer(address(bad), 250_000e6);
        vm.stopPrank();

        _eligible(alice);
        vm.prank(owner);
        usdg.mint(alice, 100_000e6);
        tsla.mint(alice, 100e18);
        vm.startPrank(alice);
        usdg.approve(address(router), type(uint256).max);
        tsla.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _eligible(address a) internal {
        vm.prank(attester);
        reg.setEligible(a, uint64(block.timestamp + 365 days));
    }

    function _params(address tin, address tout, uint256 amt, uint256 minOut, address to)
        internal
        view
        returns (FeeRouter.SwapParams memory)
    {
        if (minOut == 0) minOut = 1; // H-1: minOut must be > 0 (router oracle floor still applies)
        return FeeRouter.SwapParams(address(pool), tin, tout, amt, minOut, to, block.timestamp + 60);
    }

    function _badParams(address tin, address tout, uint256 amt, address to)
        internal
        view
        returns (FeeRouter.SwapParams memory)
    {
        return FeeRouter.SwapParams(address(bad), tin, tout, amt, 1, to, block.timestamp + 60);
    }

    /// Price changes are rate-limited per hour (N-1): a different price advances time by 1h first.
    function _setPrice(uint256 p) internal {
        (, int256 cur,,,) = feed.latestRoundData();
        if (uint256(cur) != p) vm.warp(block.timestamp + 1 hours);
        vm.prank(updater);
        feed.updateAnswer(int256(p));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
