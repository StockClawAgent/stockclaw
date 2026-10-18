/* StockClaw landing page (#/). Separate from app.js; registers itself on the shared router table R. */
(function(){
const DIS='<p class="lp-disc">Stock tokens are not available to US persons or residents of restricted regions and are not shares. Final copy pending legal review.</p>';
const BADGE='<span class="lp-badge">Testnet, not real stocks</span>';
const BOTS=[
 ["steady-stacker","Steady Stacker","Buys a fixed dollar amount on a schedule, split across a basket.",1],
 ["dip-hunter","Dip Hunter","Places buy limits at set drops, each with a take-profit sell.",1],
 ["trend-flip","Trend Flip","Goes long or flat when price crosses its 9 EMA and VWAP.",0],
 ["ai-thematic","AI Thematic","Your AI proposes allocation changes; you approve every trade.",0],
 ["weekend-edge","Weekend Edge","Queues limit orders over the weekend for the Monday open.",0]];
const FAQ=[["What are stock tokens?","Tokens on Robinhood Chain that track the price of a stock, traded here against USDG. They are not shares. In this demo they are testnet tokens from the Robinhood Chain faucet, with mock prices and no value."],["Who is eligible?","Not US persons, and not residents of the US, Canada, the UK, Switzerland, the UAE, Russia or sanctioned countries. We check your country, you sign an attestation with your wallet, and your smart wallet must be on our onchain eligibility list before it can trade. An identity-check provider is still being chosen."],["Do you hold my keys?","You own your wallet. We never hold its owner key. Your agent uses a limited key you can revoke anytime."],["What fees apply?","0.30% per trade, taken from the input token. Quotes are shown net of the fee."],["How do I stop my agent?","Revoke the agent key from the dashboard in one click. Keys also expire after 7 days."],["Are strategies advice?","No. They are templates: you choose the parameters and StockClaw executes them within your limits. Tools, not investment advice. Final copy pending."],["Is this real money?","No. This is a testnet demo; tokens and prices are mocks."]];
const EYES={"steady-stacker":[[37.89,51.95,6.64,9.38],[61.52,51.95,6.64,8.98]],"dip-hunter":[[37.79,58.69,9.96,8.4,"l"],[62.4,58.69,9.96,8.4,"r"]],"trend-flip":[[46.88,63.48,5.47,7.03],[63.38,59.86,5.27,6.84]],"ai-thematic":[[40.92,53.52,5.27,7.03],[58.59,53.52,5.08,7.03]],"weekend-edge":[[38.67,55.18,8.59,9.18],[63.48,55.08,8.98,8.98]]};
const bot=(id,n)=>`<div class="lp-bot" data-bot><img src="avatars/eyeless-${id}-transparent.png" width="144" height="144" alt="${n} mascot" loading="lazy">${EYES[id].map(([x,y,w,h,a])=>`<span class="lp-eye ${a?"ang-"+a:""}" aria-hidden="true" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"></span>`).join("")}</div>`;
const coin=`<div class="lp-coin" aria-hidden="true"><div class="lp-coin-in"><div class="lp-face"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1.5"/><path d="M30 64 L44 48 L54 56 L70 36" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="70" cy="36" r="4" fill="currentColor"/></svg></div><div class="lp-edge"></div></div><div class="lp-shadow"></div></div>`;
function Landing(){return `<div class="lp">
<header class="lp-nav"><a class="lp-logo" href="#/"><img src="logo-lockup.svg" width="110" height="28" alt="StockClaw home"></a>
<nav aria-label="Main"><a href="#lp-how">How it works</a><a href="#lp-safety">Safety</a><a href="#lp-faq">FAQ</a><a class="lp-pill" href="#/onboarding/eligibility">Try the demo</a></nav></header>
<section class="lp-hero" aria-labelledby="lp-h1">
${coin}
<h1 id="lp-h1">Your agent trades.<br><em>You set the limits.</em></h1>
<p class="lp-sub">An MCP connector that lets AI agents in Claude, ChatGPT, Grok and Cursor trade Robinhood Chain stock tokens and USDG.</p>
<p class="lp-clients">Claude <span aria-hidden="true">/</span> ChatGPT <span aria-hidden="true">/</span> Grok <span aria-hidden="true">/</span> Cursor</p>
<div class="lp-cta"><a class="lp-btn" href="#/onboarding/eligibility">Try the testnet demo <span aria-hidden="true">→</span></a><a class="lp-ghost" href="#lp-wait">Join the waitlist</a></div>
</section>
<section class="lp-line" aria-labelledby="lp-bots"><h2 id="lp-bots" class="lp-sr">Strategy agents</h2>
<ul>${BOTS.map(([id,n,r,live])=>`<li class="${live?"":"soon"}">${bot(id,n)}<h3>${n}</h3><p>${r}</p><span class="lp-tag ${live?"live":""}">${live?"Live on testnet":"Coming soon"}</span></li>`).join("")}</ul>
<p class="lp-note">Tools, not investment advice. Final copy pending.</p></section>
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
// ---- bot eyes: cursor tracking (fine pointer) + idle glance/blink; pauses off-screen / hidden; static on reduced motion
const RM=matchMedia("(prefers-reduced-motion: reduce)"),FINE=matchMedia("(hover: hover) and (pointer: fine)");
let mx=0,my=0,lastMove=-1e9,raf=0,vis=true,bots=[];const rnd=(a,b)=>a+Math.random()*(b-a);
addEventListener("pointermove",e=>{if(e.pointerType==="mouse"||FINE.matches){mx=e.clientX;my=e.clientY;lastMove=performance.now();wake()}},{passive:true});
function eyesInit(){cancelAnimationFrame(raf);raf=0;const line=document.querySelector(".lp-line");if(!line)return;
 bots=[...line.querySelectorAll("[data-bot]")].map((el,i)=>({el,eyes:[...el.querySelectorAll(".lp-eye")],cx:0,cy:0,tx:0,ty:0,nextGlance:performance.now()+rnd(400,2500)+i*300,nextBlink:performance.now()+rnd(1500,5000)}));
 if(RM.matches)return;new IntersectionObserver(es=>{vis=es[0].isIntersecting;line.classList.toggle("lp-off",!vis);wake()}).observe(line);wake()}
function wake(){if(!raf&&vis&&!document.hidden&&!RM.matches&&bots.length&&bots[0].el.isConnected)raf=requestAnimationFrame(tick)}
document.addEventListener("visibilitychange",wake);RM.addEventListener?.("change",()=>location.hash==="#/"||!location.hash?render():0);
function tick(t){raf=0;if(!vis||document.hidden||!bots[0]?.el.isConnected)return;const track=FINE.matches&&t-lastMove<2500;
 for(const b of bots){const r=b.el.getBoundingClientRect(),mX=r.width*.045,mY=r.height*.03;
  if(track){const dx=mx-(r.left+r.width/2),dy=my-(r.top+r.height*.55),d=Math.hypot(dx,dy)||1,k=Math.min(1,d/220);b.tx=dx/d*k*mX;b.ty=dy/d*k*mY}
  else if(t>b.nextGlance){const look=Math.random();b.tx=look<.35?0:(Math.random()<.5?-1:1)*rnd(.5,1)*mX;b.ty=rnd(-.4,.6)*mY;b.nextGlance=t+rnd(1400,4800)}
  b.cx+=(b.tx-b.cx)*(track?.16:.09);b.cy+=(b.ty-b.cy)*(track?.16:.09);
  if(t>b.nextBlink){b.el.classList.add("blink");setTimeout(()=>b.el.classList.remove("blink"),130);b.nextBlink=t+(Math.random()<.15?180:rnd(2500,7000))}
  b.el.style.setProperty("--ex",b.cx.toFixed(2)+"px");b.el.style.setProperty("--ey",b.cy.toFixed(2)+"px")}
 raf=requestAnimationFrame(tick)}
R["/"]=[Landing,()=>{LandingBind();eyesInit()}];
addEventListener("hashchange",mark);mark();render();
})();
