// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {FeeRouter} from "./FeeRouter.sol";
import {PriceOracle} from "./oracle/PriceOracle.sol";

/// @title StockClaw AgentVault (Friday fallback for the ERC-4337 session-key module)
/// @notice Non-custodial per-user wallet: owner = the user's EOA. The owner grants AI-agent keys
/// scoped spending authority enforced onchain:
///   - per-trade cap   (default $100)   - USD, 6 dp
///   - per-day cap     (default $500)   - fixed UTC calendar-day window (see DESIGN_NOTES.md)
///   - token allowlist (default EMPTY => nothing tradable); BOTH tokenIn and tokenOut must be listed
///   - expiry + one-tx revocation
/// Any limit breach hard-reverts (no partial fills). USD value of `amountIn` comes from
/// PriceOracle (USDG pinned 1:1; stocks via Chainlink-style feed, staleness-checked).
/// Agents can only trade through StockClawRouter; outputs always return to this vault.
contract AgentVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint128 public constant DEFAULT_PER_TRADE_USD = 100e6;
    uint128 public constant DEFAULT_PER_DAY_USD = 500e6;

    /// slot0: perTradeUsd(16) + expiry(5) + active(1)
    /// slot1: perDayUsd(16) + spentTodayUsd(12)... packed as below
    struct AgentPolicy {
        uint128 perTradeUsd;
        uint40 expiry;
        bool active;
        uint128 perDayUsd;
        uint96 spentUsd; // within `day`
        uint32 day; // block.timestamp / 1 days
    }

    FeeRouter public immutable router;
    PriceOracle public immutable oracle;

    mapping(address agent => AgentPolicy) public policies;
    mapping(address token => bool) public allowedToken;

    event AgentGranted(address indexed agent, uint40 expiry, uint128 perTradeUsd, uint128 perDayUsd);
    event AgentRevoked(address indexed agent);
    event CapsSet(address indexed agent, uint128 perTradeUsd, uint128 perDayUsd);
    event TokenAllowed(address indexed token, bool allowed);
    event AgentSpent(address indexed agent, uint256 usd, uint256 spentToday);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotAgent();
    error AgentExpired();
    error TokenNotAllowed(address token);
    error PerTradeCapExceeded(uint256 usd, uint256 cap);
    error DailyCapExceeded(uint256 wouldSpend, uint256 cap);
    error InvalidParams();
    error WrongAccount();
    error BadAgentSignature();

    constructor(address owner_, FeeRouter router_) Ownable(owner_) {
        router = router_;
        oracle = router_.oracle();
    }

    // ================================================================ owner controls
    function grantAgent(address agent, uint40 expiry) external onlyOwner {
        if (agent == address(0) || expiry <= block.timestamp) revert InvalidParams();
        AgentPolicy storage p = policies[agent];
        p.expiry = expiry;
        p.active = true;
        if (p.perTradeUsd == 0 && p.perDayUsd == 0) {
            p.perTradeUsd = DEFAULT_PER_TRADE_USD;
            p.perDayUsd = DEFAULT_PER_DAY_USD;
        }
        emit AgentGranted(agent, expiry, p.perTradeUsd, p.perDayUsd);
    }

    function revokeAgent(address agent) external onlyOwner {
        policies[agent].active = false;
        emit AgentRevoked(agent);
    }

    function setCaps(address agent, uint128 perTradeUsd, uint128 perDayUsd) external onlyOwner {
        if (perTradeUsd > perDayUsd || perDayUsd > type(uint96).max) revert InvalidParams();
        policies[agent].perTradeUsd = perTradeUsd;
        policies[agent].perDayUsd = perDayUsd;
        emit CapsSet(agent, perTradeUsd, perDayUsd);
    }

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    /// @notice Owner trades without caps (it's their wallet).
    function ownerSwap(FeeRouter.SwapParams calldata p) external onlyOwner nonReentrant returns (uint256) {
        return _routerSwap(p);
    }

    // ================================================================ agent actions
    function agentSwap(address adapter, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256)
    {
        _consume(msg.sender, tokenIn, tokenOut, amountIn);
        return _routerSwap(FeeRouter.SwapParams(adapter, tokenIn, tokenOut, amountIn, minOut, address(this), deadline));
    }

    /// @notice Keeper entrypoint for agent-signed intents (DCA / limit). The agent signs the router's
    /// EIP-712 intent digest with `account = this vault`. Caps are charged per execution, at execution time.
    function executeIntent(FeeRouter.Intent calldata i, bytes calldata agentSig)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (i.account != address(this)) revert WrongAccount();
        address agent = ECDSA.recover(router.hashIntent(i), agentSig);
        if (policies[agent].expiry == 0) revert BadAgentSignature();
        _consume(agent, i.tokenIn, i.tokenOut, i.amountPerExec);
        IERC20(i.tokenIn).forceApprove(address(router), i.amountPerExec);
        out = router.executeIntent(i, "");
        IERC20(i.tokenIn).forceApprove(address(router), 0);
    }

    /// @notice Owner or any active agent can cancel a vault intent nonce.
    function cancelIntent(uint256 nonce) external {
        if (msg.sender != owner()) {
            AgentPolicy memory p = policies[msg.sender];
            if (!p.active || block.timestamp > p.expiry) revert NotAgent();
        }
        router.cancelNonce(nonce);
    }

    /// @notice Direct ERC-1271 validation is disabled so nobody can bypass caps by having the
    /// router pull funds on a signature alone; vault intents must go through `executeIntent`.
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }

    // ================================================================ views
    function remainingToday(address agent) external view returns (uint256 usdLeft, uint256 perTrade) {
        AgentPolicy memory p = policies[agent];
        uint256 spent = p.day == uint32(block.timestamp / 1 days) ? p.spentUsd : 0;
        usdLeft = p.perDayUsd > spent ? p.perDayUsd - spent : 0;
        perTrade = p.perTradeUsd;
    }

    // ================================================================ internals
    function _consume(address agent, address tokenIn, address tokenOut, uint256 amountIn) internal {
        AgentPolicy memory p = policies[agent];
        if (!p.active) revert NotAgent();
        if (block.timestamp > p.expiry) revert AgentExpired();
        if (!allowedToken[tokenIn]) revert TokenNotAllowed(tokenIn);
        if (!allowedToken[tokenOut]) revert TokenNotAllowed(tokenOut);

        uint256 usd = oracle.usdValue(tokenIn, amountIn);
        if (usd > p.perTradeUsd) revert PerTradeCapExceeded(usd, p.perTradeUsd);

        uint32 today = uint32(block.timestamp / 1 days);
        uint256 spent = p.day == today ? p.spentUsd : 0;
        uint256 newSpent = spent + usd;
        if (newSpent > p.perDayUsd) revert DailyCapExceeded(newSpent, p.perDayUsd);

        policies[agent].spentUsd = uint96(newSpent);
        policies[agent].day = today;
        emit AgentSpent(agent, usd, newSpent);
    }

    function _routerSwap(FeeRouter.SwapParams memory p) internal returns (uint256 out) {
        IERC20(p.tokenIn).forceApprove(address(router), p.amountIn);
        out = router.swap(p);
        IERC20(p.tokenIn).forceApprove(address(router), 0);
    }
}
