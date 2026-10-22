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
/// L3 handoff (end of run): the Safe gets DEFAULT_ADMIN_ROLE on the EligibilityRegistry and the deployer
/// renounces DEFAULT_ADMIN_ROLE there. MockUSDG ownership is offered to the Safe (2-step).
/// Preflight (before any tx): ATTESTER == deployer reverts AttesterIsDeployer, TREASURY_SAFE == deployer
/// reverts SafeIsDeployer, and a TREASURY_SAFE without code reverts SafeHasNoCode (D-1). Only an explicit
/// LOCAL_ANVIL exactly "1" (set by the server's local deploy after it verified the node is anvil) relaxes the
/// attester rule (deployer keeps ATTESTER_ROLE, logged) and the Safe-code rule (EOA stand-in), and only if the
/// script's RPC answers anvil_nodeInfo and the deployer is anvil account #0. Safe != deployer always.
/// Post-deploy, in order: (1) seed pools (deployer mints mock USDG; still owner until accepted);
/// (2) Safe batch `acceptOwnership()` on router, oracle, pools, feeds AND MockUSDG.
/// NOT RUN YET. Usage (when approved):
///   TREASURY_SAFE=0x.. FEED_UPDATER=0x.. ATTESTER=0x.. \
///   forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --verify
contract Deploy is Script {
    uint256 public constant TESTNET_CHAIN_ID = 46630;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3; // bytecode present on 46630

    error WrongChain(uint256 chainId);
    error AttesterIsDeployer(address attester);
    error SafeIsDeployer(address safe);
    error SafeHasNoCode(address safe);
    error NotAnvilNode();
    error DeployerNotAnvilAccount0(address deployer);

    /// @notice anvil default account #0 (public test mnemonic); the only deployer allowed under LOCAL_ANVIL=1.
    address public constant ANVIL_ACCOUNT_0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

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
        bool local = localAnvil();
        preflight(deployer, safe, attester, local);
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
        // Until accepted, the deployer remains owner (needed for seeding).
        c.router.transferOwnership(safe);
        c.oracle.transferOwnership(safe);
        handoff(c, deployer, safe, local);
        vm.stopBroadcast();
    }

    /// @notice G2-a: true only when LOCAL_ANVIL is exactly the string "1" (the server / dry run set it after
    /// verifying the node is anvil). "01", "0x1", "1 ", "1e0", "true", "2", "0", empty and unset are all off.
    function localAnvil() public view returns (bool) {
        return isExactlyOne(vm.envOr("LOCAL_ANVIL", string("")));
    }

    function isExactlyOne(string memory v) public pure returns (bool) {
        return keccak256(bytes(v)) == keccak256(bytes("1"));
    }

    /// @notice L3 / D-1 role checks, run before any transaction is sent. G2-b: with `local` (LOCAL_ANVIL=1)
    /// the node behind the script's RPC must answer anvil_nodeInfo (else NotAnvilNode) and the deployer must
    /// be anvil account #0 (else DeployerNotAnvilAccount0), so a stale flag can't relax checks on a real chain.
    function preflight(address deployer, address safe, address attester, bool local) public {
        if (safe == deployer) revert SafeIsDeployer(safe);
        if (local) {
            if (!_isAnvilNode()) revert NotAnvilNode();
            if (deployer != ANVIL_ACCOUNT_0) revert DeployerNotAnvilAccount0(deployer);
        }
        if (!local && safe.code.length == 0) revert SafeHasNoCode(safe);
        if (!local && attester == deployer) revert AttesterIsDeployer(attester);
    }

    /// @dev RPC probe (virtual so unit tests can simulate anvil / non-anvil nodes without a live RPC).
    /// Any failure (method not found on a real node, no RPC at all) counts as "not anvil".
    function _isAnvilNode() internal virtual returns (bool) {
        try vm.rpc("anvil_nodeInfo", "[]") returns (bytes memory r) {
            return r.length != 0;
        } catch {
            return false;
        }
    }

    /// @notice L3: registry admin -> Safe, deployer renounces admin; MockUSDG ownership offered to the Safe
    /// (Ownable2Step: deployer can still mint for seeding until the Safe accepts). Runs LAST, after all
    /// setup that needs the deployer's registry admin. The deployer only holds ATTESTER_ROLE if it was
    /// configured as ATTESTER: allowed (kept, logged) only with `local` (LOCAL_ANVIL=1), else reverts.
    function handoff(Core memory c, address deployer, address safe, bool local) public {
        bytes32 admin = c.registry.DEFAULT_ADMIN_ROLE();
        c.registry.grantRole(admin, safe);
        c.registry.renounceRole(admin, deployer);
        if (c.registry.hasRole(c.registry.ATTESTER_ROLE(), deployer)) {
            if (!local) revert AttesterIsDeployer(deployer);
            console2.log("WARNING: deployer is ATTESTER and keeps ATTESTER_ROLE (LOCAL_ANVIL=1 only; testnet uses a separate key)");
        }
        c.usdg.transferOwnership(safe);
    }

    function deployCore(address admin, address safe, address attester) public onlyTestnet returns (Core memory c) {
        c.usdg = new MockUSDG(admin);
        c.oracle = new PriceOracle(admin, address(c.usdg));
        c.registry = new EligibilityRegistry(admin, attester);
        c.router = new FeeRouter(admin, safe, ISignatureTransfer(PERMIT2), c.oracle, c.registry);
    }
}
