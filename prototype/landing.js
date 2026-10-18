/* StockClaw landing page (#/). Separate from app.js; registers itself on the shared router table R. */
(function(){
const DIS='<p class="lp-disc">Stock tokens are not available to US persons or residents of restricted regions and are not shares. Final copy pending legal review.</p>';
const BADGE='<span class="lp-badge">Testnet, not real stocks</span>';
const WE_NAME="Weekend Edge"; // rename here only (pending Julius)
const BOTS=[
 ["steady-stacker","Steady Stacker",1,"The routine one. Buys on the schedule you set.","Buys a fixed dollar amount on a schedule, split across a basket of tokens you choose.","Monday morning: Steady Stacker split $30 across AMD, PLTR and NFLX, $10 each, same as last week."],
 ["dip-hunter","Dip Hunter",1,"The patient one. Waits for the price drops you pick.","Places a buy order when a token drops by the percentage you set, and pairs it with a sell order at a price you set.","AMD fell 4% this morning. Dip Hunter bought $50 and placed your sell order. The sell may never fill."],
 ["trend-flip","Trend Flip",0,"The rule follower. Acts when one line crosses another.","Buys when the 9-period EMA (a short-term average) crosses above VWAP (the volume-weighted average price) on the 1-minute chart, and sells when it crosses back below. Signals can flip often and lose money.","At 10:42 (your local time), AMD's 9 EMA crossed above VWAP and Trend Flip bought $40. At 2:15 (your local time) it crossed back below, and Trend Flip sold."],
 ["ai-thematic","AI Thematic",0,"The reader. Your AI reads the news and suggests changes.","Your AI reads news and earnings, then proposes allocation changes within your limits. You approve every trade.","After AMD's earnings call, your AI suggested moving $60 from PLTR to AMD. You approved it, and both trades went through."],
 ["weekend-edge",WE_NAME,0,"The planner. Line up orders while the market is closed.","Lets you queue limit orders over the weekend. They can only fill after US markets open, within your limits.","On Sunday you queued a $50 NFLX buy limit. After Monday's open it fills only if the price reaches your limit. It may not fill."]];
const FAQ=[["What are stock tokens?","Tokens on Robinhood Chain that track the price of a stock, traded here against USDG. They are not shares. In this demo they are testnet tokens from the Robinhood Chain faucet, with mock prices and no value."],["Who is eligible?","Not US persons, and not residents of the US, Canada, the UK, Switzerland, the UAE, Russia or sanctioned countries. We check your country, you sign an attestation with your wallet, and your smart wallet must be on our onchain eligibility list before it can trade. An identity-check provider is still being chosen."],["Do you hold my keys?","You own your wallet. We never hold its owner key. Your agent uses a limited key you can revoke anytime."],["What fees apply?","0.30% per trade, taken from the input token. Quotes are shown net of the fee."],["How do I stop my agent?","Revoke the agent key from the dashboard in one click. Keys also expire after 7 days."],["Are strategies advice?","No. They are templates: you choose the parameters and StockClaw executes them within your limits. Tools, not investment advice. Final copy pending."],["Is this real money?","No. This is a testnet demo; tokens and prices are mocks."]];
const bot=(id,n)=>window.SCEyes?SCEyes.html(id,n,144):`<img src="avatars/final-${id}.png" width="144" height="144" alt="${n} mascot">`;
// ---- Baskets: data only from data/baskets.json (see data/README.md) ----
let BK=null,BKerr=null;
fetch("data/baskets.json",{cache:"no-cache"}).then(r=>r.ok?r.json():Promise.reject(r.status)).then(d=>{BK=d;buildColors(d.baskets)}).catch(e=>{BKerr=String(e)}).finally(()=>{const p=(location.hash.slice(1)||"/").split("?")[0];if(p==="/")render()});
// Fixed ticker→color map: same ticker, same color in every basket. Greedy coloring over all baskets (NVDA first = lime),
// so no basket ever shows two identical colors (palette 12 > max basket size). Rebuilt whenever baskets.json loads.
// Headline word = the basket display name from data/baskets.json, verbatim.
const hw=b=>(b&&(b.name||b.theme))||"AI";
function swapWord(b){const w=document.querySelector(".lp-hw");if(!w)return;const t=hw(b),old=w.querySelector(".lp-hw-i:not(.out)");if(old&&old.textContent==t)return;
 if(matchMedia("(prefers-reduced-motion: reduce)").matches||!old){w.innerHTML=`<span class="lp-hw-i">${esc(t)}</span>`;return}
 w.querySelectorAll(".out").forEach(x=>x.remove());old.classList.add("out");old.setAttribute("aria-hidden","true");const n=document.createElement("span");n.className="lp-hw-i in";n.textContent=t;w.appendChild(n);
 requestAnimationFrame(()=>requestAnimationFrame(()=>n.classList.remove("in")));setTimeout(()=>old.remove(),280)}
const PAL=["#C6FF3D","#3DE0FF","#FF5FA2","#FFE14D","#A78BFA","#5AA9FF","#5EF2B8","#FF7AF5","#9DFF8A","#7DF9FF","#F5F5F5","#D4D4D4"];
let TCOL={};function buildColors(bs){const nb={},ord=[];(bs||[]).forEach(b=>{const s=(b.tickers||[]).map(t=>t.symbol||t.ticker);s.forEach(x=>{if(!nb[x]){nb[x]=new Set();ord.push(x)}s.forEach(y=>y!=x&&nb[x].add(y))})});
 ord.sort((a,b)=>(b=="NVDA")-(a=="NVDA")||nb[b].size-nb[a].size);TCOL={};for(const x of ord){const used=new Set([...nb[x]].map(y=>TCOL[y]));TCOL[x]=PAL.find(c=>!used.has(c))||PAL[ord.indexOf(x)%PAL.length]}}
const col=s=>TCOL[s]||"#D4D4D4";
const BLINE={ai:"The companies building and running AI.",chips:"Chipmakers and the tools that make chips.","power-nuclear":"Power for the data-center build-out.",defense:"Defense and aerospace contractors.",space:"Rockets, satellites and space networks.",quantum:"Early quantum computing companies.",cyber:"Security software companies."};
const BAV={"power-nuclear":"power","power":"power"};
// File disclaimer minus sentences our own line already says (Lucius's JSON is not edited).
const discExtra=()=>String((BK&&BK.disclaimer)||"").split(/(?<=\.)\s+/).filter(x=>x&&!/^tools, not investment advice\.?$/i.test(x.trim())&&!/^not an etf or fund\.?$/i.test(x.trim())).join(" ");
const pct=(v)=>(+v).toFixed(2).replace(/\.00$/,"")+"%";
let BKsel=0;
const rows=(b)=>(b.tickers||[]).map(x=>({sym:x.ticker||x.symbol,nm:x.name||"",w:+(x.weightPct??x.weight)||0})).sort((x,y)=>y.w-x.w);
function panel(b,ph,tag){if(!b)return"";const name=b.theme||b.name||b.id;const t=rows(b);const sum=t.reduce((a,x)=>a+x.w,0);const ok=Math.abs(sum-100)<=0.5;
 const R=70,C=2*Math.PI*R,G=2.2;let acc=0;
 const segs=t.map((x,i)=>{const len=Math.max(0.5,x.w/sum*C-G);const rot=acc/C*360-90;acc+=x.w/sum*C;return `<circle class="lp-seg" data-i="${i}" r="${R}" cx="90" cy="90" fill="none" stroke="${col(x.sym)}" stroke-width="26" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${len.toFixed(2)}" data-len="${len.toFixed(2)}" transform="rotate(${rot.toFixed(2)} 90 90)" style="transition-delay:${i*110}ms"></circle>`}).join("");
 return `<div class="lp-bkp-h">${window.SCEyes?SCEyes.html("basket-"+(BAV[b.id]||b.id),"",64):""}<div><h3>${esc(name)}</h3>${BLINE[b.id]?`<p class="lp-bk-one">${BLINE[b.id]}</p>`:""}</div>${ph?tag:""}${ok?"":'<span class="lp-ph">Weights don\'t add up</span>'}</div>
<div class="lp-dn-wrap"><div class="lp-dn"><svg viewBox="0 0 180 180" width="220" height="220" aria-hidden="true" focusable="false">${segs}</svg><div class="lp-dn-c" aria-live="polite"><b>${t.length}</b><span>names</span></div></div>
<ul class="lp-lg" aria-label="${esc(name)} basket weights">${t.map((x,i)=>`<li tabindex="0" data-i="${i}" title="${esc(x.nm)}"><span class="lp-sw" style="background:${col(x.sym)}" aria-hidden="true"></span><span class="lp-lg-t" style="color:${col(x.sym)}">${esc(x.sym)}</span><span class="lp-lg-w">${pct(x.w)}</span></li>`).join("")}</ul></div>`}
function bindBaskets(){const tabs=[...document.querySelectorAll('.lp-tabs [role=tab]')];if(!tabs.length)return;
 const show=(i,focus)=>{BKsel=i;swapWord(BK.baskets[i]);tabs.forEach((t,j)=>{t.setAttribute("aria-selected",j==i);t.tabIndex=j==i?0:-1});const p=document.getElementById("bkp");p.setAttribute("aria-labelledby","bkt-"+i);p.innerHTML=panel(BK.baskets[i],BK.status==="placeholder",'<span class="lp-ph">Placeholder weights, not real data</span>');wire(p);focus&&tabs[i].focus();window.SCEyes&&SCEyes.init(document.querySelector(".lp"))};
 tabs.forEach((t,i)=>{t.onclick=()=>show(i);t.onkeydown=e=>{const k={ArrowRight:1,ArrowLeft:-1}[e.key];if(k){e.preventDefault();show((i+k+tabs.length)%tabs.length,true)}else if(e.key=="Home"){e.preventDefault();show(0,true)}else if(e.key=="End"){e.preventDefault();show(tabs.length-1,true)}}});
 wire(document.getElementById("bkp"))}
function wire(p){if(!p)return;const t=rows(BK.baskets[BKsel]);const c=p.querySelector(".lp-dn-c"),dn=p.querySelector(".lp-dn-wrap");const def=c.innerHTML;
 const hi=(i)=>{dn.classList.toggle("hl",i!=null);p.querySelectorAll("[data-i]").forEach(e=>e.classList.toggle("on",e.dataset.i==i));c.innerHTML=i==null?def:`<b>${esc(t[i].sym)}</b><span>${pct(t[i].w)}</span>`};
 p.querySelectorAll("[data-i]").forEach(e=>{const i=e.dataset.i;e.addEventListener("mouseenter",()=>hi(i));e.addEventListener("mouseleave",()=>hi(null));e.addEventListener("focus",()=>hi(i));e.addEventListener("blur",()=>hi(null))});
 const segs=p.querySelectorAll(".lp-seg");requestAnimationFrame(()=>requestAnimationFrame(()=>segs.forEach(s=>s.setAttribute("stroke-dashoffset","0"))))}
function baskets(){const ph=!BK||BK.status==="placeholder";const tag='<span class="lp-ph">Placeholder weights, not real data</span>';
 const list=(BK&&BK.baskets)||[];const R_=(BK&&BK.rules)||{};
 const body=!BK?`<p class="lp-muted">${BKerr?"Basket data couldn't load.":"Loading baskets…"}</p>`:`<div class="lp-tabs" role="tablist" aria-label="Baskets">${list.map((b,i)=>`<button role="tab" id="bkt-${i}" aria-controls="bkp" aria-selected="${i==BKsel}" tabindex="${i==BKsel?0:-1}" data-bk="${i}">${esc(b.theme||b.name||b.id)}</button>`).join("")}</div><div class="lp-bkp" id="bkp" role="tabpanel" aria-labelledby="bkt-${BKsel}">${panel(list[BKsel],ph,tag)}</div>`;
 const tip=BK?`Source: ${BK.source||"—"}. Market caps as of ${BK.asOf||"—"}. Version ${BK.version||"—"}.`:"";
 return `<section class="lp-sec" id="lp-baskets" aria-labelledby="lp-bk-h"><p class="lp-k">01</p><h2 id="lp-bk-h">Say “get me some <span class="lp-nw"><span class="lp-hw" aria-live="polite"><span class="lp-hw-i">${esc(hw(list[BKsel]))}</span></span>.”</span> ${ph?tag:""}</h2>
<p class="lp-bk-intro">Themed baskets of tokenized stocks, bought in one go.</p>${body}
<p class="lp-fine"><span class="lp-tip" tabindex="0" aria-describedby="lp-tipt">Market-cap weighted<span role="tooltip" id="lp-tipt">${esc(tip)}</span></span> · Baskets are not ETFs or funds. Not investment advice. You confirm every buy. Stock tokens can be frozen or restricted by their issuer; a frozen token can't be sold.</p></section>`}
const esc=(v)=>String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function Landing(){return `<div class="lp">
<header class="lp-nav"><a class="lp-logo" href="#/"><img src="logo-lockup.svg" width="110" height="28" alt="StockClaw home"></a>
<nav aria-label="Main"><a href="#lp-how">How it works</a><a href="#lp-safety">Safety</a><a href="#lp-faq">FAQ</a><a class="lp-pill" href="#/onboarding/eligibility">Try the demo</a></nav></header>
<section class="lp-hero" aria-labelledby="lp-h1">
${(()=>{const F=[["ai-thematic","AI Thematic",84],["dip-hunter","Dip Hunter",104],["steady-stacker","Steady Stacker",128],["trend-flip","Trend Flip",104],["weekend-edge",WE_NAME,84]];return `<div class="lp-fam" role="img" aria-label="The five StockClaw agents: ${F.map(f=>f[1]).join(", ")}">${F.map(([id,n,z],i)=>`<div class="lp-fm lp-fm${i}" aria-hidden="true">${window.SCEyes?SCEyes.html(id,"",z):`<img src="avatars/final-${id}-transparent.png" width="${z}" height="${z}" alt="">`}</div>`).join("")}</div>`})()}
<h1 id="lp-h1">Your agent trades<br>tokenized stocks.<br><em>You set the limits.</em></h1>
<p class="lp-sub">Pick an AI agent, connect your own AI, and let it trade tokenized stocks on Robinhood Chain within limits you set.</p>
<p class="lp-chips" aria-label="Tradeable on testnet">${["PLTR","NFLX","AMD","AMZN","TSLA"].map(t=>`<span class="lp-chip">${t}</span>`).join("")}${BADGE}</p>
<p class="lp-clients">Works in Claude, ChatGPT, Grok and Cursor as an MCP connector.</p>
<div class="lp-cta"><a class="lp-btn" href="#/onboarding/eligibility">Try the testnet demo <span aria-hidden="true">→</span></a><a class="lp-ghost" href="#lp-wait">Join the waitlist</a></div>
</section>
<section class="lp-line" aria-labelledby="lp-bots"><h2 id="lp-bots" class="lp-meet">Meet the agents</h2>
<p class="lp-meet-note">Each agent follows rules you set, within your limits. Examples below are illustrations, not real results. Tools, not investment advice. Final copy pending.</p>
<ol class="lp-intro">${BOTS.map(([id,n,live,intro,how,story],i)=>`<li class="${live?"":"soon"} ${i%2?"rev":""}">${bot(id,n)}<div class="lp-it"><h3>${n} <span class="lp-tag ${live?"live":""}">${live?"Live on testnet":"Coming soon"}</span></h3><p class="lp-intro-l">${intro}</p><p><span class="lp-lbl">Strategy</span>${how}</p><figure class="lp-story"><span class="lp-ill">Illustrative example, not a real result</span><blockquote>${story}</blockquote></figure></div></li>`).join("")}</ol></section>
${baskets()}
<section class="lp-sec" id="lp-how" aria-labelledby="lp-how-h"><p class="lp-k">02</p><h2 id="lp-how-h">How it works</h2>
<ol class="lp-steps"><li><b>Check eligibility</b> and sign with your wallet.</li><li><b>Set up your wallet.</b> You own it.</li><li><b>Confirm limits:</b> $100 a trade, $500 of buys per 24h.</li><li><b>Get test tokens</b> in one tap.</li><li><b>Connect your AI</b> and ask it to trade.</li></ol></section>
<section class="lp-sec" id="lp-safety" aria-labelledby="lp-safe-h"><p class="lp-k">03</p><h2 id="lp-safe-h">Safety and limits</h2>
<p class="lp-big">You own your wallet. We never hold its owner key. Your agent uses a limited key you can revoke anytime.</p>
<dl class="lp-facts"><div><dt>Per trade</dt><dd>Up to $100 on testnet</dd></div><div><dt>Buy headroom (24h)</dt><dd>Up to $500 of buys on testnet. Sells are exempt.</dd></div><div><dt>Key lifetime</dt><dd>7 days, revoke in one click</dd></div><div><dt>Fee</dt><dd>0.30%, from the input token</dd></div></dl>
<p class="lp-tickers">Tradeable on testnet: <span class="lp-mono">PLTR NFLX AMD AMZN TSLA</span> ${BADGE}</p></section>
<section class="lp-sec" id="lp-faq" aria-labelledby="lp-faq-h"><p class="lp-k">04</p><h2 id="lp-faq-h">FAQ</h2>
${FAQ.map(([q,a])=>`<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</section>
<section class="lp-sec lp-wait" id="lp-wait" aria-labelledby="lp-wait-h"><h2 id="lp-wait-h">Get notified when it leaves testnet.</h2>
<form id="lp-form" novalidate><label for="lp-email">Email</label><div class="lp-row"><input id="lp-email" type="email" autocomplete="email" required placeholder="you@example.com" aria-describedby="lp-msg"><button class="lp-btn" type="submit">Join waitlist</button></div><p id="lp-msg" role="status"></p></form></section>
<footer class="lp-foot">${DIS}<p>Local testnet demo: mock tokens, simulated prices, simulated owner wallet. Tools, not investment advice. Final copy pending.</p><p>Terms · Privacy · Disclosures · Status</p></footer>
</div>`}
function LandingBind(){const f=document.getElementById("lp-form");if(!f)return;f.onsubmit=e=>{e.preventDefault();const i=f.querySelector("input"),m=document.getElementById("lp-msg");if(!i.checkValidity()){i.setAttribute("aria-invalid","true");m.textContent="Enter a valid email address.";i.focus();return}i.removeAttribute("aria-invalid");m.textContent="You're on the waitlist (mock, nothing is sent).";f.querySelector("button").disabled=true}}
function mark(){const p=(location.hash.slice(1)||"/").split("?")[0];document.body.classList.toggle("is-landing",!(p in R)||p==="/")}
R["/"]=[Landing,()=>{LandingBind();bindBaskets();window.SCEyes&&SCEyes.init(document.querySelector(".lp"))}];
addEventListener("hashchange",mark);mark();render();
})();
