// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

contract DeployGuardTest is Test {
    Deploy d = new Deploy();

    function test_revertsOnLocalChain() public {
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, block.chainid));
        d.run();
    }

    function test_revertsOnMainnet4663() public {
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, uint256(4663)));
        d.run();
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, uint256(4663)));
        d.deployCore(address(this), address(1), address(2));
    }

    function testFuzz_revertsOnAnyOtherChain(uint64 id) public {
        vm.assume(id != 46630 && id != 0);
        vm.chainId(id);
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, uint256(id)));
        d.deployCore(address(this), address(1), address(2));
    }

    /// In-memory EVM simulation only (no RPC, no broadcast).
    function test_coreWiresOn46630() public {
        vm.chainId(46630);
        Deploy.Core memory c = d.deployCore(address(this), address(0x5AFE), address(2));
        assertEq(c.router.feeBps(), 30);
        assertEq(c.router.feeTreasury(), address(0x5AFE));
        assertEq(address(c.router.permit2()), d.PERMIT2());
    }

    /// One sequential test: env vars are process-global and tests run in parallel.
    function test_mockTokens_explicitFlagRequired() public {
        vm.chainId(46630); // plain anvil: no code at real addresses
        (address[5] memory t,) = d.stockTokens();
        vm.setEnv("MOCK_TOKENS", "2");
        vm.expectRevert(Deploy.MockTokensFlagRequired.selector);
        d.useMocks();
        vm.setEnv("MOCK_TOKENS", "0"); // explicit real path, but no code -> clear revert
        vm.expectRevert(abi.encodeWithSelector(Deploy.RealTokenMissing.selector, t[0]));
        d.useMocks();
        vm.setEnv("MOCK_TOKENS", "1");
        assertTrue(d.useMocks());
        (address[5] memory r,) = d.resolveTokens();
        assertTrue(r[0] != t[0] && r[0].code.length > 0);
        for (uint256 i; i < 5; i++) vm.etch(t[i], hex"00"); // simulate real tokens present
        vm.setEnv("MOCK_TOKENS", "0");
        assertFalse(d.useMocks());
    }
}

/// L3: registry admin + MockUSDG ownership handoff to the Safe (in-memory EVM only, no RPC/broadcast).
/// The Deploy contract itself acts as deployer here so its handoff() calls come from the admin.
contract DeployHandoffTest is Test {
    Deploy d = new Deploy();
    address safe = address(0x5AFE);
    address attester = address(0xA77E);

    function test_handoff_safeAdmin_deployerNoRoles_usdgPendingSafe() public {
        vm.chainId(46630);
        address deployer = address(d);
        Deploy.Core memory c = d.deployCore(deployer, safe, attester);
        // setup that needs the deployer happens before the handoff (e.g. seeding mints)
        vm.prank(deployer);
        c.usdg.mint(deployer, 1e6);
        d.handoff(c, deployer, safe, false);

        bytes32 admin = c.registry.DEFAULT_ADMIN_ROLE();
        bytes32 att = c.registry.ATTESTER_ROLE();
        assertTrue(c.registry.hasRole(admin, safe));
        assertFalse(c.registry.hasRole(admin, deployer));
        assertFalse(c.registry.hasRole(att, deployer));
        assertTrue(c.registry.hasRole(att, attester));

        // MockUSDG: 2-step -> Safe pending; deployer can still mint for seeding until accepted
        assertEq(c.usdg.pendingOwner(), safe);
        vm.prank(deployer);
        c.usdg.mint(deployer, 1e6);
        vm.prank(safe);
        c.usdg.acceptOwnership();
        assertEq(c.usdg.owner(), safe);
        vm.prank(deployer);
        vm.expectRevert();
        c.usdg.mint(deployer, 1e6);

        // the Safe administers the registry (e.g. rotates the attester)
        vm.prank(safe);
        c.registry.grantRole(att, address(0xA77F));
        vm.prank(deployer);
        vm.expectRevert();
        c.registry.grantRole(att, deployer);
    }

    /// ATTESTER == deployer without LOCAL_ANVIL: handoff refuses (defence in depth behind preflight).
    function test_handoff_deployerAsAttester_revertsWithoutLocalFlag() public {
        vm.chainId(46630);
        address deployer = address(d);
        Deploy.Core memory c = d.deployCore(deployer, safe, deployer);
        vm.expectRevert(abi.encodeWithSelector(Deploy.AttesterIsDeployer.selector, deployer));
        d.handoff(c, deployer, safe, false);
    }

    /// LOCAL_ANVIL=1 (server's verified anvil): deployer keeps only ATTESTER (service setEligible keeps working).
    function test_handoff_deployerAsAttester_localAnvil_keepsOnlyAttester() public {
        vm.chainId(46630);
        address deployer = address(d);
        Deploy.Core memory c = d.deployCore(deployer, safe, deployer);
        d.handoff(c, deployer, safe, true);
        assertFalse(c.registry.hasRole(c.registry.DEFAULT_ADMIN_ROLE(), deployer));
        assertTrue(c.registry.hasRole(c.registry.ATTESTER_ROLE(), deployer));
        assertEq(c.usdg.pendingOwner(), safe);
        vm.prank(deployer);
        c.registry.setEligible(address(0xB0B), uint64(block.timestamp + 1 days));
    }

    function test_preflight_attesterIsDeployer() public {
        address deployer = address(0xD0);
        vm.etch(safe, hex"00"); // Safe has code
        vm.expectRevert(abi.encodeWithSelector(Deploy.AttesterIsDeployer.selector, deployer));
        d.preflight(deployer, safe, deployer, false);
        d.preflight(deployer, safe, deployer, true); // LOCAL_ANVIL=1: allowed
        d.preflight(deployer, safe, attester, false); // separate attester: ok
    }

    function test_preflight_safeIsDeployer_revertsEvenLocal() public {
        address deployer = address(0xD0);
        vm.etch(deployer, hex"00"); // even with code
        vm.expectRevert(abi.encodeWithSelector(Deploy.SafeIsDeployer.selector, deployer));
        d.preflight(deployer, deployer, attester, false);
        vm.expectRevert(abi.encodeWithSelector(Deploy.SafeIsDeployer.selector, deployer));
        d.preflight(deployer, deployer, attester, true);
    }

    /// D-1: off LOCAL_ANVIL the Safe must be a contract; LOCAL_ANVIL=1 accepts the EOA stand-in.
    function test_preflight_safeNeedsCode() public {
        address deployer = address(0xD0);
        address eoaSafe = address(0x5AFE2);
        vm.expectRevert(abi.encodeWithSelector(Deploy.SafeHasNoCode.selector, eoaSafe));
        d.preflight(deployer, eoaSafe, attester, false);
        d.preflight(deployer, eoaSafe, attester, true);
        vm.etch(eoaSafe, hex"00");
        d.preflight(deployer, eoaSafe, attester, false);
    }

    /// LOCAL_ANVIL parsing is strict: only an explicit 1 enables it. Only this test sets LOCAL_ANVIL
    /// (env is process-global; the other tests pass the flag explicitly).
    function test_localAnvilFlag_explicitOnly() public {
        vm.setEnv("LOCAL_ANVIL", "0");
        assertFalse(d.localAnvil());
        vm.setEnv("LOCAL_ANVIL", "2");
        assertFalse(d.localAnvil());
        vm.setEnv("LOCAL_ANVIL", "1");
        assertTrue(d.localAnvil());
        vm.setEnv("LOCAL_ANVIL", "0");
    }
}
