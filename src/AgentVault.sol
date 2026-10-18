// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {FeeRouter} from "./FeeRouter.sol";
import {PriceOracle} from "./oracle/PriceOracle.sol";
import {TokenTransfers} from "./libraries/TokenTransfers.sol";

/// @title StockClaw AgentVault (the per-user agent wallet; CTO decision: AgentVault only, no 4337 module)
/// @notice Non-custodial per-user wallet: owner = the user's EOA. The owner grants AI-agent keys
/// scoped spending authority enforced onchain:
///   - per-trade cap   (default $100)   - USD, 6 dp
///   - per-day cap     (default $500)   - ROLLING 24h window, 25 hourly buckets (see below);
///                                        per agent key AND per vault (all keys share $500)
///   - token allowlist (default EMPTY => nothing tradable); BOTH tokenIn and tokenOut must be listed
///   - expiry + one-tx revocation
/// Any limit breach hard-reverts (no partial fills). USD value of `amountIn` comes from
/// PriceOracle (USDG pinned 1:1; stocks via Chainlink-style feed, staleness-checked).
/// Agents can only trade through StockClawRouter; outputs always return to this vault.
/// Exit exemption (CTO decision): a sell of an allowlisted stock into USDG (tokenOut == oracle.usdg(),
/// tokenIn != USDG) through a router-registered adapter that serves exactly that pair, delivered to
/// this vault, does NOT count toward the rolling 24h caps (agent or vault). It still needs the
/// $100 per-trade cap, the allowlist, the oracle floor and market hours. Buys and token->token count.
/// R4-1 (user/CTO decision): those exempt sells have their OWN per-vault rolling 24h SELL cap
/// (protocol max $500, owner can lower, never raise; same 25-bucket ring, separate from buys).
/// Beyond it, agent sells consume an owner sell allowance - set directly by the owner (approveSell)
/// or from an owner-signed EIP-712 SellApproval submitted by anyone (approveSellWithSig) - else they
/// revert VaultSellCapExceeded and the server queues them offchain. Owner trades (ownerSwap) are uncapped.
///
/// Rolling window: spend is recorded in hourly buckets (ring of 25, two buckets per storage word,
/// 13 words). A check sums buckets for hours [now-24h, now]. A spend therefore stops counting
/// between 24h and 25h after it happened - conservative: the cap can never be exceeded within ANY
/// 24h period (incl. across midnight); worst case the user waits up to 1h longer than strict 24h.
contract AgentVault is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// Protocol-level HARD maximums (CTO decision, review-1 L-2). Owners can only lower them.
    uint128 public constant MAX_PER_TRADE_USD = 100e6;
    uint128 public constant MAX_PER_DAY_USD = 500e6;
    uint128 public constant MAX_SELL_PER_DAY_USD = 500e6;
    uint40 public constant MAX_SELL_APPROVAL_TTL = 7 days;
    bytes32 public constant SELL_APPROVAL_TYPEHASH =
        keccak256("SellApproval(address vault,uint256 amountUsd,uint256 expiry,uint256 nonce)");
    uint128 public constant DEFAULT_PER_TRADE_USD = MAX_PER_TRADE_USD;
    uint128 public constant DEFAULT_PER_DAY_USD = MAX_PER_DAY_USD;

    /// slot0: perTradeUsd(16) + expiry(5) + active(1); slot1: perDayUsd(16)
    struct AgentPolicy {
        uint128 perTradeUsd;
        uint40 expiry;
        bool active;
        uint128 perDayUsd;
    }

    uint256 internal constant BUCKETS = 25;

    FeeRouter public immutable router;
    PriceOracle public immutable oracle;

    mapping(address agent => AgentPolicy) public policies;
    mapping(address token => bool) public allowedToken;

    /// Vault-wide agent sell cap per rolling 24h (<= MAX_SELL_PER_DAY_USD).
    uint128 public sellCapUsd = MAX_SELL_PER_DAY_USD;

    /// Owner sell allowance (one active approval; a new one replaces it). One slot.
    struct SellAllowance {
        uint128 amountUsd;
        uint40 expiry;
        uint64 nonce;
    }

    SellAllowance public sellAllowance;
    mapping(uint256 nonce => bool) public sellNonceUsed;
    /// word w holds buckets 2w (low 128 bits) and 2w+1 (high); bucket = hour(32) | usd(96)
    mapping(address agent => uint256[13]) internal _buckets;

    event AgentGranted(address indexed agent, uint40 expiry, uint128 perTradeUsd, uint128 perDayUsd);
    event AgentRevoked(address indexed agent);
    event CapsSet(address indexed agent, uint128 perTradeUsd, uint128 perDayUsd);
    event TokenAllowed(address indexed token, bool allowed);
    event AgentSpent(address indexed agent, uint256 usd, uint256 spentToday);
    event SellCapSet(address indexed vault, uint256 capUsd);
    event SellApproved(address indexed vault, uint256 amountUsd, uint256 expiry, uint256 nonce);
    event SellAllowanceUsed(address indexed vault, uint256 amountUsd, uint256 remaining);
    event SellApprovalCancelled(address indexed vault, uint256 nonce);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotAgent();
    error AgentExpired();
    error TokenNotAllowed(address token);
    error PerTradeCapExceeded(uint256 usd, uint256 cap);
    error DailyCapExceeded(uint256 wouldSpend, uint256 cap);
    error InvalidParams();
    error WrongAccount();
    error BadAgentSignature();
    error NotKeeper();
    error CapAboveProtocolMax();
    error VaultDailyCapExceeded(uint256 wouldSpend, uint256 cap);
    error VaultSellCapExceeded(address vault, uint256 needUsd, uint256 remainingUsd);
    error BadSellApproval();
    error SellNonceUsed(uint256 nonce);

    constructor(address owner_, FeeRouter router_) Ownable(owner_) EIP712("StockClawVault", "1") {
        router = router_;
        oracle = router_.oracle();
    }

    // ================================================================ owner controls
    function grantAgent(address agent, uint40 expiry) external onlyOwner {
        // address(0)/address(1) are reserved bucket keys (vault buys / vault sells)
        if (uint160(agent) <= 1 || expiry <= block.timestamp) revert InvalidParams();
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
        if (perTradeUsd > MAX_PER_TRADE_USD || perDayUsd > MAX_PER_DAY_USD) revert CapAboveProtocolMax();
        if (perTradeUsd == 0 || perTradeUsd > perDayUsd) revert InvalidParams();
        policies[agent].perTradeUsd = perTradeUsd;
        policies[agent].perDayUsd = perDayUsd;
        emit CapsSet(agent, perTradeUsd, perDayUsd);
    }

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    // ================================================================ sell cap & approvals (R4-1)
    /// @notice Owner may lower (never raise above $500) the vault's rolling-24h agent sell cap.
    function setSellCap(uint128 capUsd) external onlyOwner {
        if (capUsd > MAX_SELL_PER_DAY_USD) revert CapAboveProtocolMax();
        sellCapUsd = capUsd;
        emit SellCapSet(address(this), capUsd);
    }

    /// @notice Path 1 (direct): owner approves `amountUsd` (6 dp) of agent sells beyond the cap, a
    /// batch allowance until `expiry` (<= now + 7 days). Replaces any active approval. Nonce single-use.
    function approveSell(uint128 amountUsd, uint40 expiry, uint64 nonce) external onlyOwner {
        _setSellApproval(amountUsd, expiry, nonce);
    }

    /// @notice Path 2: anyone (keeper/server) submits an owner-signed EIP-712 SellApproval.
    function approveSellWithSig(uint128 amountUsd, uint40 expiry, uint64 nonce, bytes calldata ownerSig) external {
        if (!SignatureChecker.isValidSignatureNow(owner(), sellApprovalDigest(amountUsd, expiry, nonce), ownerSig)) {
            revert BadSellApproval();
        }
        _setSellApproval(amountUsd, expiry, nonce);
    }

    /// @notice Burn `nonce` and clear the active approval if it is that nonce.
    function cancelSellApproval(uint64 nonce) external onlyOwner {
        sellNonceUsed[nonce] = true;
        if (sellAllowance.nonce == nonce) delete sellAllowance;
        emit SellApprovalCancelled(address(this), nonce);
    }

    /// @notice EIP-712 digest the owner's wallet signs (domain StockClawVault/1, chainId, this vault).
    function sellApprovalDigest(uint128 amountUsd, uint40 expiry, uint64 nonce) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(SELL_APPROVAL_TYPEHASH, address(this), amountUsd, expiry, nonce)));
    }

    function _setSellApproval(uint128 amountUsd, uint40 expiry, uint64 nonce) internal {
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_SELL_APPROVAL_TTL) revert BadSellApproval();
        if (sellNonceUsed[nonce]) revert SellNonceUsed(nonce);
        sellNonceUsed[nonce] = true;
        sellAllowance = SellAllowance(amountUsd, expiry, nonce);
        emit SellApproved(address(this), amountUsd, expiry, nonce);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        TokenTransfers.transfer(token, to, amount);
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
        _consume(msg.sender, adapter, tokenIn, tokenOut, amountIn);
        // H-1(d): never weaker than the oracle-implied amount minus the router's max slippage.
        uint256 net = amountIn - amountIn * router.feeBps() / 10_000;
        uint256 floor = oracle.convert(tokenIn, tokenOut, net) * (10_000 - router.maxSlippageBps()) / 10_000;
        if (floor > minOut) minOut = floor;
        return _routerSwap(FeeRouter.SwapParams(adapter, tokenIn, tokenOut, amountIn, minOut, address(this), deadline));
    }

    /// @notice Keeper entrypoint for agent-signed intents (DCA / limit). The agent signs the router's
    /// EIP-712 intent digest with `account = this vault`. Caps are charged per execution, at execution time.
    function executeIntent(FeeRouter.Intent calldata i, bytes calldata agentSig)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (msg.sender != router.keeper() && msg.sender != owner()) revert NotKeeper();
        if (i.account != address(this)) revert WrongAccount();
        address agent = ECDSA.recover(router.hashIntent(i), agentSig);
        if (policies[agent].expiry == 0) revert BadAgentSignature();
        _consume(agent, i.adapter, i.tokenIn, i.tokenOut, i.amountPerExec);
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
    /// Bucket-ring key for vault-wide spend (no agent can be address(0)).
    address internal constant VAULT_KEY = address(0);
    /// Bucket-ring key for vault-wide agent SELL volume (separate window from buys).
    address internal constant SELL_KEY = address(1);

    /// @notice Vault-wide rolling-24h spend across ALL agent keys (capped at MAX_PER_DAY_USD).
    function vaultSpentLast24h() public view returns (uint256) {
        return spentLast24h(VAULT_KEY);
    }

    function spentLast24h(address agent) public view returns (uint256 total) {
        uint256 cur = block.timestamp / 1 hours;
        uint256[13] storage b = _buckets[agent];
        for (uint256 w; w < 13; ++w) {
            uint256 word = b[w];
            if (word == 0) continue;
            for (uint256 half; half < 2; ++half) {
                uint256 bk = word >> (128 * half);
                uint256 hr = uint32(bk >> 96);
                if (hr + 24 >= cur && hr <= cur) total += uint96(bk);
            }
        }
    }

    /// @notice Agent sells (stock -> USDG) counted in the rolling 24h sell window.
    function vaultSoldLast24h() public view returns (uint256) {
        return spentLast24h(SELL_KEY);
    }

    /// @notice Convenience: sell-cap headroom + live owner allowance (what the agent can still sell).
    function exitRemaining()
        public
        view
        returns (uint256 capLeftUsd, uint256 allowanceUsd, uint256 allowanceExpiry, uint256 totalUsd)
    {
        uint256 sold = vaultSoldLast24h();
        uint256 cap = sellCapUsd;
        capLeftUsd = cap > sold ? cap - sold : 0;
        SellAllowance memory a = sellAllowance;
        if (a.expiry >= block.timestamp) {
            allowanceUsd = a.amountUsd;
            allowanceExpiry = a.expiry;
        }
        totalUsd = capLeftUsd + allowanceUsd;
    }

    function remainingToday(address agent) external view returns (uint256 usdLeft, uint256 perTrade) {
        AgentPolicy memory p = policies[agent];
        uint256 spent = spentLast24h(agent);
        usdLeft = p.perDayUsd > spent ? p.perDayUsd - spent : 0;
        uint256 vs = vaultSpentLast24h();
        uint256 vaultLeft = MAX_PER_DAY_USD > vs ? MAX_PER_DAY_USD - vs : 0;
        if (vaultLeft < usdLeft) usdLeft = vaultLeft;
        perTrade = p.perTradeUsd;
    }

    // ================================================================ internals
    /// @notice True iff this trade is an exempt exit (stock -> USDG via a registered pool for that pair).
    /// The recipient is always this vault on every agent path (agentSwap hardcodes it; intents use
    /// account = this vault and the router delivers to the account).
    function isExemptExit(address adapter, address tokenIn, address tokenOut) public view returns (bool) {
        address u = oracle.usdg();
        return tokenOut == u && tokenIn != u && router.isRouteSupported(adapter, tokenIn, tokenOut);
    }

    function _consume(address agent, address adapter, address tokenIn, address tokenOut, uint256 amountIn)
        internal
    {
        AgentPolicy memory p = policies[agent];
        if (!p.active) revert NotAgent();
        if (block.timestamp > p.expiry) revert AgentExpired();
        if (!allowedToken[tokenIn]) revert TokenNotAllowed(tokenIn);
        if (!allowedToken[tokenOut]) revert TokenNotAllowed(tokenOut);

        uint256 usd = oracle.usdValue(tokenIn, amountIn);
        if (usd > p.perTradeUsd) revert PerTradeCapExceeded(usd, p.perTradeUsd);

        if (isExemptExit(adapter, tokenIn, tokenOut)) {
            _consumeSell(usd); // sells use the separate sell window (+ owner allowance), not the buy cap
            emit AgentSpent(agent, usd, spentLast24h(agent));
            return;
        }

        uint256 newSpent = spentLast24h(agent) + usd;
        if (newSpent > p.perDayUsd) revert DailyCapExceeded(newSpent, p.perDayUsd);
        // S-2 (CTO): the $500 rolling cap is per VAULT - all agent keys share it, so revoking and
        // re-granting keys cannot reset the window.
        uint256 vaultSpent = vaultSpentLast24h() + usd;
        if (vaultSpent > MAX_PER_DAY_USD) revert VaultDailyCapExceeded(vaultSpent, MAX_PER_DAY_USD);
        _record(agent, usd);
        _record(VAULT_KEY, usd);
        emit AgentSpent(agent, usd, newSpent);
    }

    /// @dev Sell window first, then owner allowance for the remainder; else revert (all-or-nothing).
    function _consumeSell(uint256 usd) internal {
        (uint256 capLeft, uint256 allow,,) = exitRemaining();
        uint256 fromCap = usd < capLeft ? usd : capLeft;
        uint256 fromAllowance = usd - fromCap;
        if (fromAllowance > allow) revert VaultSellCapExceeded(address(this), usd, capLeft + allow);
        if (fromCap != 0) _record(SELL_KEY, fromCap);
        if (fromAllowance != 0) {
            uint256 rem = allow - fromAllowance;
            sellAllowance.amountUsd = uint128(rem);
            emit SellAllowanceUsed(address(this), fromAllowance, rem);
        }
    }

    function _record(address key, uint256 usd) internal {
        uint256 cur = block.timestamp / 1 hours;
        // Ring index, not randomness.
        // slither-disable-next-line weak-prng
        uint256 idx = cur % BUCKETS;
        uint256 w = idx >> 1;
        uint256 shift = 128 * (idx & 1);
        uint256 word = _buckets[key][w];
        uint256 bk = (word >> shift) & type(uint128).max;
        // Exact hour match is intended (same bucket epoch); not a balance check.
        // slither-disable-next-line incorrect-equality
        uint256 amt = uint32(bk >> 96) == cur ? uint96(bk) + usd : usd; // stale bucket => reset
        uint256 nb = (cur << 96) | amt;
        _buckets[key][w] = (word & ~(uint256(type(uint128).max) << shift)) | (nb << shift);

    }

    function _routerSwap(FeeRouter.SwapParams memory p) internal returns (uint256 out) {
        IERC20(p.tokenIn).forceApprove(address(router), p.amountIn);
        out = router.swap(p);
        IERC20(p.tokenIn).forceApprove(address(router), 0);
    }
}
