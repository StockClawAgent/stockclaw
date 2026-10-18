// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {StockClawPool} from "../../src/StockClawPool.sol";
import {EligibilityRegistry} from "../../src/EligibilityRegistry.sol";
import {PriceOracle} from "../../src/oracle/PriceOracle.sol";
import {MockAggregatorV3} from "../../src/oracle/MockAggregatorV3.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {Deploy} from "../../script/Deploy.s.sol";

/// READ-ONLY fork of Robinhood Chain testnet (46630). Our contracts are deployed into the LOCAL fork
/// EVM only; nothing is broadcast. Skipped unless RH_TESTNET_RPC is set.
///   RH_TESTNET_RPC=https://rpc.testnet.chain.robinhood.com forge test --match-path test/fork/*
/// For each of the 5 real testnet stock tokens: buy (USDG->stock) and sell (stock->USDG) through
/// router -> pool, with the fee (input token) delivered to the Safe address. This is the review-1
/// M-5(c) check that issuer freeze/registry rules don't block router, pool or Safe.
contract RobinhoodForkTest is Test {
    address safe = 0x000000000000000000000000000000000000dEaD; // placeholder treasury on fork
    address user = makeAddr("forkUser");
    address keeper = makeAddr("forkKeeper");
    bool skipped;

    function setUp() public {
        string memory rpc = vm.envOr("RH_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) {
            skipped = true;
            return;
        }
        vm.createSelectFork(rpc);
        require(block.chainid == 46630, "not 46630");
    }

    function test_fork_allFiveStocks_routerPoolSafe() public {
        if (skipped) vm.skip(true);
        Deploy d = new Deploy();
        (address[5] memory t, string[5] memory s) = d.stockTokens();

        MockUSDG usdg = new MockUSDG(address(this));
        PriceOracle oracle = new PriceOracle(address(this), address(usdg));
        oracle.setMarketMode(PriceOracle.MarketMode.Open);
        EligibilityRegistry reg = new EligibilityRegistry(address(this), address(this));
        reg.setEligible(user, uint64(block.timestamp + 1 days));
        FeeRouter router = new FeeRouter(
            address(this), safe, ISignatureTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3), oracle, reg
        );
        router.setKeeper(keeper);

        for (uint256 i; i < 5; i++) {
            IERC20Metadata tok = IERC20Metadata(t[i]);
            assertGt(t[i].code.length, 0, "no code at token");
            uint8 dec = tok.decimals();
            console2.log(s[i], t[i], tok.symbol(), dec);

            MockAggregatorV3 f = new MockAggregatorV3(address(this), address(this), 8, s[i]);
            f.updateAnswer(100e8); // $100 placeholder price
            oracle.setFeed(t[i], f, 1 hours);
            StockClawPool pool = new StockClawPool(address(this), t[i], address(usdg), oracle, 20);
            pool.setRouter(address(router));
            router.setAdapter(address(pool), true);

            uint256 unit = 10 ** dec;
            deal(t[i], address(this), 1_000 * unit);
            deal(t[i], user, 10 * unit);
            usdg.mint(address(this), 100_000e6);
            usdg.mint(user, 10_000e6);
            tok.approve(address(pool), type(uint256).max);
            usdg.approve(address(pool), type(uint256).max);
            pool.addLiquidity(1_000 * unit, 100_000e6);

            vm.startPrank(user);
            usdg.approve(address(router), type(uint256).max);
            tok.approve(address(router), type(uint256).max);
            uint256 safeTokBefore = tok.balanceOf(safe);
            uint256 bought = router.swap(
                FeeRouter.SwapParams(address(pool), address(usdg), t[i], 1_000e6, 1, user, block.timestamp + 60)
            );
            uint256 sold = router.swap(
                FeeRouter.SwapParams(address(pool), t[i], address(usdg), unit, 1, user, block.timestamp + 60)
            );
            vm.stopPrank();
            assertGt(bought, 0);
            assertGt(sold, 0);
            assertEq(tok.balanceOf(safe) - safeTokBefore, unit * 30 / 10_000, "stock fee to Safe");
        }
        assertEq(usdg.balanceOf(safe), 5 * 3e6, "USDG fees to Safe");
    }
}
