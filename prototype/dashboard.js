/* StockClaw app redesign (dashboard + simplified onboarding). Loaded after app.js and landing.js.
   Reuses app.js state/helpers (S, C, ST, api, sapi, loadDash, loadStrats, confirmDlg, fail, issueKey, ...).
   Data comes only through api.js functions (directly or via app.js helpers). */
(function(){
const money=(n)=>"$"+(+n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const rel=(iso)=>{const s=Math.max(0,(Date.now()-new Date(iso))/1000);return s<60?"just now":s<3600?Math.round(s/60)+"m ago":s<86400?Math.round(s/3600)+"h ago":fmtD(iso)};
const num=(str)=>{const m=String(str||"").match(/^\s*([\d.,]+)\s+(\S+)/);return m?{n:+m[1].replace(/,/g,""),sym:m[2]}:null};
const isStable=(s)=>/^m?USDG$/i.test(s||"");
const price=(sym)=>{if(isStable(sym))return 1;const a=(C.assets||[]).find(x=>x.symbol==sym);return a&&+a.priceUsd>0?+a.priceUsd:null};
const tdy=(iso)=>new Date(iso).toDateString()==new Date().toDateString();
const NAMES={"steady-stacker":"Steady Stacker","dip-hunter":"Dip Hunter","trend-flip":"Trend Flip","ema-vwap-flip":"Trend Flip","ai-thematic":"AI Thematic","weekend-edge":"Weekend Edge","monday-planner":"Weekend Edge"};
const ROLE={"steady-stacker":"Buys a fixed dollar amount on a schedule.","dip-hunter":"Buys at set drops, sells at a set gain."};

// ---------- numbers derived honestly from API data ----------
function portfolio(){const b=C.bal;if(!b)return null;let t=0;for(const x of b){const v=+x.usdValue>0?+x.usdValue:(price(x.symbol)!=null?price(x.symbol)*(+x.amount||0):null);if(v==null&&+x.amount>0)return {partial:true,v:t};t+=v||0}return {v:t}}
// Today's P&L = current mock value of what today's filled trades bought - what they cost (gross, fee included). Unavailable if any leg can't be priced.
function pnlToday(){const h=(S.history||[]).filter(x=>x.status=="filled"&&tdy(x.ts));if(!h.length)return {none:true};let p=0;
 for(const x of h){const i=num(x.in),o=num(x.out);if(!i||!o)return {na:"a trade's amounts couldn't be read"};const pi=price(i.sym),po=price(o.sym);if(pi==null||po==null)return {na:"prices aren't available yet"};p+=o.n*po-i.n*pi}
 return {v:p,n:h.length}}
function sentence(x){const i=num(x.in),o=num(x.out),t=rel(x.ts);
 if(x.status!="filled"){const why=isVaultCap(x.reason)?capMsg().replace(/^Blocked: /,""):String(x.reason||"it was over a limit");return {blocked:true,txt:`Blocked: tried to spend ${i&&isStable(i.sym)?money(i.n):x.in||"a trade"}. ${why.replace(/\.?$/,".")}`,t}}
 const fee=num(x.fee);const feeTxt=fee?` · fee ${isStable(fee.sym)?money(fee.n):x.fee}`:"";
 if(i&&o&&isStable(i.sym))return {txt:`Bought ${+o.n.toFixed(6)} ${o.sym} for ${money(i.n)}${feeTxt}`,t};
 if(i&&o&&isStable(o.sym))return {txt:`Sold ${+i.n.toFixed(6)} ${i.sym} for ${money(o.n)}${feeTxt}`,t};
 if(i&&isStable(i.sym)){const sym=String(x.out||"").split(/\s+/).pop();return {txt:`Bought ${sym&&sym!="—"?sym:"tokens"} for ${money(i.n)}${feeTxt}`,t}}
 return {txt:`Swapped ${x.in} for ${x.out}${feeTxt}`,t}}
function feed(){const h=(S.history||[]).slice().sort((a,b)=>String(b.ts).localeCompare(String(a.ts))).slice(0,8);
 const fills=((ST.status&&ST.status.fills)||[]).filter(f=>f.status=="blocked").slice(0,3).map(f=>({blocked:true,txt:`Blocked: ${NAMES[ST.status.id]||"your strategy"} tried to ${f.side||"buy"} ${f.symbol||""} for ${money(f.amountUsd)}. ${blockedText(f.lastError||"Over a limit").replace(/^Blocked: /,"")}`,t:rel(f.ts)}));
 const items=[...fills,...h.map(sentence)];
 if(!items.length)return `<p class="dx-quiet">${C.loading?"Loading activity…":"No trades yet. Ask your agent for a quote, or pick a strategy."}</p>`;
 return `<ul class="dx-feed">${items.map(s=>`<li class="${s.blocked?"blk":""}"><span class="dx-dot" aria-hidden="true"></span><span>${esc(s.txt)}</span><span class="dx-when"> · ${s.t}</span></li>`).join("")}</ul>`}
function meter(label,used,cap,note){const pct=Math.max(0,Math.min(100,used/cap*100));return `<div class="dx-meter"><p><b>${money(used)}</b> used of ${money(cap).replace(".00","")} ${label}${note?` <span class="dx-mut">${note}</span>`:""}</p><div class="dx-bar" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="${cap}" aria-valuenow="${used.toFixed(2)}"><i style="width:${pct}%"></i></div></div>`}

// ---------- app chrome (replaces app.js dash()) ----------
let INNER=false;
const NAV=[["overview","Home"],["strategies","Strategies"],["key","Agent key"]];
dash=function(t,body){if(INNER)return body;const k=S.key,act=k&&k.status=="active";
 let ban=S.dev.service?`<div class="st err" role="alert"><b>Service issue.</b> Trading paused. Funds stay in your wallet.</div>`:"";
 if(!act)ban+=`<div class="st err" role="alert">Your agent key is ${k?k.status:"not created yet"}. <a href="#/dashboard/key">${k?"Create a new key":"Create one"}</a></div>`;
 if(!S.connected)ban+=`<div class="st wait" role="status">Your AI isn't connected yet. <a href="#/onboarding/client">Connect it</a></div>`;
 return `<header class="dx-top"><a class="logo" href="#/">StockClaw</a><nav aria-label="Dashboard">${NAV.map(([id,l])=>`<a href="#/dashboard/${id}" ${id==t||(t!="strategies"&&t!="key"&&id=="overview")?'aria-current="page"':""}>${l}</a>`).join("")}</nav>${act?`<button class="dx-link" id="topRevoke">Revoke key</button>`:""}</header>
${ban}${dataErr()}<div class="dx-body">${body}</div>${DISC}`};

// ---------- Home ----------
function Home(){initData();if(ST.status===undefined)loadStrats().then(()=>{if(lastRoute=="/dashboard/overview")render()});
 const s=ST.status,id=s?s.id:"steady-stacker",name=NAMES[id]||(sById(id)||{}).name||"Steady Stacker",on=s&&s.status=="active";
 const pf=portfolio(),pl=pnlToday(),k=S.key;const used=Math.max(0,500-vaultLeft(),+(k&&k.spentToday)||0);
 const primary=!s?`<a class="dx-primary" href="#/dashboard/strategies">Pick a strategy</a>`:on?`<button class="dx-primary" id="dxPause">Pause agent</button>`:`<button class="dx-primary" id="dxResume">Resume agent</button>`;
 const plTxt=pl.none?`<span class="dx-big">${money(0)}</span><span class="dx-sub">No trades today</span>`:pl.na?`<span class="dx-big dx-mut">Unavailable</span><span class="dx-sub">Can't compute: ${pl.na}</span>`:`<span class="dx-big ${pl.v<0?"neg":"pos"}">${pl.v<0?"−":"+"}${money(Math.abs(pl.v))}</span><span class="dx-sub">${pl.n} trade${pl.n>1?"s":""} today vs current mock prices</span>`;
 const details=(()=>{INNER=true;try{return [D1(),D2(),D3(),D4()]}finally{INNER=false}})();
 return dash("overview",`<section class="dx-hero" aria-labelledby="dx-name">
<div class="dx-agent">${SCEyes.html(id,name,200,s?"":"dx-ghost")}<div><p class="dx-k">${s?(on?"Running":"Paused"):"Default agent · no strategy yet"}</p><h1 id="dx-name">${esc(name)}</h1><p class="dx-mut">${s?esc(ROLE[id]||""):"Pick a strategy for this agent, or ask your AI to trade on request."}</p>${ownerSimulated?'<p class="dx-mut dx-small">Simulated owner wallet</p>':""}<div class="dx-act">${primary}</div></div></div>
<div class="dx-nums"><div><p class="dx-k">Portfolio value</p>${pf?`<span class="dx-big">${money(pf.v)}</span><span class="dx-sub">${pf.partial?"Some tokens have no price yet":"Mock prices"} · <span class="badge">Testnet, not real stocks</span></span>`:`<span class="dx-big dx-mut">…</span><span class="dx-sub">Loading</span>`}</div>
<div><p class="dx-k">Today's P&amp;L</p>${plTxt}</div></div></section>
<section class="dx-sec" aria-labelledby="dx-lim"><h2 id="dx-lim">Limits</h2>${meter("today",used,500,"(vault, all agents)")}
<p class="dx-mut">Each trade is capped at ${money(k?Math.min(+k.perTradeCap||100,100):100).replace(".00","")}. Trades over a limit are blocked. <a href="#/dashboard/key">Change limits</a></p></section>
<section class="dx-sec" aria-labelledby="dx-act"><h2 id="dx-act">Activity</h2>${feed()}</section>
<details class="dx-details" id="dxDet" ${S.dxOpen?"open":""}><summary>Details</summary><p class="dx-mut"><span id="ago" role="status">Updated ${ago()}s ago</span> · <button class="dx-link" id="rf">Refresh</button></p>
<h2 class="dx-h3">Balances and prices</h2>${strip(details[0])}<h2 class="dx-h3">Orders</h2>${strip(details[1])}<h2 class="dx-h3">History</h2>${strip(details[2])}<h2 class="dx-h3">Fees</h2>${strip(details[3])}</details>
<p class="dx-mut dx-small">Tools, not investment advice. Final copy pending.</p>`)}
// drop the old in-section titles / refresh row (they're replaced by the summary headings)
const strip=(h)=>h.replace(/^<div class="row"[^]*?<\/div>\s*/,"").replace(/<h1>[^]*?<\/h1>/,"");
function HomeBind(){const d=$("#dxDet");d&&(d.ontoggle=()=>{S.dxOpen=d.open;save()});
 try{D1bind()}catch(e){}try{D2bind()}catch(e){}try{D4bind()}catch(e){}
 SCEyes.init(document.querySelector(".dx-agent"));
 const id=ST.status&&ST.status.activationId;
 const p=$("#dxPause");p&&(p.onclick=()=>confirmDlg("Pause your agent?","This pauses the strategy and cancels its open orders onchain. Your settings are kept. Needs your wallet signature.","Sign & pause",async()=>{try{await sapi("pause_strategy",id);ST.status.status="paused";render();say("Agent paused");loadStrats(true).then(()=>render())}catch(e){fail("pause_strategy",e)}}));
 const r=$("#dxResume");r&&(r.onclick=()=>{if(!(S.key&&S.key.status=="active"))return fail("resume_strategy","Create or resume the agent key first (Agent key)");confirmDlg("Resume your agent?","This re-signs the strategy's orders from your saved settings. Needs your wallet signature.","Sign & resume",async()=>{try{await sapi("resume_strategy",id);ST.status.status="active";render();say("Agent resumed");loadStrats(true).then(()=>render())}catch(e){fail("resume_strategy",e)}})})}
R["/dashboard/overview"]=[Home,HomeBind];

// ---------- simplified onboarding ----------
const OSTEPS=[["eligibility","Check"],["wallet","Wallet"],["key","Agent key"],["client","Connect AI"],["strategy","Strategy"]];
const stepper=(n)=>`<ol class="dx-steps" aria-label="Setup progress">${OSTEPS.map(([r,l],i)=>`<li class="${i<n?"done":i==n?"on":""}" ${i==n?'aria-current="step"':""}><span>${i+1}</span>${l}</li>`).join("")}</ol>`;
const obx=(n,body)=>`<header class="dx-top"><a class="logo" href="#/">StockClaw</a><span class="dx-mut dx-small">Step ${n+1} of ${OSTEPS.length}</span></header>${stepper(n)}<div class="dx-ob">${body}</div>${DISC}`;
// Reuse an existing app.js screen but swap its stepper/header for the new one.
const reskin=(n,fn)=>()=>obx(n,fn().replace(/^<a class="logo"[^>]*>[^<]*<\/a><ol class="steps"[^]*?<\/ol><section class="card">/,"").replace(/<\/section><p class="disc">[^]*$/,""));
const prog=(items)=>`<ul class="dx-prog">${items.map(([ok,l,busy])=>`<li class="${ok?"ok":busy?"busy":""}"><span aria-hidden="true">${ok?"✓":busy?"…":""}</span>${l}${ok?'<span class="sr"> (done)</span>':busy?'<span class="sr"> (in progress)</span>':""}</li>`).join("")}</ul>`;

// Step 1: eligibility (existing form + checks), reskinned
R["/onboarding/eligibility"]=[reskin(0,O1),O1bind];
// Step 2: one "Set up wallet" action: connect -> sign attestation -> create smart wallet
let wbusy=null;
function W(){const ok=S.elig==="eligible";return obx(1,`<h1>Set up your wallet</h1><p class="dx-lede">You own your wallet. We never hold its owner key. Your agent uses a limited key you can revoke anytime.</p>
${ok?"":`<div class="st err" role="alert">Finish the eligibility check first. <a href="#/onboarding/eligibility">Back to step 1</a></div>`}
${prog([[!!S.owner,"Connect your wallet",wbusy=="c"],[!!S.attest,"Sign the eligibility statement (no gas)",wbusy=="a"],[!!S.sa,"Create your smart wallet on Robinhood Chain testnet",wbusy=="s"]])}
${S.err=="wallet"?`<div class="st err" role="alert">Couldn't create the wallet. Nothing was charged. Try again.</div>`:""}
${S.sa?`<a class="dx-primary" href="#/onboarding/key">Continue</a>`:`<button class="dx-primary" id="wgo" ${ok&&!wbusy?"":"disabled"}>${wbusy?"Setting up…":S.err=="wallet"?"Try again":"Set up wallet"}</button>`}
${S.sa?`<p class="dx-mut dx-small">Smart wallet ${short(S.sa)}</p>`:""}`)}
function Wbind(){const b=$("#wgo");b&&(b.onclick=async()=>{S.err=null;try{
  if(!S.owner){wbusy="c";render();const w=await api.get_wallet();S.owner=w.owner;save()}
  if(!S.attest){wbusy="a";render();await api.submit_attestation("0xsig");S.attest=true;save()}
  if(!S.sa){wbusy="s";render();if(S.dev.walletfail){await new Promise(r=>setTimeout(r,500));throw Object.assign(new Error("wallet"),{w:1})}const r=await api.create_smart_account(S.owner);S.sa=r.address;save()}
  wbusy=null;render();say("Wallet ready");$(".dx-primary")?.focus()}catch(e){const step=wbusy;wbusy=null;if(step=="s")S.err="wallet";if(e&&e.w)return render();fail({c:"get_wallet",a:"submit_attestation",s:"create_smart_account"}[step]||"wallet",e)}})}
R["/onboarding/wallet"]=[W,Wbind];
// Step 3: agent key = confirm defaults; test funds are claimed automatically right after
let kbusy=null,editLimits=false;
function K(){if(editLimits)return reskin(2,O3)();const d=defaults();const k=S.key;
 return obx(2,`<h1>${k?"Your agent is ready":"Confirm your agent's limits"}</h1><p class="dx-lede">Your AI trades with a limited key. It can only trade these tickers, within these limits, and it expires in 7 days.</p>
${!S.sa?`<div class="st err" role="alert">Set up your wallet first. <a href="#/onboarding/wallet">Back to step 2</a></div>`:""}
<dl class="dx-facts"><div><dt>Per trade</dt><dd>${money(k?k.perTradeCap:d.perTradeCap).replace(".00","")}</dd></div><div><dt>Per day</dt><dd>${money(k?k.dailyCap:d.dailyCap).replace(".00","")}</dd></div><div><dt>Tickers</dt><dd>${(k?k.allowlist:d.allowlist).join(" ")}</dd></div><div><dt>Expires</dt><dd>${k?fmtD(k.expiresAt):"in 7 days"}</dd></div></dl>
<p class="dx-mut dx-small">Up to $100 per trade and $500 per day on testnet. <span class="badge">Testnet, not real stocks</span></p>
${k?prog([[true,"Agent key created"],[S.funded,S.funded?"Test tokens added (mUSDG and stock tokens, no value)":"Adding test tokens",kbusy=="f"]]):kbusy?prog([[false,"Creating agent key (1 signature)",kbusy=="k"],[false,"Adding test tokens"]]):""}
${S.err=="rate"?`<div class="st err" role="alert">The faucet's daily limit was reached. <a href="#/onboarding/faucet">Try the faucet again</a> or continue if you already have test tokens.</div>`:""}
${k?`<a class="dx-primary" href="#/onboarding/client">Continue</a>${!S.funded&&!kbusy?` <button class="dx-link" id="fgo">Add test tokens</button>`:""}`:`<button class="dx-primary" id="kgo" ${S.sa&&!kbusy?"":"disabled"}>Confirm and create key</button> <button class="dx-link" id="kedit">Change limits</button>`}<p id="kerr" class="st err" role="alert" hidden></p>`)}
async function fund(){kbusy="f";render();try{await api.faucet_testnet();if(S.dev.ratelimit)throw {status:429};S.funded=true;S.err=null}catch(e){if(e&&e.status==429)S.err="rate";else{kbusy=null;return fail("faucet_testnet",e)}}kbusy=null;save();render();say(S.funded?"Test tokens added":"Faucet limit reached")}
function Kbind(){if(editLimits){O3bind();const f=$("#kf");f&&f.addEventListener("submit",()=>setTimeout(()=>{if(S.key){editLimits=false;render();if(!S.funded)fund()}},50));return}
 const e=$("#kedit");e&&(e.onclick=()=>{editLimits=true;draft=defaults();render()});const f=$("#fgo");f&&(f.onclick=fund);
 const b=$("#kgo");b&&(b.onclick=async()=>{kbusy="k";render();try{S.key=await issueKey(defaults());save()}catch(err){kbusy=null;render();const x=$("#kerr");x.hidden=false;x.textContent="Couldn't create the key: "+err.message;return}kbusy=null;render();say("Agent key created");if(!S.funded)await fund();$(".dx-primary")?.focus()})}
R["/onboarding/key"]=[K,Kbind];
R["/onboarding/faucet"]=[reskin(2,O4),O4bind];
R["/onboarding/client"]=[reskin(3,O5),O5bind];
R["/onboarding/strategy"]=[reskin(4,O6),statusBind];

// body class so app styles only apply off the landing route
function mark(){const p=(location.hash.slice(1)||"/").split("?")[0];document.body.classList.toggle("sc-app",p!=="/"&&p in R||/^\/(dashboard|onboarding)\//.test(p))}
addEventListener("hashchange",mark);mark();render();
})();
