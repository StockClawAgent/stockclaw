// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {StockClawPool} from "../src/StockClawPool.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {PriceOracle} from "../src/oracle/PriceOracle.sol";
import {MockAggregatorV3} from "../src/oracle/MockAggregatorV3.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";

/// @notice Robinhood Chain TESTNET (46630) deployment. Hard-reverts on any other chain.
/// NOT RUN YET. Usage (when approved):
///   TREASURY_SAFE=0x.. FEED_UPDATER=0x.. ATTESTER=0x.. \
///   forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --verify
contract Deploy is Script {
    uint256 public constant TESTNET_CHAIN_ID = 46630;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3; // bytecode present on 46630

    error WrongChain(uint256 chainId);

    struct Core {
        MockUSDG usdg;
        PriceOracle oracle;
        EligibilityRegistry registry;
        FeeRouter router;
    }

    modifier onlyTestnet() {
        if (block.chainid != TESTNET_CHAIN_ID) revert WrongChain(block.chainid);
        _;
    }

    function stockTokens() public pure returns (address[5] memory t, string[5] memory s) {
        // From third-party guide; symbol() confirmed onchain by Lucius. Confirm vs faucet before seeding.
        t = [
            0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E,
            0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02,
            0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0,
            0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93,
            0x71178BAc73cBeb415514eB542a8995b82669778d
        ];
        s = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];
    }

    function run() external onlyTestnet {
        address safe = vm.envAddress("TREASURY_SAFE");
        address updater = vm.envAddress("FEED_UPDATER");
        address attester = vm.envAddress("ATTESTER");
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Core memory c = deployCore(deployer, safe, attester);
        (address[5] memory t, string[5] memory s) = stockTokens();
        for (uint256 i; i < 5; i++) {
            MockAggregatorV3 f = new MockAggregatorV3(deployer, updater, 8, string.concat(s[i], " / USD"));
            c.oracle.setFeed(t[i], f, 1 hours);
            StockClawPool p = new StockClawPool(deployer, t[i], address(c.usdg), c.oracle, 500);
            p.setRouter(address(c.router));
            c.router.setAdapter(address(p), true);
            console2.log(s[i], address(f), address(p));
        }
        // Pool seeding happens in a separate script after feeds are pushed (band check needs a fresh price).
        // Ownership of router -> TREASURY_SAFE should be transferred (2-step) after smoke tests.
        vm.stopBroadcast();
    }

    function deployCore(address admin, address safe, address attester) public onlyTestnet returns (Core memory c) {
        c.usdg = new MockUSDG(admin);
        c.oracle = new PriceOracle(admin, address(c.usdg));
        c.registry = new EligibilityRegistry(admin, attester);
        c.router = new FeeRouter(admin, safe, ISignatureTransfer(PERMIT2), c.oracle, c.registry);
    }
}
