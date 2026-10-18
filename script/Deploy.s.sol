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
import {MockStockToken} from "../src/mocks/MockStockToken.sol";

/// @notice Robinhood Chain TESTNET (46630) deployment. Hard-reverts on any other chain.
/// Mock-token path is keyed off an EXPLICIT MOCK_TOKENS=0|1 (NOT chain id: local anvil also runs as
/// 46630). Unset => revert. MOCK_TOKENS=0 with missing real-token code => revert.
/// Oracle starts in Session mode with no session => market CLOSED until the keeper pushes
/// setSession(...) (or the Safe sets ForceOpen for a testnet demo).
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

    error MockTokensFlagRequired();
    error RealTokenMissing(address token);

    /// @notice N-5: MOCK_TOKENS must be set explicitly to 0 or 1 (no silent fallback). With 0, every
    /// real stock-token address must have code, otherwise revert (wrong RPC / wrong chain fork).
    function useMocks() public view returns (bool) {
        uint256 flag = vm.envOr("MOCK_TOKENS", uint256(type(uint256).max));
        if (flag > 1) revert MockTokensFlagRequired();
        if (flag == 1) {
            console2.log("MOCK_TOKENS=1 -> deploying MOCK stock tokens");
            return true;
        }
        (address[5] memory t,) = stockTokens();
        for (uint256 i; i < 5; i++) {
            if (t[i].code.length == 0) revert RealTokenMissing(t[i]);
        }
        console2.log("MOCK_TOKENS=0 -> using REAL testnet stock tokens");
        return false;
    }

    /// @dev Must be called inside a broadcast when mocks are used (deploys MockStockTokens).
    function resolveTokens() public returns (address[5] memory t, string[5] memory s) {
        (t, s) = stockTokens();
        if (!useMocks()) return (t, s);
        for (uint256 i; i < 5; i++) {
            t[i] = address(new MockStockToken(string.concat(s[i], " (mock)"), s[i]));
        }
    }

    function run() external onlyTestnet {
        address safe = vm.envAddress("TREASURY_SAFE");
        address updater = vm.envAddress("FEED_UPDATER");
        address attester = vm.envAddress("ATTESTER");
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Core memory c = deployCore(deployer, safe, attester);
        address keeper = vm.envAddress("KEEPER"); // KMS-held: executes intents + pushes market sessions
        require(keeper != updater, "S-4: KEEPER and FEED_UPDATER must be different keys");
        c.router.setKeeper(keeper);
        c.oracle.setKeeper(keeper);
        (address[5] memory t, string[5] memory s) = resolveTokens();
        for (uint256 i; i < 5; i++) {
            MockAggregatorV3 f = new MockAggregatorV3(deployer, updater, 8, string.concat(s[i], " / USD"));
            c.oracle.setFeed(t[i], f, 1 hours);
            StockClawPool p = new StockClawPool(deployer, t[i], address(c.usdg), c.oracle, 20); // oracle-anchored, 20 bps spread
            p.setRouter(address(c.router));
            c.router.setAdapter(address(p), true);
            p.transferOwnership(safe);
            f.transferOwnership(safe);
            console2.log(s[i], address(f), address(p));
        }
        // Pool seeding happens in a separate script after feeds are pushed (quotes need a fresh price).
        // Ownership -> 2-of-3 Safe. Router, pools, oracle and feeds are Ownable2Step: this only sets
        // `pendingOwner`; the Safe must execute `acceptOwnership()` on each (batch via Safe tx builder).
        // Until accepted, the deployer remains owner (needed for seeding). Registry: Safe gets admin role.
        c.router.transferOwnership(safe);
        c.oracle.transferOwnership(safe);
        c.registry.grantRole(c.registry.DEFAULT_ADMIN_ROLE(), safe);
        vm.stopBroadcast();
    }

    function deployCore(address admin, address safe, address attester) public onlyTestnet returns (Core memory c) {
        c.usdg = new MockUSDG(admin);
        c.oracle = new PriceOracle(admin, address(c.usdg));
        c.registry = new EligibilityRegistry(admin, attester);
        c.router = new FeeRouter(admin, safe, ISignatureTransfer(PERMIT2), c.oracle, c.registry);
    }
}
