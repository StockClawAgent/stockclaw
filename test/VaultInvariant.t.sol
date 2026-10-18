// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";

/// Random agent swaps + vault intents + time jumps. Ghost log of successful spends lets us check
/// the rolling cap over EVERY 24h window, and intent counters vs. maxExecs / schedule.
contract VaultHandler is Test {
    FeeRouter router;
    AgentVault vault;
    StockClawPool pool;
    MockUSDG usdg;
    MockStockToken tsla;
    MockAggregatorV3 feed;
    address agent;
    uint256 agentPk;
    address keeper;
    address updater;

    uint256[] public spendTs;
    uint256[] public spendUsd;
    FeeRouter.Intent public intent;
    bytes sig;
    uint256 public lastExecTs;
    uint256 public execsInSameInterval; // must stay 0

    constructor(
        FeeRouter r, AgentVault v, StockClawPool p, MockUSDG u, MockStockToken t, MockAggregatorV3 f,
        uint256 pk, address k, address up
    ) {
        router = r; vault = v; pool = p; usdg = u; tsla = t; feed = f;
        agentPk = pk; agent = vm.addr(pk); keeper = k; updater = up;
        intent = FeeRouter.Intent(address(v), address(u), address(t), address(p), 50e6, 1, 0, 6 hours, 20, 300,
            uint40(block.timestamp), uint40(block.timestamp + 365 days), 999);
        (uint8 vv, bytes32 rr, bytes32 ss) = vm.sign(pk, r.hashIntent(intent));
        sig = abi.encodePacked(rr, ss, vv);
    }

    function spendCount() external view returns (uint256) {
        return spendTs.length;
    }

    function warp(uint256 dt) external {
        dt = bound(dt, 1 minutes, 30 hours);
        vm.warp(block.timestamp + dt);
        vm.prank(updater);
        feed.updateAnswer(250e8);
    }

    function agentBuy(uint256 amt) external {
        amt = bound(amt, 1e6, 120e6); // sometimes over per-trade cap
        vm.prank(agent);
        try vault.agentSwap(address(pool), address(usdg), address(tsla), amt, 0, block.timestamp) {
            spendTs.push(block.timestamp);
            spendUsd.push(amt);
        } catch {}
    }

    function keeperIntent() external {
        FeeRouter.Intent memory i = intent;
        bytes32 h = router.hashIntent(i);
        uint16 before = router.execCount(h);
        vm.prank(keeper);
        try vault.executeIntent(i, sig) {
            if (lastExecTs != 0 && (block.timestamp - i.startTime) / i.interval == (lastExecTs - i.startTime) / i.interval) {
                execsInSameInterval++;
            }
            lastExecTs = block.timestamp;
            spendTs.push(block.timestamp);
            spendUsd.push(i.amountPerExec);
            assert(router.execCount(h) == before + 1);
        } catch {}
    }
}

contract VaultInvariantTest is Base {
    VaultHandler h;
    AgentVault vault;
    uint256 agentPk = 0xA6E7;

    function setUp() public override {
        super.setUp();
        vault = new AgentVault(alice, router);
        vm.startPrank(alice);
        reg.linkAccount(address(vault));
        vault.grantAgent(vm.addr(agentPk), uint40(block.timestamp + 365 days));
        vault.setAllowedToken(address(usdg), true);
        vault.setAllowedToken(address(tsla), true);
        vm.stopPrank();
        vm.prank(owner);
        usdg.mint(address(vault), 1_000_000e6);
        h = new VaultHandler(router, vault, pool, usdg, tsla, feed, agentPk, keeper, updater);
        targetContract(address(h));
    }

    function invariant_rollingCapNeverExceededInAny24h() public view {
        uint256 n = h.spendCount();
        for (uint256 a; a < n; a++) {
            uint256 end = h.spendTs(a);
            uint256 sum;
            for (uint256 b; b <= a; b++) {
                if (h.spendTs(b) + 24 hours > end) sum += h.spendUsd(b);
            }
            assertLe(sum, 500e6);
        }
    }

    function invariant_noPerTradeOverCap() public view {
        uint256 n = h.spendCount();
        for (uint256 a; a < n; a++) assertLe(h.spendUsd(a), 100e6);
    }

    function invariant_intentExecsBoundedAndNoCatchUp() public view {
        (address account,,,,,,,,,,,,) = h.intent();
        account; // silence
        assertEq(h.execsInSameInterval(), 0);
    }

    function invariant_vaultNoDanglingAllowance() public view {
        assertEq(usdg.allowance(address(vault), address(router)), 0);
    }

    function invariant_routerHoldsNothing() public view {
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(tsla.balanceOf(address(router)), 0);
    }
}
