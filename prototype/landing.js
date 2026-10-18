/* StockClaw landing page (#/). Separate from app.js; registers itself on the shared router table R. */
(function(){
const DIS='<p class="lp-disc">Stock tokens are not available to US persons or residents of restricted regions and are not shares. Final copy pending legal review.</p>';
const BADGE='<span class="lp-badge">Testnet, not real stocks</span>';
const BOTS=[
 ["steady-stacker","Steady Stacker",1,"The patient one. Shows up on schedule, every time.","Buys a fixed dollar amount on a schedule, split across a basket of tokens you choose.","It's Monday morning. Steady Stacker split $30 across TSLA, AMD and PLTR, $10 each, same as last week."],
 ["dip-hunter","Dip Hunter",1,"The bargain spotter. Waits for prices to slip.","Places buy orders at price drops you set, each paired with a sell order at a price you set.","TSLA dropped 4% this morning. Dip Hunter bought $50 at $238, then placed its sell order."],
 ["trend-flip","Trend Flip",0,"The trend watcher. Moves when the short-term line flips.","Buys when the 9-period EMA crosses above VWAP on the 1-minute chart, and sells when it crosses back below.","At 10:42, AMD's 9 EMA crossed above VWAP and Trend Flip bought $40. At 2:15 it crossed back below, and Trend Flip sold."],
 ["ai-thematic","AI Thematic",0,"The reader. Your AI follows the news so you don't have to.","Your AI reads news and earnings, then proposes allocation changes within your limits. You approve every trade.","After AMD's earnings call, your AI proposed moving $60 from PLTR to AMD. You approved it, and both trades went through."],
 ["weekend-edge","Weekend Edge",0,"The planner. Does its homework over the weekend.","Queues limit orders over the weekend for the Monday open.","On Sunday, Weekend Edge queued a $50 NFLX buy limit for Monday. It fills only if NFLX opens at or below the limit."]];
const FAQ=[["What are stock tokens?","Tokens on Robinhood Chain that track the price of a stock, traded here against USDG. They are not shares. In this demo they are testnet tokens from the Robinhood Chain faucet, with mock prices and no value."],["Who is eligible?","Not US persons, and not residents of the US, Canada, the UK, Switzerland, the UAE, Russia or sanctioned countries. We check your country, you sign an attestation with your wallet, and your smart wallet must be on our onchain eligibility list before it can trade. An identity-check provider is still being chosen."],["Do you hold my keys?","You own your wallet. We never hold its owner key. Your agent uses a limited key you can revoke anytime."],["What fees apply?","0.30% per trade, taken from the input token. Quotes are shown net of the fee."],["How do I stop my agent?","Revoke the agent key from the dashboard in one click. Keys also expire after 7 days."],["Are strategies advice?","No. They are templates: you choose the parameters and StockClaw executes them within your limits. Tools, not investment advice. Final copy pending."],["Is this real money?","No. This is a testnet demo; tokens and prices are mocks."]];
const bot=(id,n)=>window.SCEyes?SCEyes.html(id,n,144):`<img src="avatars/final-${id}.png" width="144" height="144" alt="${n} mascot">`;
function Landing(){return `<div class="lp">
<header class="lp-nav"><a class="lp-logo" href="#/"><img src="logo-lockup.svg" width="110" height="28" alt="StockClaw home"></a>
<nav aria-label="Main"><a href="#lp-how">How it works</a><a href="#lp-safety">Safety</a><a href="#lp-faq">FAQ</a><a class="lp-pill" href="#/onboarding/eligibility">Try the demo</a></nav></header>
<section class="lp-hero" aria-labelledby="lp-h1">
${(()=>{const F=[["ai-thematic","AI Thematic",84],["dip-hunter","Dip Hunter",104],["steady-stacker","Steady Stacker",128],["trend-flip","Trend Flip",104],["weekend-edge","Weekend Edge",84]];return `<div class="lp-fam" role="img" aria-label="The five StockClaw agents: ${F.map(f=>f[1]).join(", ")}">${F.map(([id,n,z],i)=>`<div class="lp-fm lp-fm${i}" aria-hidden="true">${window.SCEyes?SCEyes.html(id,"",z):`<img src="avatars/final-${id}-transparent.png" width="${z}" height="${z}" alt="">`}</div>`).join("")}</div>`})()}
<h1 id="lp-h1">Your agent trades<br>tokenized stocks.<br><em>You set the limits.</em></h1>
<p class="lp-sub">Pick an AI agent, connect your own AI, and let it trade tokenized stocks on Robinhood Chain within limits you set.</p>
<p class="lp-chips" aria-label="Tradeable on testnet">${["TSLA","AMZN","PLTR","NFLX","AMD"].map(t=>`<span class="lp-chip">${t}</span>`).join("")}${BADGE}</p>
<p class="lp-clients">Works in Claude <span aria-hidden="true">/</span> ChatGPT <span aria-hidden="true">/</span> Grok <span aria-hidden="true">/</span> Cursor, as an MCP connector for Robinhood Chain stock tokens and USDG.</p>
<div class="lp-cta"><a class="lp-btn" href="#/onboarding/eligibility">Try the testnet demo <span aria-hidden="true">→</span></a><a class="lp-ghost" href="#lp-wait">Join the waitlist</a></div>
</section>
<section class="lp-line" aria-labelledby="lp-bots"><h2 id="lp-bots" class="lp-meet">Meet the agents</h2>
<p class="lp-meet-note">Each agent is a set of rules you configure. The stories below are illustrative examples, not real results or performance claims. Tools, not investment advice. Final copy pending.</p>
<ol class="lp-intro">${BOTS.map(([id,n,live,intro,how,story],i)=>`<li class="${live?"":"soon"} ${i%2?"rev":""}">${bot(id,n)}<div class="lp-it"><h3>${n} <span class="lp-tag ${live?"live":""}">${live?"Live on testnet":"Coming soon"}</span></h3><p class="lp-intro-l">${intro}</p><p><span class="lp-lbl">Strategy</span>${how}</p><figure class="lp-story"><span class="lp-ill">Illustrative example, not a real result</span><blockquote>${story}</blockquote></figure></div></li>`).join("")}</ol></section>
<section class="lp-sec" id="lp-how" aria-labelledby="lp-how-h"><p class="lp-k">01</p><h2 id="lp-how-h">How it works</h2>
<ol class="lp-steps"><li><b>Check eligibility.</b> Answer a few questions, then sign an attestation with your wallet.</li><li><b>Set up your wallet.</b> A smart wallet owned by your own wallet.</li><li><b>Create an agent key.</b> Limited to $100 per trade, $500 per day, allowlisted tickers only.</li><li><b>Fund it.</b> Get testnet mUSDG from the in-app faucet.</li><li><b>Connect your client.</b> Paste the connector URL into Claude, ChatGPT, Grok or Cursor, then ask your agent to trade.</li></ol></section>
<section class="lp-sec" id="lp-safety" aria-labelledby="lp-safe-h"><p class="lp-k">02</p><h2 id="lp-safe-h">Safety and limits</h2>
<p class="lp-big">You own your wallet. We never hold its owner key. Your agent uses a limited key you can revoke anytime.</p>
<dl class="lp-facts"><div><dt>Per trade</dt><dd>Up to $100 on testnet</dd></div><div><dt>Per day</dt><dd>Up to $500 on testnet</dd></div><div><dt>Key lifetime</dt><dd>7 days, revoke in one click</dd></div><div><dt>Fee</dt><dd>0.30%, from the input token</dd></div></dl>
<p class="lp-muted">Quotes are shown net of the fee. Trades over a limit are blocked; you can raise limits from the dashboard.</p>
<p class="lp-tickers">Tradeable on testnet: <span class="lp-mono">TSLA AMZN PLTR NFLX AMD</span> ${BADGE}</p></section>
<section class="lp-sec" id="lp-faq" aria-labelledby="lp-faq-h"><p class="lp-k">03</p><h2 id="lp-faq-h">FAQ</h2>
${FAQ.map(([q,a])=>`<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</section>
<section class="lp-sec lp-wait" id="lp-wait" aria-labelledby="lp-wait-h"><h2 id="lp-wait-h">Get notified when it leaves testnet.</h2>
<form id="lp-form" novalidate><label for="lp-email">Email</label><div class="lp-row"><input id="lp-email" type="email" autocomplete="email" required placeholder="you@example.com" aria-describedby="lp-msg"><button class="lp-btn" type="submit">Join waitlist</button></div><p id="lp-msg" role="status"></p></form></section>
<footer class="lp-foot">${DIS}<p>Local testnet demo: mock tokens, simulated prices, simulated owner wallet. Tools, not investment advice. Final copy pending.</p><p>Terms · Privacy · Disclosures · Status</p></footer>
</div>`}
function LandingBind(){const f=document.getElementById("lp-form");if(!f)return;f.onsubmit=e=>{e.preventDefault();const i=f.querySelector("input"),m=document.getElementById("lp-msg");if(!i.checkValidity()){i.setAttribute("aria-invalid","true");m.textContent="Enter a valid email address.";i.focus();return}i.removeAttribute("aria-invalid");m.textContent="You're on the waitlist (mock, nothing is sent).";f.querySelector("button").disabled=true}}
function mark(){const p=(location.hash.slice(1)||"/").split("?")[0];document.body.classList.toggle("is-landing",!(p in R)||p==="/")}
R["/"]=[Landing,()=>{LandingBind();window.SCEyes&&SCEyes.init(document.querySelector(".lp"))}];
addEventListener("hashchange",mark);mark();render();
})();
