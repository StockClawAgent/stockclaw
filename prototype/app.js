// StockClaw clickable prototype. Hash routing, localStorage state, data via api.js stubs.
// ---- Owner token (presenter). sessionStorage only ("stockclaw-owner-token", same key as api.js); never localStorage, never logged.
// Defined first so window.__requestOwnerToken exists before any api.js call. Concurrent callers share one dialog/promise.
var OTK="stockclaw-owner-token",tokPending=null;
function getTok(){try{return sessionStorage.getItem(OTK)||""}catch(e){return ""}}
function applyTok(){if(typeof paintBar=="function")try{paintBar()}catch(e){}}
function forgetTok(){try{sessionStorage.removeItem(OTK)}catch(e){}applyTok()}
var tokCancelAt=0;
function requestOwnerToken(force){const t=getTok();if(t)return Promise.resolve(t);if(tokPending)return tokPending;if(!force&&Date.now()-tokCancelAt<5000)return Promise.reject(new Error("Owner token needed: cancelled."));
 tokPending=new Promise((res,rej)=>{const open=()=>{const d=document.createElement("dialog");d.className="tokdlg";d.setAttribute("aria-labelledby","tokh");
  d.innerHTML=`<form method="dialog"><h2 id="tokh">Owner token needed</h2><p>This demo server needs the presenter's owner token. It is kept in this browser tab only (sessionStorage) and cleared when the tab closes.</p>
  <label for="tokin">Owner token</label><input id="tokin" type="password" autocomplete="off" spellcheck="false" required>
  <div class="row"><button class="btn" value="ok">Use token</button> <button class="btn sec" value="cancel" formnovalidate>Cancel</button></div></form>`;
  document.body.appendChild(d);d.addEventListener("close",()=>{const v=d.returnValue,inp=d.querySelector("#tokin").value.trim();d.remove();tokPending=null;
   if(v=="ok"&&inp){try{sessionStorage.setItem(OTK,inp)}catch(e){}applyTok();res(inp)}else{tokCancelAt=Date.now();rej(new Error("Owner token needed: cancelled."))}});
  d.showModal();d.querySelector("#tokin").focus()};document.body?open():document.addEventListener("DOMContentLoaded",open,{once:true})});
 return tokPending}
window.__requestOwnerToken=requestOwnerToken;
async function askTok(){try{await requestOwnerToken(true);return true}catch(e){return false}}
async function needOwner(){if(window.USE_MOCK||getTok())return true;return askTok()}
window.__apiFails=[];if(window.api)for(const n of Object.keys(api)){const f=api[n];api[n]=(...a)=>Promise.resolve().then(()=>f(...a)).catch(e=>{window.__apiFails.push(n+": "+(e&&e.message));console.warn("api."+n+" failed:",e);say("Couldn't reach the server ("+n+")");throw e})}
const KEY="stockclaw-proto-v1";const B='<span class="badge">Testnet, not real stocks</span>';
const DISC='<p class="disc">Stock tokens are not available to US persons or residents of restricted regions and are not shares. Stock tokens can be frozen or restricted by their issuer; a frozen token can\'t be sold. Final copy pending legal review.</p>';
const BLOCKED=["United States","Canada","United Kingdom","Switzerland","United Arab Emirates","Iran","North Korea","Cuba","Syria","Russia"];
const COUNTRIES=["Germany","France","Spain","Brazil","Japan","Singapore","Australia",...BLOCKED].sort();
const def=()=>({elig:null,country:"",attest:false,owner:null,sa:null,key:null,funded:false,claiming:false,client:"Claude",connected:false,orders:null,history:null,lastRefresh:Date.now(),devElig:"auto",dev:{},switched:false,err:null});
let S=Object.assign(def(),JSON.parse(localStorage.getItem(KEY)||"{}"));S.dev=S.dev||{};
const save=()=>localStorage.setItem(KEY,JSON.stringify(S));
const $=(s)=>document.querySelector(s);const esc=(t)=>String(t).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const say=(t)=>{$("#live").textContent="";setTimeout(()=>$("#live").textContent=t,30)};
const short=(a)=>a?a.slice(0,6)+"…"+a.slice(-4):"";const go=(h)=>{location.hash=h};
const fmtD=(iso)=>new Date(iso).toLocaleDateString("en-US",{month:"short",day:"numeric"});
// Reset demo: server reset via api.js if it has one, else POST /api/dev/reset; 404/unreachable/mock -> local-only reset with a note.
let resetNote=null;
document.getElementById("reset").onclick=async(e)=>{e.preventDefault();let note=null;
 try{if(window.USE_MOCK)throw{local:1};if(api.dev_reset)await api.dev_reset();else if(api.reset_demo)await api.reset_demo();else{const r=await fetch(`${typeof API_BASE!=="undefined"?API_BASE:location.origin}/api/dev/reset`,{method:"POST",headers:{"content-type":"application/json",...((()=>{const t=getTok();return t?{authorization:`Bearer ${t}`,"x-owner-token":t}:{}})())}});if(r.status==404){const r2=await fetch(`${typeof API_BASE!=="undefined"?API_BASE:location.origin}/api/demo/reset`,{method:"POST"});if(!r2.ok)throw{status:r2.status}}else if(!r.ok)throw{status:r.status}}}
 catch(x){note=x&&x.local?"Demo reset (mock mode: local state only).":x&&x.status==403?"Reset local state only: server reset is only allowed on the local chain.":x&&x.status==404?"Reset local state only: the server reset endpoint isn't available yet, so the wallet, key, orders and faucet cooldown on the server are unchanged.":`Reset local state only: server reset failed (${(x&&(x.status||x.message))||"unreachable"}).`}
 const keepMock=localStorage.getItem("stockclaw-use-mock");localStorage.clear();if(keepMock)localStorage.setItem("stockclaw-use-mock",keepMock);
 S=def();draft=null;stage=null;ST.list=null;ST.status=undefined;ST.draft=null;ST.preview=null;TICKERS=null;C.bal=C.assets=null;C.err=null;resetNote=note;lastRoute=null;if(location.hash==="#/"||!location.hash)render();else go("#/");say(note||"Demo reset")};

const STEPS=["Eligibility","Wallet","Agent key","Faucet","AI client","Strategy (optional)"],SR=["eligibility","wallet","key","faucet","client"];
const steps=(n)=>`<ol class="steps" aria-label="Onboarding progress">${STEPS.map((s,i)=>`<li class="${i<n?"done":i==n?"on":""}" ${i==n?'aria-current="step"':""}>${i<n?"✓ ":""}${i+1}. ${s}</li>`).join("")}</ol>`;
const ob=(n,body)=>`<a class="logo" href="#/">StockClaw</a>${steps(n)}<section class="card">${body}</section>${DISC}`;

// ---------- Landing ----------
function L1(){return `<header class="nav card"><a class="logo" href="#/">StockClaw</a><nav aria-label="Main"><a href="#how">How it works</a> · <a href="#clients">Clients</a> · <a href="#safety">Safety</a> · <a href="#faq">FAQ</a></nav><a class="btn" href="#/onboarding/eligibility">Get started</a></header>
<section class="card hero"><div><h1>Let your AI agent trade tokenized stocks, inside limits you set.</h1><p>MCP connector for Claude, ChatGPT, Grok &amp; Cursor. Robinhood Chain stock tokens + USDG. Now on testnet.</p>
<div class="row"><a class="btn" href="#/onboarding/eligibility">Try the testnet demo</a><form class="row" onsubmit="event.preventDefault();this.innerHTML='<span role=status>✓ You\\'re on the waitlist (mock).</span>'"><label class="sr" for="wl">Email</label><input id="wl" type="email" required placeholder="you@example.com"><button class="sec">Join waitlist</button></form></div></div>
<div class="ill" aria-label="Example chat"><b>You:</b> Buy 10 mUSDG of TSLA ${B}<br><b>Agent:</b> Quote: 10.00 mUSDG → fee 0.03 → 9.97 swapped for TSLA (mock). Confirm?<br><b>You:</b> Yes<br>✓ Filled. Tx 0xMOCKTX</div></section>
<section class="card" id="how"><h2>How it works</h2><div class="grid"><div><h3>① Check eligibility &amp; connect your wallet</h3><p>You own your wallet. We never hold its owner key. Your agent uses a limited key you can revoke anytime.</p></div><div><h3>② Create an agent key</h3><p>$100/trade, $500 of buys per 24h (sells don't count), allowlist-only by default.</p></div><div><h3>③ Add to your AI client</h3><p>Ask your agent to trade; revoke anytime.</p></div></div></section>
<section class="card" id="clients"><h2>Supported AI clients</h2><div class="grid">${["Claude","ChatGPT","Grok","Cursor"].map(c=>`<div class="st">${c}</div>`).join("")}</div></section>
<section class="card" id="safety"><h2>Safety &amp; limits</h2><div class="grid"><div class="st ok">Onchain spend caps</div><div class="st ok">Ticker allowlist</div><div class="st ok">Key expires ≤7 days</div><div class="st ok">One-click revoke</div></div>
<p>Tradeable on testnet: TSLA, AMZN, PLTR, NFLX, AMD ${B}</p><p><b>Fees:</b> 0.30% per trade, taken from the input token. Quotes are shown net of the fee. No subscriptions.</p></section>
<section class="card" id="faq"><h2>FAQ</h2>${[["What are stock tokens?","Tokens on Robinhood Chain that track the price of a stock, traded here against USDG. They are not shares. In this demo they are testnet tokens from the Robinhood Chain faucet, with mock prices and no value."],["Who is eligible?","Not US persons, and not residents of the US, Canada, the UK, Switzerland, the UAE or sanctioned countries. We check your country, you sign an attestation with your wallet, and your smart wallet must be on our onchain eligibility list before it can trade. An identity-check provider is still being chosen."],["Do you hold my keys?","You own your wallet. We never hold its owner key. Your agent uses a limited key you can revoke anytime."],["What fees apply?","0.30% per trade, taken from the input token."],["How do I stop my agent?","Revoke the agent key from the dashboard in one click. Keys also expire after 7 days."],["Is this real money?","No. This is a testnet demo; tokens and prices are mocks."]].map(([q,a])=>`<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</section>
${DISC}<section class="card"><h2>Ready?</h2><a class="btn" href="#/onboarding/eligibility">Try the testnet demo</a></section><footer class="muted">Terms · Privacy · Disclosures · Status</footer>`}

// ---------- O1 ----------
function O1(){const e=S.elig;let st="";
 if(e==="eligible")st=S.attest?`<div class="st ok" role="status">✓ Eligible. Attestation signed.</div>`:`<div class="st wait" role="status">✓ Eligible, pending signature. Continue to connect your wallet and sign the attestation.</div>`;
 if(e==="blocked")st=`<div class="st err" role="alert">✕ Not available in your region. Stock tokens aren't offered where you live. <a href="#/onboarding/eligibility">Learn why</a> · <a href="#/onboarding/eligibility">Contact support</a></div>`;
 if(e==="geo")st=`<div class="st err" role="alert">✕ Blocked by network location (451). Your connection appears to be from a restricted region.</div>`;
 if(e==="error")st=`<div class="st err" role="alert">✕ Couldn't reach the eligibility service. Try again.</div>`;if(e==="pending")st=`<div class="st wait" role="status">⏳ Pending [Provider placeholder] review. Resume via email.</div>`;
 return ob(0,`<h1>Check eligibility</h1><form id="ef"><label>Country / region of residence <select id="cty" required><option value="">Select…</option>${COUNTRIES.map(c=>`<option ${S.country==c?"selected":""}>${c}</option>`).join("")}</select></label>
<label><input type="checkbox" id="np" required ${S.np?"checked":""}> I am not a US person and not a resident of the US (persons and territories), Canada, the UK, Switzerland, the UAE, or sanctioned countries.</label>
<p class="muted">You will sign this attestation with your wallet in the next step. Identity check: [provider placeholder].</p>
<button>Check eligibility</button></form>${st}${e==="eligible"?`<p><a class="btn" href="#/onboarding/wallet">Continue</a></p>`:""}
<fieldset class="dev"><legend>Dev toggle: force result</legend>${["auto","eligible","blocked","geo","pending"].map(v=>`<label style="display:inline"><input type="radio" name="dev" value="${v}" ${S.devElig==v?"checked":""}> ${v=="geo"?"geo-block 451":v}</label> `).join("")}</fieldset>`)}
function O1bind(){document.querySelectorAll('[name=dev]').forEach(r=>r.onchange=()=>{S.devElig=r.value;save()});
 $("#ef").onsubmit=async(ev)=>{ev.preventDefault();S.country=$("#cty").value;S.np=$("#np").checked;let r;try{r=await api.check_eligibility(S.country)}catch(e){r=null}if(!r&&S.devElig=="auto"){S.elig="error";save();render();return}r=r||{eligible:true};
  S.elig=S.devElig!=="auto"?S.devElig:(BLOCKED.includes(S.country)?"blocked":(r.eligible?"eligible":"blocked"));save();render();say("Eligibility: "+S.elig)}}

// ---------- O2 ----------
function O2(){return ob(1,`<h1>Connect your wallet</h1><p>You own your wallet. We never hold its owner key. Your agent uses a limited key you can revoke anytime. Your wallet owns a non-custodial smart wallet on Robinhood Chain testnet (chain ${CHAIN_ID}).</p>
${S.elig!=="eligible"?`<div class="st err" role="alert">Complete the eligibility check first. <a href="#/onboarding/eligibility">Go to step 1</a></div>`:""}
<h3>1. Connect wallet</h3>${S.owner?`<div class="st ok">✓ Owner: ${short(S.owner)} (mock)</div>`:`<button id="cw" ${S.elig!=="eligible"?"disabled":""}>Connect wallet</button> <span class="muted">[RainbowKit / passkey]</span>`}
${S.owner&&S.dev.wrongnet&&!S.switched?`<div class="st err" role="alert">✕ Wrong network. Switch to Robinhood Chain testnet (${CHAIN_ID}). <button class="sec" id="sw">Switch network</button></div>`:""}<h3>2. Sign eligibility attestation</h3>${!S.attest&&S.elig=="eligible"?`<p class="muted">Eligible, pending signature.</p>`:""}${S.attest?`<div class="st ok">✓ Attestation signed (EIP-712, mock)</div>`:`<button id="sg" ${S.owner&&!(S.dev.wrongnet&&!S.switched)?"":"disabled"}>Sign (EIP-712, no gas)</button>`}
<h3>3. Create smart wallet</h3>${S.sa?`<div class="st ok">✓ Smart wallet: ${short(S.sa)} (mock) <button class="sec" data-copy="${S.sa}">Copy</button> <a href="${EXPLORER}/address/${S.sa}" target="_blank" rel="noopener">View on explorer ↗</a></div>`:`<button id="cs" ${S.attest?"":"disabled"}>${S.err=="wallet"?"Try again":"Create smart wallet"}</button>`}${S.err=="wallet"?`<div class="st err" role="alert">✕ Couldn't create wallet. Nothing was charged. Use “Try again”.</div>`:""}
<p><a class="btn ${S.sa?"":"sec"}" href="#/onboarding/key" ${S.sa?"":'aria-disabled="true" tabindex="-1" style="pointer-events:none;opacity:.45"'}>Continue</a></p>`)}
function O2bind(){const c=$("#cw"),s=$("#sg"),k=$("#cs");
 c&&(c.onclick=async()=>{let w;try{w=await api.get_wallet()}catch(e){return fail("get_wallet",e)}S.owner=w.owner;save();render();say("Wallet connected");$("#sg")?.focus()});
 s&&(s.onclick=async()=>{try{await api.submit_attestation("0xsig")}catch(e){return fail("submit_attestation",e)}S.attest=true;save();render();say("Attestation signed");$("#cs")?.focus()});
 const w2=$("#sw");w2&&(w2.onclick=()=>{S.switched=true;save();render();say("Switched to chain "+CHAIN_ID);$("#sg")?.focus()});
 k&&(k.onclick=async()=>{k.disabled=true;k.textContent="Creating…";if(S.dev.walletfail){await new Promise(r=>setTimeout(r,500));S.err="wallet";render();say("Couldn't create wallet");$("#cs")?.focus();return}let r;try{r=await api.create_smart_account(S.owner)}catch(e){S.err="wallet";return fail("create_smart_account",e)}S.sa=r.address;save();render();say("Smart wallet created")})}

// ---------- key form shared ----------
const CAP_TRADE=100,CAP_DAY=500;
const keyFields=(k)=>`<p class="muted" id="caphint">Up to $${CAP_TRADE} per trade / $${CAP_DAY} of buys per rolling 24h on testnet (sells don't count).</p><p class="muted dx-small fine">Your agent can sell your positions to mUSDG in $100 slices; sells over $500 in 24h need your approval.</p><label>Max per trade (USDG) <input id="pt" type="number" min="1" max="${CAP_TRADE}" aria-describedby="caphint" value="${Math.min(k.perTradeCap,CAP_TRADE)}"></label><label>Buy cap per 24h (USDG) <input id="dc" type="number" min="1" max="${CAP_DAY}" aria-describedby="caphint" value="${Math.min(k.dailyCap,CAP_DAY)}"></label>
<label>Expires in <select id="ex">${[7,3,1].map(d=>`<option value="${d}" ${k.days==d?"selected":""}>${d} day${d>1?"s":""}${d==7?" (max)":""}</option>`).join("")}</select></label>
<div><b>Allowlisted tickers</b> (allowlist-only, always on) ${B}<div id="al">${k.allowlist.map(t=>`<span class="chip">${t}<button type="button" data-rm="${t}" aria-label="Remove ${t}">✕</button></span>`).join("")}</div>
${(()=>{const left=(TICKERS||[]).filter(t=>!k.allowlist.includes(t));return TICKERS?(left.length?`<label class="row">Add ticker <select id="addt">${left.map(t=>`<option>${t}</option>`).join("")}</select> <button type="button" class="sec" id="addb">Add</button></label>`:`<p class="muted">All available tickers are on the allowlist.</p>`):`<p class="muted" role="status">⏳ Loading available tickers…</p>`})()}</div><p id="kerr" class="st err" role="alert" hidden></p>`;
let draft=null;
function bindKeyFields(){document.querySelectorAll("[data-rm]").forEach(b=>b.onclick=()=>{readDraft();draft.allowlist=draft.allowlist.filter(t=>t!=b.dataset.rm);render();say(b.dataset.rm+" removed")});
 const ab=$("#addb");ab&&(ab.onclick=()=>{readDraft();const t=$("#addt").value;if(t&&(TICKERS||[]).includes(t)&&!draft.allowlist.includes(t))draft.allowlist.push(t);render();say(t+" added");($("#addt")||$("#pt")).focus()});loadTickers()}
function readDraft(){draft.perTradeCap=+$("#pt").value;draft.dailyCap=+$("#dc").value;draft.days=+$("#ex").value}
function validate(){readDraft();const e=$("#kerr");let m="";if(!(draft.perTradeCap>0&&draft.dailyCap>0))m="Enter positive limits.";else if(draft.perTradeCap>CAP_TRADE||draft.dailyCap>CAP_DAY)m=`Up to $${CAP_TRADE} per trade / $${CAP_DAY} of buys per rolling 24h on testnet (sells don't count).`;else if(draft.perTradeCap>draft.dailyCap)m="Per-trade max can't exceed daily cap.";else if(!draft.allowlist.length)m="Add at least one ticker.";e.hidden=!m;e.textContent=m;return !m}
// Issue a key through api.create_session_key and keep what the server returns (id, expiresAt, status, txHash).
async function issueKey(d){const caps={perTradeCap:+d.perTradeCap,dailyCap:+d.dailyCap,days:+d.days||7,allowlist:[...d.allowlist]};const r=await api.create_session_key(caps)||{};
 const cr=r.created||{};return {status:"active",spentToday:0,...caps,...r,...cr,_revoked:r.revoked||null,id:cr.id||r.id||("sk_"+Math.random().toString(16).slice(2,8)),expiresAt:cr.expiresAt||r.expiresAt||new Date(Date.now()+caps.days*864e5).toISOString()}}
// Tx link: use the API's explorerUrl when it's a real URL (local chain returns "local-anvil/tx/…": show the hash only).
const txLink=(hash,url)=>{if(url&&/^local/.test(url)&&!S.localChain){S.localChain=true;save()}if(!hash)return"—";const u=url||`${EXPLORER}/tx/${hash}`;return /^https?:/.test(u)?`<a href="${u}" target="_blank" rel="noopener">${short(hash)} ↗</a>`:`<code title="${hash}">${short(hash)}</code> (local)`};
// Vault-wide rolling 24h cap ($500, shared by every agent key on the vault).
const vaultLeft=()=>{const r=ST&&ST.status&&ST.status.remaining24h;if(typeof r=="number")return r;const sp=S.key&&+S.key.spentToday||0;return Math.max(0,500-sp)};
const isVaultCap=(t)=>/shared by all agent keys|rolling-24h cap|rolling 24-hour cap|over \$500 per 24h/i.test(String(t||""));
const capMsg=()=>`Blocked: this vault's $500 rolling 24-hour buy cap is shared by all agent keys (sells don't count). $${vaultLeft().toFixed(2)} left.`;
const blockedText=(t,side)=>isVaultCap(t)?(side=="sell"?"Blocked: "+String(t||"sell failed").replace(/[^.]*(rolling|24h|24-hour|cap)[^.]*\.?/ig,"").trim()||"Blocked: sell failed":capMsg()):String(t||"Blocked");
// Visible API error (live server messages, e.g. 400/409/429/451), cleared on route change.
let apiErr=null;const fail=(where,e)=>{const m=(e&&e.message)||e;apiErr=isVaultCap(m)?capMsg():/pair not supported/i.test(String(m))?"That pair isn't supported. Swap stocks to or from mUSDG (e.g. TSLA → mUSDG, then mUSDG → AMZN).":`${where}: ${m}`;render();say(apiErr)};
// Allowlist choices come only from list_assets (stock tickers; the quote token mUSDG is excluded).
let TICKERS=null;async function loadTickers(){if(TICKERS)return;try{const a=await api.list_assets();TICKERS=(a||[]).map(x=>x.symbol).filter(t=>!/^m?USDG$/i.test(t));render()}catch(e){fail("list_assets",e)}}
const defaults=()=>({perTradeCap:100,dailyCap:500,days:7,allowlist:TICKERS?[...TICKERS]:[...api_allow]});let api_allow=["TSLA","AMZN","PLTR","NFLX","AMD"];

// ---------- O3 ----------
function O3(){if(!draft)draft=S.key?{...S.key,allowlist:[...S.key.allowlist]}:defaults();
 return ob(2,`<h1>Create your agent key</h1><p>A scoped key your AI agent uses. It can only trade through StockClaw, within these limits, and it expires.</p>${!S.sa?`<div class="st err">Create your smart wallet first. <a href="#/onboarding/wallet">Go to step 2</a></div>`:""}
${S.key?`<div class="st ok" role="status">✓ Agent key ${S.key.id} created: $${S.key.perTradeCap}/trade, $${S.key.dailyCap} buys/24h, expires ${fmtD(S.key.expiresAt)} (mock)</div><a class="btn" href="#/onboarding/faucet">Continue</a>`:
 `<form id="kf">${keyFields(draft)}<p class="muted">Over-limit trades are blocked onchain. No one-off approvals. Stock tokens can be frozen or restricted by their issuer; a frozen token can't be sold.</p><button ${S.sa?"":"disabled"}>Create agent key (signs 1 tx)</button></form>`}`)}
function O3bind(){const f=$("#kf");if(!f)return;bindKeyFields();f.onsubmit=async(e)=>{e.preventDefault();if(!validate())return;let k;try{k=await issueKey(draft)}catch(e){const er=$("#kerr");er.hidden=false;er.textContent="create_session_key: "+e.message;return}S.key=k;draft=null;save();render();say("Agent key created")}}

// ---------- O4 ----------
// Local chain: the server mints the test stock tokens itself, so the external faucet link is hidden.
// Robinhood Chain testnet and the local chain both use id 46630, so local is detected from the live server (localhost origin or local-* explorer URLs).
const isLocalChain=()=>!window.USE_MOCK&&CHAIN_ID==46630&&(/^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname)||S.localChain===true);
function O4(){const loc=isLocalChain();return ob(3,`<h1>Fund with test tokens</h1><p>Testnet tokens have no value. This replaces deposit/bridge/card for the demo.</p>
<div class="st"><b>1. Test ETH + stock tokens</b> ${B}<br>${loc?"Local chain: 5 each of mock TSLA/AMZN/PLTR/NFLX/AMD are minted to your smart wallet when you claim below.":`Robinhood Chain faucet: test ETH + mock TSLA/AMZN/PLTR/NFLX/AMD <a href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noopener">Open faucet ↗</a>`}<br>Send to: ${short(S.sa)||"(no smart wallet yet)"} ${S.sa?`<button class="sec" data-copy="${S.sa}">Copy</button>`:""}</div>
<div class="st"><b>2. Mock USDG</b><br>${S.funded?"✓ Claimed":`<button id="cl" ${S.claiming?"disabled":""}>Claim 1,000 mUSDG</button>`} <span class="muted">(mock amount, via faucet_testnet)</span></div>
${S.err=="rate"?`<div class="st err" role="alert">✕ Faucet rate limit reached. ${loc?"The faucet allows 1,000 mUSDG per 24 hours. Use “Skip for now” if the wallet is already funded.":`Try again later or use the <a href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noopener">alternate faucet ↗</a>.`}</div>`:""}${S.claiming?`<div class="st wait" role="status">⏳ Waiting for balances…</div>`:""}${S.funded?`<div class="st ok" role="status">✓ Received test ETH and mUSDG (mock). Ready.</div>`:""}
<p><a class="btn" href="#/onboarding/client" ${S.funded?"":'aria-disabled="true" tabindex="-1" style="pointer-events:none;opacity:.45"'}>Continue</a> ${S.funded?"":'<a href="#/onboarding/client">Skip for now</a>'}</p>`)}
function O4bind(){const b=$("#cl");b&&(b.onclick=async()=>{S.claiming=true;render();say("Waiting for balances");try{await api.faucet_testnet()}catch(e){S.claiming=false;if(e.status==429){S.err="rate";render();say("Faucet rate limit reached");return}return fail("faucet_testnet",e)}setTimeout(()=>{if(S.dev.ratelimit){S.claiming=false;S.err="rate";render();say("Faucet rate limit reached");$("#cl")?.focus();return}S.claiming=false;S.funded=true;save();render();say("Funded");$("main a.btn")?.focus()},1200)})}

// ---------- O5 ----------
const MCP="https://mcp.stockclaw.example/mcp";
const INSTR={Claude:"Open Claude → Settings → Connectors → Add custom connector, then paste the URL.",ChatGPT:"Open ChatGPT → Settings → Connectors → Add (developer mode), then paste the URL.",Grok:"Open Grok → Settings → Connectors → Add MCP server, then paste the URL.",Cursor:"Open Cursor → Settings → MCP → Add new server, or paste this config into ~/.cursor/mcp.json."};
function O5(){const c=S.client;const cfg=`{ "mcpServers": { "stockclaw": { "url": "${MCP}" } } }`;
 return ob(4,`<h1>Add StockClaw to your AI client</h1><div role="radiogroup" aria-label="AI client" class="row">${Object.keys(INSTR).map(k=>`<button class="${k==c?"":"sec"}" role="radio" aria-checked="${k==c}" data-cl="${k}">${k}</button>`).join("")}</div>
<p>${INSTR[c]}</p>${c=="Cursor"?`<pre>${esc(cfg)}</pre><button class="sec" data-copy='${cfg}'>Copy config</button>`:`<pre>${MCP}</pre><button class="sec" data-copy="${MCP}">Copy URL</button>`}
<p>Sign in (OAuth) and approve scopes: <b>read</b>, <b>trade</b> (within agent key limits).</p>
${S.connected?`<div class="st ok" role="status">✓ Connected to ${S.connected}. Try these prompts ${B}<ul><li>“Quote 10 mUSDG of TSLA” <button class="sec" data-copy="Quote 10 mUSDG of TSLA">Copy prompt</button></li><li>“DCA 10 mUSDG into AMZN daily for 5 days”</li><li>“What are my balances?”</li></ul></div>`:
 S.connecting?`<div class="st wait" role="status">⏳ Waiting for connection…</div>`:`${S.err=="oauth"?`<div class="st err" role="alert">✕ Authorization denied or timed out. Retry below, or check that you approved both scopes (read, trade) in ${c}.</div>`:""}<button id="oa">${S.err=="oauth"?"Retry: ":""}Sign in &amp; connect ${c} (mock OAuth)</button>`}
<p class="row"><a class="btn ${S.connected?"":"sec"}" href="#/onboarding/strategy">Next: pick a strategy (optional)</a> <a href="#/dashboard/overview">Skip to dashboard</a></p>`)}
function O5bind(){document.querySelectorAll("[data-cl]").forEach(b=>b.onclick=()=>{S.client=b.dataset.cl;save();render();$(`[data-cl="${S.client}"]`).focus()});
 const o=$("#oa");o&&(o.onclick=()=>{S.connecting=true;render();setTimeout(()=>{S.connecting=false;if(S.dev.oauthdeny){S.err="oauth";render();say("Authorization denied");$("#oa")?.focus();return}S.connected=S.client;save();render();say("Connected")},1000)})}

// ---------- Dashboard ----------
const TABS=[["overview","Overview"],["orders","Orders"],["history","History"],["fees","Fees"],["strategies","Strategies"],["key","Agent key"]];
function dash(t,body){const k=S.key,act=k&&k.status=="active";
 let ban=S.dev.service?`<div class="st err" role="alert"><b>Service issue.</b> Trading paused. Funds stay in your wallet. <a href="#/dashboard/overview">Status</a></div>`:"";if(!S.funded&&!(C.bal||[]).some(b=>/USDG/i.test(b.symbol)&&+b.amount>0))ban+=`<div class="st wait" role="status">Not funded. <a href="#/onboarding/faucet">Get testnet tokens</a></div>`;
 if(!act)ban+=`<div class="st err" role="alert">Agent key ${k?k.status:"not created"}. <a href="#/dashboard/key">Create new key</a></div>`;
 if(!S.connected)ban+=`<div class="st wait" role="status">AI client not connected. <a href="#/onboarding/client">Connect</a></div>`;
 return `<header class="card nav"><a class="logo" href="#/">StockClaw</a><span>${act?"● Agent active":"○ Agent "+(k?k.status:"none")} · wallet ${short(S.sa)||"—"}</span>${act?`<button class="danger" id="topRevoke">Revoke agent key</button>`:""}</header>
<nav class="tabs" aria-label="Dashboard">${TABS.map(([id,l])=>`<a href="#/dashboard/${id}" ${id==t?'aria-current="page"':""}>${l}</a>`).join("")}</nav>${ban}${dataErr()}${loadingRow()}<section class="card">${body}</section>${DISC}`}
// Dashboard data: fetched only through api.js functions; cached in memory (C) and, for orders/history, in S.
const C={bal:null,assets:null,loading:false,err:null};
async function loadDash(force){if(C.loading)return;if(!force&&C.err&&Date.now()-(C.errAt||0)<15000)return; // no auto-retry faster than 15s
if(!force&&C.bal&&C.assets&&S.orders&&S.history)return;C.loading=true;C.err=null;
 const r=await Promise.allSettled([api.get_balances(),api.list_assets(),api.get_wallet(),(force||!S.orders)?api.list_orders():null,(force||!S.history)?api.get_history(50):null]);
 const w=r.splice(2,1)[0];if(w.status=="fulfilled"&&w.value&&w.value.sessionKey&&S.key){const sk=w.value.sessionKey;if(!S.key.id||sk.id==S.key.id||S.key.status=="active")S.key={...S.key,...sk,status:sk.status=="revoked"&&S.key.status=="paused"?"paused":sk.status}}
 const bad=["get_balances","list_assets","list_orders","get_history"].filter((n,i)=>r[i].status=="rejected");if(w.status=="rejected")bad.push("get_wallet");
 if(r[0].status=="fulfilled")C.bal=r[0].value||[];if(r[1].status=="fulfilled")C.assets=r[1].value||[];
 if(r[2].status=="fulfilled"&&r[2].value){const prev=S.orders||[];S.orders=r[2].value.map(o=>({...o,status:(prev.find(x=>x.intentId==o.intentId)||{}).status=="cancelled"&&o.status!="filled"?"cancelled":o.status,cancelTx:(prev.find(x=>x.intentId==o.intentId)||{}).cancelTx}))}
 if(r[3].status=="fulfilled"&&r[3].value)S.history=r[3].value;
 C.err=bad.length?bad:null;C.errAt=bad.length?Date.now():0;C.loading=false;S.lastRefresh=Date.now();save();if(lastRoute&&lastRoute.startsWith("/dashboard"))render()}
function initData(){loadDash(false)}
const dataErr=()=>C.err?`<div class="st err" role="alert">✕ Couldn't load: ${C.err.join(", ")}. <button class="sec" id="dataRetry">Retry</button></div>`:"";
const loadingRow=(c)=>C.loading?`<p class="muted" role="status">⏳ Loading…</p>`:"";
const ago=()=>Math.round((Date.now()-S.lastRefresh)/1000);
function D1(){initData();const k=S.key;const bal=(C.bal||[]).filter(b=>+b.amount>0);
 return dash("overview",`<div class="row" style="justify-content:space-between"><h1>Overview</h1><span><span id="ago" role="status">Last updated ${ago()}s ago</span> <button class="sec" id="rf">Refresh</button></span></div>
<div class="grid"><div class="st"><b>Agent key</b><br>${k?`${k.status=="active"?"● Active":"○ "+k.status}, expires ${fmtD(k.expiresAt)}${window.USE_MOCK!==false?" (mock)":""}<br>Buy headroom (24h, all agents): $${vaultLeft().toFixed(2)} of $500 left<div class="meter" aria-hidden="true"><i style="width:${Math.min(100,(500-vaultLeft())/5)}%"></i></div>Per-trade cap $${k.perTradeCap} · <a href="#/dashboard/key">Edit limits</a>`:"None. <a href='#/dashboard/key'>Create</a>"}</div></div>
<h2>Balances ${B}</h2>${bal.length?`<div class="tw"><table><thead><tr><th>Token</th><th>Amount</th><th>Value (mock)</th></tr></thead><tbody>${bal.map(b=>`<tr><td>${b.symbol}</td><td>${(+b.amount).toLocaleString("en-US",{maximumFractionDigits:6})}</td><td>$${(+b.usdValue||0).toFixed(2)}</td></tr>`).join("")}</tbody></table></div>`:`<p class="muted">No balances yet. <a href="#/onboarding/faucet">Get testnet tokens</a></p>`}
<h2>Prices (MockAggregatorV3) ${B}</h2><div class="tw"><table><thead><tr><th>Token</th><th>Price (mock)</th><th>Source</th></tr></thead><tbody>${(C.assets||[]).map(a=>`<tr><td>${a.symbol}</td><td>$${(+a.priceUsd||0).toFixed(2)}</td><td>${a.source}</td></tr>`).join("")}</tbody></table></div>`)}
let tick;function D1bind(){clearInterval(tick);tick=setInterval(()=>{const e=$("#ago");e?e.textContent=`Last updated ${ago()}s ago`:clearInterval(tick)},1000);
 $("#rf").onclick=async()=>{$("#rf").textContent="Refreshing…";await loadDash(true);render();say("Refreshed");$("#rf").focus()}}
// Order status enum: open|paused|filled|cancelled|expired (legacy values normalized; "pending" = local cancel in flight).
const ost=(x)=>{const v=String(x.status||"").toLowerCase();if(v=="pending")return"pending";if(v=="active")return"open";if(v.startsWith("paused"))return"paused";return["open","filled","cancelled","expired"].includes(v)?v:"open"};
const OLBL={open:"Open",paused:"⏸ Paused (agent key inactive)",filled:"✓ Filled",cancelled:"✕ Cancelled",expired:"Expired",pending:"⏳ Cancelling…"};
const sched=(x)=>x.type=="DCA"?`${x.interval||"—"}, ${x.execs||""}${x.nextRunAt?", next "+fmtD(x.nextRunAt):""}`:`≤ $${(+x.limitPrice||0).toFixed(2)}${window.USE_MOCK!==false?" (mock)":""}${x.expiry?", expires "+fmtD(x.expiry):""}`;
const errLine=(x)=>x.lastError?`<br><span class="err-t">⚠ ${esc(blockedText(x.lastError))}</span>`:"";
function D2(){initData();const all=S.orders||[];const o=all.filter(x=>["open","paused","pending"].includes(ost(x)));const cl=all.filter(x=>["filled","cancelled","expired"].includes(ost(x)));
 return dash("orders",`<h1>Open orders ${B}</h1>${o.length?`<div class="tw"><table><thead><tr><th>Type</th><th>Pair</th><th>Amount</th><th>Schedule / limit</th><th>Status</th><th>Action</th></tr></thead><tbody>${o.map(x=>`<tr><td>${x.type}</td><td>${x.tokenIn} → ${x.tokenOut}</td><td>${x.amount} ${x.tokenIn}</td><td>${sched(x)}</td><td>${OLBL[ost(x)]}${errLine(x)}</td><td>${ost(x)=="pending"?"":`<button class="sec" data-cancel="${x.intentId}">Cancel</button>`}</td></tr>`).join("")}</tbody></table></div>`:`<p class="muted">No open orders. Ask your agent: “DCA 10 mUSDG into TSLA daily”.</p>`}
${cl.length?`<h2>Closed orders</h2><div class="tw"><table><thead><tr><th>Type</th><th>Pair</th><th>Amount</th><th>Schedule / limit</th><th>Status</th></tr></thead><tbody>${cl.map(x=>`<tr><td>${x.type}</td><td>${x.tokenIn} → ${x.tokenOut}</td><td>${x.amount} ${x.tokenIn}</td><td>${sched(x)}</td><td>${OLBL[ost(x)]}${x.cancelTx?" (tx "+txLink(x.cancelTx,x.cancelUrl)+")":""}${errLine(x)}</td></tr>`).join("")}</tbody></table></div>`:""}<p class="muted">Orders are created by your agent; you can cancel here.</p>`)}
function D2bind(){document.querySelectorAll("[data-cancel]").forEach(b=>b.onclick=()=>confirmDlg("Cancel this order?","This signs one onchain transaction. The order stops executing.","Yes, cancel order",async()=>{const x=S.orders.find(o=>o.intentId==b.dataset.cancel);x.prevStatus=x.status;x.status="pending";save();render();say("Cancelling");try{const cr=await api.cancel_order(x.intentId);x.cancelTx=cr&&cr.txHash;x.cancelUrl=cr&&cr.explorerUrl}catch(e){x.status=x.prevStatus||"open";save();return fail("cancel_order",e)}setTimeout(()=>{x.status="cancelled";save();render();say("Order cancelled, confirmed")},900)}))}
function D3(){initData();return dash("history",`<h1>Trade history ${B}</h1>${S.history&&S.history.length?"":C.loading?"":"<p class=muted>No trades yet.</p>"}<div class="tw"><table><thead><tr><th>Time</th><th>In</th><th>Out</th><th>Fee (0.30%, from input)</th><th>Status</th><th>Explorer</th></tr></thead><tbody>${(S.history||[]).map(h=>`<tr><td>${new Date(h.ts).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</td><td>${h.in}</td><td>${h.out}</td><td>${h.fee}</td><td>${h.status=="filled"?"✓ Filled":`✕ ${esc(isVaultCap(h.reason)&&h.side!="sell"&&!/^(?:[\d.]+\s*)?m?USDG$/i.test(String(h.out||"").split(/\s+/).pop()||"")?capMsg():"Blocked: "+h.reason)} <a href="#/dashboard/key">Agent key → limits</a>`}</td><td>${txLink(h.txHash,h.explorerUrl)}</td></tr>`).join("")}</tbody></table></div><p class="muted">In = gross amount; fee shown separately. Blocked trades are hard-blocked; no one-off approvals.</p>`)}
let feeQ=null;function D4(){initData();const q=feeQ;return dash("fees",`<h1>Fees</h1><div class="grid"><div class="st"><b>Fee rate</b><br>${(FEE_BPS/100).toFixed(2)}% taken from input token</div><div class="st"><b>Fees paid</b><br>${(S.history||[]).reduce((a,h)=>a+(parseFloat(h.fee)||0),0).toFixed(2)} mUSDG</div></div>
<h2>Example (mock)</h2><label>Amount in (mUSDG) <input id="fa" type="number" min="0" value="${q?q.amountIn:10}"></label>
<p role="status" id="fx">${q?`${q.amountIn.toFixed(2)} mUSDG in → ${q.feeAmount.toFixed(2)} fee → ${q.netIn.toFixed(2)} swapped.`:""}</p><p>Quotes are shown net of fee. Network gas on testnet is paid with test ETH. No tiers or subscriptions.</p>`)}
function D4bind(){const upd=async()=>{feeQ=await api.quote_swap("mUSDG","TSLA",+$("#fa").value||0);$("#fx").textContent=`${feeQ.amountIn.toFixed(2)} mUSDG in → ${feeQ.feeAmount.toFixed(2)} fee → ${feeQ.netIn.toFixed(2)} swapped.`};$("#fa").oninput=upd;if(!feeQ)upd()}
let stage=null;
function D5(){const k=S.key;if(!draft)draft=k?{...k,allowlist:[...k.allowlist]}:defaults();const act=k&&k.status=="active";
 const stg=stage?`<div class="card" role="status" aria-live="polite"><h3>Saving limits (1 transaction)</h3><ul class="stager">${[[`Old key ${stage.old} revoked${stage.revTx?" (tx "+txLink(stage.revTx,stage.revUrl)+")":""}`,1],[`New key issued: $${draft.perTradeCap} / $${draft.dailyCap} / allowlist, expires in ${draft.days} days`,2],["Agent reconnects automatically",3]].map(([t,n])=>`<li>${stage.fail&&n==1?"✕":stage.n>n?"✓":stage.n==n&&!stage.fail?"⏳":"○"} ${stage.fail&&n==1?`Revoke of ${stage.old} failed`:t}</li>`).join("")}</ul>${stage.fail?`<p class="st err" role="alert">✕ Tx failed${stage.msg?` (${esc(stage.msg)})`:""}. Old key ${stage.old} is still active; nothing changed. <button class="sec" id="rt">Retry</button></p>`:""}${stage.n>3?`<p class="st ok">✓ Done. New key ${S.key&&S.key.id}, tx ${txLink(S.key&&S.key.txHash,S.key&&S.key.explorerUrl)}.</p>`:""}</div>`:"";
 return dash("key",`<h1>Agent key</h1>${k?`<p>Key <code>${k.id}</code> · ${act?"● Active":"○ "+k.status} · expires ${fmtD(k.expiresAt)}${window.USE_MOCK!==false?" (mock)":""}</p>`:""}
<form id="lf">${keyFields(draft)}<button ${stage&&stage.n<=3&&!stage.fail?"disabled":""}>${act?"Save limits (re-issues key, 1 tx)":"Create new key (signs 1 tx)"}</button></form>${stg}
<h2>Pause agent</h2><label class="row"><input type="checkbox" role="switch" id="pz" ${act?"":"checked"} ${k?"":"disabled"}> Pause agent <span>(${act?"Active":k?(k.status=="paused"?"Paused":"Key "+k.status):"No key"})</span></label><p class="muted">Pausing revokes the agent key: an onchain action that needs your wallet signature. Resuming issues a new key with the same limits: also an onchain action that needs your wallet signature. Keys also auto-expire after 7 days.</p>
<h2>Revoke agent key</h2><p>Your AI agent immediately loses the ability to trade. Open DCA/limit orders stop executing. Funds stay in your smart wallet.</p><button class="danger" id="rv" ${act?"":"disabled"}>Revoke…</button>
${k&&k.status=="revoked"?`<div class="st ok" role="status">✓ Revoked. Tx ${txLink((S.lastRevoke||{}).txHash,(S.lastRevoke||{}).explorerUrl)}</div>`:""}`)}
async function doRevoke(status){stage=null;try{const rr=await api.revoke_session_key();S.lastRevoke=rr||{}}catch(e){return fail("revoke_session_key",e)}S.key.status=status;if(S.mockAct&&S.mockAct.status=="active"){S.mockAct.status="paused"}if(ST.status&&ST.status.status=="active")ST.status.status="paused";save();draft=null;render();say("Agent key "+status+(ST.status?"; strategy paused":""))}
function D5bind(){bindKeyFields();const rt=$("#rt");rt&&(rt.onclick=()=>{stage=null;$("#lf").requestSubmit()});
 $("#lf").onsubmit=async(e)=>{e.preventDefault();if(!validate())return;const k=S.key,act=k&&k.status=="active";
  if(!act){let n;try{n=await issueKey(draft)}catch(e){return fail("create_session_key",e)}S.key=n;save();draft=null;render();say("New key created");return}
  // One create_session_key call (server revokes the old key and issues the new one in the same tx).
  stage={n:1,old:k.id};render();say("Saving limits: 1 transaction");
  if(S.dev.limitsfail){setTimeout(()=>{stage.fail=true;render();say("Transaction failed. Old key still active")},900);return}
  let n;try{n=await issueKey(draft)}catch(e){stage.fail=true;stage.msg=e.message;render();say("Transaction failed. Old key still active");return}
  const rv=n._revoked||{};stage.old=rv.id||rv.key||k.id;stage.revTx=rv.txHash||null;stage.revUrl=rv.explorerUrl||null;delete n._revoked;
  setTimeout(()=>{stage.n=2;render();say("Old key revoked");
   setTimeout(()=>{S.key=n;save();stage.n=3;render();say("New key issued");setTimeout(()=>{stage.n=4;render();say("Limits saved, new key active");setTimeout(()=>{if(stage&&stage.n>3){stage=null;if(lastRoute=="/dashboard/key")render()}},4000)},800)},800)},800)};
 const p=$("#pz");p.onchange=()=>{const want=p.checked;p.checked=!want;
  if(want)confirmDlg("Pause agent?","Pausing revokes the agent key. This is an onchain action that needs your wallet signature (1 tx).","Sign & pause",()=>doRevoke("paused"));
  else confirmDlg("Resume agent?","Resuming issues a new agent key with the same limits. This is an onchain action that needs your wallet signature (1 tx).","Sign & resume",async()=>{stage=null;let n;try{n=await issueKey(S.key)}catch(e){return fail("create_session_key",e)}S.key=n;save();draft=null;render();say("Agent resumed")})};
 const r=$("#rv");r.onclick=()=>confirmDlg("Revoke agent key?","This signs one transaction. You can create a new key later.","Yes, revoke",()=>doRevoke("revoked"))}

// ---------- modal (focus-trapped, Esc cancels, focus starts on Cancel) ----------
function confirmDlg(title,body,yes,fn){const m=$("#modal"),back=document.activeElement;
 m.innerHTML=`<div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dt" aria-describedby="dd"><h2 id="dt">${title}</h2><p id="dd">${body}</p><div class="row"><button class="danger" id="dy">${yes}</button><button class="sec" id="dn">Cancel</button></div></div>`;m.hidden=false;$("#dn").focus();
 const close=()=>{m.hidden=true;m.innerHTML="";document.removeEventListener("keydown",kd);back&&document.body.contains(back)&&back.focus()};
 const kd=(e)=>{if(e.key=="Escape")close();if(e.key=="Tab"){const a=$("#dy"),b=$("#dn");if(e.shiftKey&&document.activeElement==a){e.preventDefault();b.focus()}else if(!e.shiftKey&&document.activeElement==b){e.preventDefault();a.focus()}}};
 document.addEventListener("keydown",kd);$("#dn").onclick=close;$("#dy").onclick=()=>{close();fn()}}

// ---------- Strategy agents (STRATEGIES.md §4/§5/§7) ----------
// Calls go through api.<name> when api.js has it; otherwise REST (§5) in live mode; on 404/unreachable or ?mock=1, a local mock.
// Trend Flip: 9 EMA / VWAP flip strategy (momentum-rider slot). Rename here only.
const FLIP_NAME="Trend Flip";
const SAVATAR={"steady-stacker":"avatars/steady-stacker.png","dip-hunter":"avatars/dip-hunter.png","ema-vwap-flip":"avatars/trend-flip.png","momentum-rider":"avatars/trend-flip.png","trend-flip":"avatars/trend-flip.png","monday-planner":"avatars/weekend-edge.png","ai-thematic":"avatars/ai-thematic.png","weekend-edge":"avatars/weekend-edge.png"};
const STOCKS=["TSLA","AMZN","PLTR","NFLX","AMD"];
const SDISC='<p class="disc"><b>Tools, not investment advice. Final copy pending.</b> Testnet tokens have no value. You choose the parameters; StockClaw executes them within your limits.</p>';
const MOCK_STRATS=[
 {id:"steady-stacker",version:"1.0.0",strategyHash:"0x5s1a…mock",name:"Steady Stacker",summary:"Fixed-dollar buys on a schedule, split across a basket you pick.",runsIn:"keeper",risks:["Buys at any price","Schedule may skip closed-market slots"],demoAvailable:true,defaults:{basket:[{symbol:"TSLA",weightBps:3400},{symbol:"AMD",weightBps:3300},{symbol:"PLTR",weightBps:3300}],usdPerPeriod:30,period:"weekly",maxPeriods:12,oracleDevBps:100}},
 {id:"dip-hunter",version:"1.0.0",strategyHash:"0xd1p2…mock",name:"Dip Hunter",summary:"Buy limits at drops you set, each with a take-profit sell when it fills.",runsIn:"keeper",risks:["Rungs may never fill","Several rungs can fire in one drop (capped by the vault's shared $500/24h buy cap)"],demoAvailable:true,defaults:{symbol:"AMD",referencePrice:"oracle_at_start",dropsBps:[200,500],usdPerRung:25,takeProfitBps:200,sellFractionBps:10000,expiryDays:7,oracleDevBps:100}},
 {id:"ema-vwap-flip",version:"0.1.0",strategyHash:null,name:FLIP_NAME,summary:"Buys when the 9 EMA crosses above VWAP and holds; sells to mUSDG when it crosses back below. Rules you set.",runsIn:"keeper",risks:["Not available yet"],demoAvailable:false},
 {id:"ai-thematic",version:"0.1.0",strategyHash:null,name:"AI Thematic",summary:"Your AI reads news and suggests allocation changes; you approve every trade.",runsIn:"client",risks:["Model suggestions are bounded but can be wrong"],demoAvailable:false},
 {id:"weekend-edge",version:"0.1.0",strategyHash:null,name:"Weekend Edge",summary:"Your AI reviews the weekend and queues limit orders for Monday's open; you approve each one.",runsIn:"client",risks:["Orders only fill in market hours"],demoAvailable:false}];
// Server ids/names that differ from the decided card labels (STRATEGIES.md: S3 is Trend Flip; slot keeps the teal goggles avatar).
const NAME_OVERRIDE={"momentum-rider":FLIP_NAME,"ema-vwap-flip":FLIP_NAME};
const FLIP_SUMMARY="Buys when the 9 EMA crosses above VWAP and holds; sells to mUSDG when it crosses back below. Rules you set.";
const normStrat=(x)=>({...x,name:NAME_OVERRIDE[x.id]||x.name,summary:NAME_OVERRIDE[x.id]?FLIP_SUMMARY:x.summary,demoAvailable:x.demoAvailable!==false&&!x.comingSoon});
const smock={
 list_strategies:async()=>MOCK_STRATS,
 preview_strategy:async({id,version,params})=>{const errs=stratErrors(id,params);let planned=[],worst=0;
  if(id=="steady-stacker"){planned=(params.basket||[]).map(b=>({type:"DCA",tokenIn:"mUSDG",tokenOut:b.symbol,amountUsd:+(params.usdPerPeriod*b.weightBps/10000).toFixed(2),trigger:params.period,startTime:null}));worst=+params.usdPerPeriod||0}
  if(id=="dip-hunter"){planned=(params.dropsBps||[]).map(d=>({type:"Limit buy",tokenIn:"mUSDG",tokenOut:params.symbol,amountUsd:+params.usdPerRung,trigger:`price ≤ ref − ${(d/100).toFixed(1)}%`,startTime:null}));worst=Math.min(500,(params.dropsBps||[]).length*(+params.usdPerRung||0))}
  return {valid:!errs.length,errors:errs,plannedIntents:planned,worstCaseUsdPer24h:worst,capHeadroom:Math.max(0,500-worst)}},
 choose_strategy:async({id,version,params,confirmHash})=>{const a={activationId:"act_"+Math.random().toString(16).slice(2,8),id,version,strategyHash:confirmHash,params,status:"active",intents:[],fills:[],createdAt:new Date().toISOString()};S.mockAct=a;save();return {activationId:a.activationId,strategyHash:a.strategyHash,intents:a.intents,status:"active"}},
 get_strategy_status:async()=>{const a=S.mockAct;if(!a)return null;const nx=new Date(Date.now()+(a.id=="steady-stacker"?864e5:36e5)).toISOString();
  const fills=a.id=="steady-stacker"?(a.params.basket||[]).slice(0,2).map((b,i)=>({ts:new Date(Date.now()-(i+1)*36e5).toISOString(),side:"buy",symbol:b.symbol,amountUsd:+(a.params.usdPerPeriod*b.weightBps/10000).toFixed(2),status:"filled",txHash:"0xMOCKFILL"+i})):[{ts:new Date(Date.now()-18e5).toISOString(),side:"buy",symbol:a.params.symbol,amountUsd:a.params.usdPerRung,status:"filled",txHash:"0xMOCKFILL0"},{ts:new Date(Date.now()-6e5).toISOString(),side:"buy",symbol:a.params.symbol,amountUsd:a.params.usdPerRung,status:"blocked",lastError:"Blocked by limit: vault's $500.00 rolling-24h cap shared by all agent keys (would be $525.00)"}];
  return {activationId:a.activationId,id:a.id,version:a.version,status:a.status,strategyHash:a.strategyHash,params:a.params,lastAction:fills[0]?{ts:fills[0].ts,text:`${fills[0].side} ${fills[0].symbol} $${fills[0].amountUsd}`}:null,nextAction:a.status=="active"?{ts:nx,text:a.id=="steady-stacker"?`Next ${a.params.period} buy`:"Watching buy limits"}:null,
   intents:[],fills,spent24h:fills.filter(f=>f.status=="filled").reduce((s,f)=>s+f.amountUsd,0),remaining24h:500-fills.filter(f=>f.status=="filled").reduce((s,f)=>s+f.amountUsd,0)}},
 pause_strategy:async(id)=>{if(S.mockAct){S.mockAct.status="paused";save()}return {status:"paused",cancelled:[]}},
 resume_strategy:async(id)=>{if(S.mockAct){S.mockAct.status="active";save()}return {status:"active",txs:[]}},
 stop_strategy:async(id)=>{if(S.mockAct){S.mockAct.status="stopped";save()}return {status:"stopped"}}};
// Uses the presenter token from sessionStorage ("stockclaw-owner-token", same key as api.js); owner calls also send X-Owner-Token.
async function rest(method,path,body,owner){const tok=getTok();const r=await fetch(`${typeof API_BASE!=="undefined"?API_BASE:location.origin}/api${path}`,{method,headers:{"content-type":"application/json",...(tok?{authorization:`Bearer ${tok}`,...(owner?{"x-owner-token":tok}:{})}:{})},body:body?JSON.stringify(body):undefined});
 if(r.status==401||r.status==403){const e=new Error("Owner token required for this action.");e.status=r.status;throw e}
 if(r.status==404)throw{fallback:1};const d=await r.json().catch(()=>{throw{fallback:1}});if(!r.ok){const e=new Error(d.error||"HTTP "+r.status);e.status=r.status;throw e}return d}
const SREST={list_strategies:()=>rest("GET","/strategies"),preview_strategy:(b)=>rest("POST","/strategies/preview",b),
 choose_strategy:(b)=>rest("POST","/strategies/activate",b,true), // owner: propose + confirm in one call
 get_strategy_status:async(id)=>{const r=await rest("GET",id?"/strategies/activations/"+id:"/strategies/status");if(!r||r.status=="none"||!r.activationId)return null;return r},
 pause_strategy:(id)=>rest("POST",`/strategies/activations/${id}/pause`,{},true),resume_strategy:(id)=>rest("POST",`/strategies/activations/${id}/resume`,{},true),stop_strategy:(id)=>rest("POST",`/strategies/activations/${id}/stop`,{},true)};
// Normalize a status object (server: strategyId, intents[{role,status,nextRunAt,lastError}], fills[]) for the view.
function normStatus(r){if(!r)return null;const id=r.strategyId||r.id;const fills=(r.fills||[]).map(f=>({...f,ts:f.ts||f.time||f.at,symbol:f.symbol||f.tokenOut||f.token,side:f.side||(f.role=="take-profit"?"sell":"buy"),amountUsd:f.amountUsd??f.usd??f.amountIn}));
 const nexts=(r.intents||[]).filter(i=>i.nextRunAt&&["open","active"].includes(String(i.status))).map(i=>i.nextRunAt).sort();const last=fills.slice().sort((a,b)=>String(b.ts).localeCompare(String(a.ts)))[0];
 return {...r,id,fills,lastAction:r.lastAction||(last?{ts:last.ts,text:`${last.side} ${last.symbol||""} $${(+last.amountUsd||0).toFixed(2)}`}:null),nextAction:r.nextAction||(nexts[0]&&r.status=="active"?{ts:nexts[0],text:"Next scheduled order"}:null)}}
let ownerSimulated=false;(async()=>{try{if(!window.USE_MOCK){let h;try{const c=JSON.parse(sessionStorage.getItem("stockclaw-health")||"null");if(c&&Date.now()-c.t<15000)h=c.h}catch(e){}if(!h){h=await fetch((typeof API_BASE!=="undefined"?API_BASE:location.origin)+"/api/health").then(r=>r.ok?r.json():{});try{sessionStorage.setItem("stockclaw-health",JSON.stringify({t:Date.now(),h}))}catch(e){}}ownerSimulated=!!h.ownerSimulated}}catch(e){}})();
let stratMockUsed=false;
const sapi=(name,...a)=>(async()=>{if(api[name])return api[name](...a);if(window.USE_MOCK){stratMockUsed=true;return smock[name](...a)}
 try{return await SREST[name](...a)}catch(e){if(e&&e.fallback||e instanceof TypeError){stratMockUsed=true;return smock[name](...a)}throw e}})();
// Client-side validation mirrors the schema bounds (server re-validates).
const BOUNDS={usd:[5,100],basketUsd:[5,500],weightPct:[5,100],maxPeriods:[1,52],dev:[10,300],dropPct:[1,30],tpPct:[1,50],sellPct:[10,100],expiry:[1,7]};
function sMax(id,prop,dflt){const sc=(sById(id)||{}).paramsSchema;const v=sc&&sc.properties&&sc.properties[prop]&&sc.properties[prop].maximum;return typeof v=="number"?v:dflt}
function stratErrors(id,p){const e=[];const inr=(v,[a,b])=>typeof v=="number"&&isFinite(v)&&v>=a&&v<=b;
 if(id=="steady-stacker"){const bk=p.basket||[];if(!bk.length)e.push("Pick at least one token.");if(bk.length>5)e.push("At most 5 tokens.");
  bk.forEach(b=>{if(!STOCKS.includes(b.symbol))e.push(`${b.symbol} isn't available.`);if(!inr(b.weightBps/100,BOUNDS.weightPct))e.push(`${b.symbol} weight must be 5–100%.`)});
  const sum=bk.reduce((s,b)=>s+b.weightBps,0);if(bk.length&&sum!==10000)e.push(`Weights must add up to 100% (now ${(sum/100).toFixed(0)}%).`);
  if(!inr(p.usdPerPeriod,BOUNDS.basketUsd))e.push("Basket amount per period must be $5–$500.");else bk.forEach(b=>{if(p.usdPerPeriod*b.weightBps/10000<1)e.push(`${b.symbol} slice is under $1.`)});
  if(!["daily","weekly"].includes(p.period))e.push("Period must be daily or weekly.");if(!Number.isInteger(p.maxPeriods)||!inr(p.maxPeriods,BOUNDS.maxPeriods))e.push("Number of periods must be 1–52.");}
 if(id=="dip-hunter"){if(!STOCKS.includes(p.symbol))e.push("Pick a token.");const d=p.dropsBps||[];if(d.length<1||d.length>4)e.push("Use 1–4 rungs.");
  d.forEach((x,i)=>{if(!inr(x/100,BOUNDS.dropPct))e.push(`Rung ${i+1} drop must be 1–30%.`)});{const mx=sMax(id,"usdPerRung",100);if(!inr(p.usdPerRung,[5,mx]))e.push(`Amount per rung must be $5–$${mx}.`)}
  if(!inr(p.takeProfitBps/100,BOUNDS.tpPct))e.push("Take-profit must be 1–50%.");if(!inr(p.sellFractionBps/100,BOUNDS.sellPct))e.push("Sell fraction must be 10–100%.");
  if(!Number.isInteger(p.expiryDays)||!inr(p.expiryDays,BOUNDS.expiry))e.push("Expiry must be 1–7 days.");}
 if(!Number.isInteger(p.oracleDevBps)||!inr(p.oracleDevBps,BOUNDS.dev))e.push("Max price deviation must be 10–300 bps.");return e}
const ST={list:null,status:undefined,loading:false,err:null,draft:null,preview:null,ack:false,busy:false};
async function loadStrats(force){if(ST.loading||(!force&&ST.list&&ST.status!==undefined))return;if(!force&&ST.err&&Date.now()-(ST.errAt||0)<15000)return;ST.loading=true;
 try{const [l,s]=await Promise.all([sapi("list_strategies"),sapi("get_strategy_status")]);ST.list=(l||[]).map(normStrat);const ns=normStatus(s);ST.status=ns&&!["stopped","rejected","none"].includes(ns.status)?ns:null;ST.err=null}catch(e){ST.err=e.message||String(e);ST.errAt=Date.now()}
 ST.loading=false;if(/strateg/.test(lastRoute||""))render()}
const sById=(id)=>(ST.list||MOCK_STRATS).find(s=>s.id==id)||MOCK_STRATS.find(s=>s.id==id);
const avatar=(id,size,extra="")=>`<img class="av ${extra}" src="${SAVATAR[id]||""}" width="${size}" height="${size}" alt="${esc((sById(id)||{}).name||id)} avatar">`;
const runsLbl=(r)=>r=="client"?"Runs on: your AI (you approve trades)":r=="both"?"Runs on: our keeper + your AI":"Runs on: our keeper";
function gallery(base){const cur=ST.status;return `${ST.loading&&!ST.list?'<p class="muted" role="status">⏳ Loading strategies…</p>':""}${ST.err?`<div class="st err" role="alert">✕ Couldn't load strategies: ${esc(ST.err)} <button class="sec" id="sRetry">Retry</button></div>`:""}
<ul class="sgrid" role="list">${(ST.list||MOCK_STRATS).map(s=>{const on=s.demoAvailable;const active=cur&&cur.id==s.id;return `<li class="scard ${on?"":"soon"}">${avatar(s.id,72,on?"":"grey")}
<div><h3>${esc(s.name)} <span class="badge">Testnet</span>${active?(cur.status=="active"?' <span class="chip2">Active</span>':' <span class="rchip">⏸ Paused</span>'):""}</h3><p>${esc(s.summary)}</p><p class="muted">${runsLbl(s.runsIn)} · v${esc(s.version)}</p>
<p>${(s.risks||[]).map(r=>`<span class="rchip">${esc(r)}</span>`).join(" ")}</p>
${on?`<a class="btn ${active?"sec":""}" href="${base}/${s.id}">${active?"Edit / re-pick":"Set up"}</a>`:`<button disabled aria-disabled="true">Coming soon</button>`}</div></li>`}).join("")}</ul>
<p class="muted">Baskets use the 5 testnet tokens: ${STOCKS.join(", ")} ${B}</p>${SDISC}`}
function defaultsFor(id){const s=sById(id);return JSON.parse(JSON.stringify((s&&s.defaults)||{}))}
function setupForm(id){const p=ST.draft;const s=sById(id);if(id=="steady-stacker"){const w=Object.fromEntries((p.basket||[]).map(b=>[b.symbol,b.weightBps/100]));
 return `<fieldset><legend>Basket (1–5 tokens, weights add up to 100%) ${B}</legend>${STOCKS.map(t=>`<div class="row"><label style="display:inline"><input type="checkbox" data-bk="${t}" ${t in w?"checked":""}> ${t}</label><label style="display:inline">weight % <input type="number" data-bw="${t}" min="5" max="100" step="1" value="${w[t]??""}" ${t in w?"":"disabled"} aria-label="${t} weight percent"></label></div>`).join("")}</fieldset>
<label>Basket amount per period (mUSDG, $5–$500; each single trade still ≤ $100) <input id="s_usd" type="number" min="5" max="500" step="1" value="${p.usdPerPeriod}"></label>
<label>Period <select id="s_per"><option ${p.period=="daily"?"selected":""}>daily</option><option ${p.period=="weekly"?"selected":""}>weekly</option></select></label>
<label>Number of periods (1–52) <input id="s_mp" type="number" min="1" max="52" step="1" value="${p.maxPeriods}"></label>`}
 return `<label>Token ${B} <select id="s_sym">${STOCKS.map(t=>`<option ${p.symbol==t?"selected":""}>${t}</option>`).join("")}</select></label>
<label>Reference price <select id="s_ref"><option value="oracle_at_start" ${p.referencePrice!="high_7d_keeper"?"selected":""}>Price at start</option><option value="high_7d_keeper" ${p.referencePrice=="high_7d_keeper"?"selected":""}>7-day high (keeper)</option></select></label>
<fieldset><legend>Buy rungs: drop from reference (1–4 rungs, 1–30% each)</legend>${(p.dropsBps||[]).map((d,i)=>`<div class="row"><label style="display:inline">Rung ${i+1} drop % <input type="number" data-drop="${i}" min="1" max="30" step="0.5" value="${d/100}"></label>${p.dropsBps.length>1?`<button type="button" class="sec" data-rmdrop="${i}" aria-label="Remove rung ${i+1}">Remove</button>`:""}</div>`).join("")}
${p.dropsBps.length<4?'<button type="button" class="sec" id="s_add">Add rung</button>':""}</fieldset>
<label>Amount per rung (mUSDG, $5–$${sMax(id,"usdPerRung",100)}) <input id="s_usd" type="number" min="5" max="${sMax(id,"usdPerRung",100)}" step="1" value="${p.usdPerRung}"></label>
<label>Take-profit above fill (1–50%) <input id="s_tp" type="number" min="1" max="50" step="0.5" value="${p.takeProfitBps/100}"></label>
<label>Sell fraction on take-profit (10–100%) <input id="s_sf" type="number" min="10" max="100" step="5" value="${p.sellFractionBps/100}"></label>
<label>Expiry (1–7 days) <input id="s_ex" type="number" min="1" max="7" step="1" value="${p.expiryDays}"></label>`}
function readSetup(id){const p=ST.draft,n=(sel)=>{const v=$(sel)?.value;return v===""||v==null?NaN:+v};
 if(id=="steady-stacker"){p.basket=STOCKS.filter(t=>$(`[data-bk="${t}"]`).checked).map(t=>({symbol:t,weightBps:Math.round(n(`[data-bw="${t}"]`)*100)}));p.usdPerPeriod=n("#s_usd");p.period=$("#s_per").value;p.maxPeriods=n("#s_mp")}
 else{p.symbol=$("#s_sym").value;p.referencePrice=$("#s_ref").value;p.dropsBps=[...document.querySelectorAll("[data-drop]")].map(x=>Math.round(+x.value*100));p.usdPerRung=n("#s_usd");p.takeProfitBps=Math.round(n("#s_tp")*100);p.sellFractionBps=Math.round(n("#s_sf")*100);p.expiryDays=n("#s_ex")}
 p.oracleDevBps=n("#s_dev")}
function SETUP(id,base,back){const s=sById(id);if(!s||!s.demoAvailable)return `<p>That strategy isn't available yet. <a href="${back}">Back to strategies</a></p>`;
 if(!ST.draft||ST.draftId!=id){ST.draftId=id;ST.draft=(ST.status&&ST.status.id==id&&ST.status.params)?JSON.parse(JSON.stringify(ST.status.params)):defaultsFor(id);ST.preview=null;ST.ack=false}
 const pv=ST.preview,errs=stratErrors(id,ST.draft),worst=pv?pv.worstCaseUsdPer24h:null,cur=ST.status;
 return `<p><a href="${back}">← All strategies</a></p><div class="row">${avatar(id,64)}<div><h1 style="margin:0">Set up ${esc(s.name)}</h1><p class="muted" style="margin:0">${esc(s.summary)} · v${esc(s.version)}</p></div></div>
<form id="sf" novalidate>${setupForm(id)}<label>Max price deviation from oracle (10–300 bps) <input id="s_dev" type="number" min="10" max="300" step="1" value="${ST.draft.oracleDevBps}"></label>
<div id="serr" class="st err" role="alert" ${errs.length?"":"hidden"}>${errs.map(esc).join("<br>")}</div>
<h2>Worst case per 24h</h2>${errs.length?'<p class="muted">Fix the errors above to see the worst case.</p>':worst!=null?`<p>Worst case: $${worst.toFixed(2)} of buys per 24h. Buy headroom (24h, all agents): $${(pv.capHeadroom!=null?+pv.capHeadroom+worst:vaultLeft()).toFixed(2)} of $500${pv.capHeadroom!=null?`; $${Math.max(0,+pv.capHeadroom).toFixed(2)} left after this strategy`:""}.</p>${pv.capHeadroom!=null&&+pv.capHeadroom<0?`<p class="st err" role="alert">Some orders would be blocked: this vault's $500 rolling 24-hour buy cap is shared by all agent keys (sells don't count). $${Math.max(0,+pv.capHeadroom+worst).toFixed(2)} left.</p>`:""}<div class="meter" role="img" aria-label="Worst case ${worst} dollars of the 500 dollar vault cap"><i style="width:${Math.min(100,worst/5)}%"></i></div>`:'<p class="muted">Updates as you edit.</p>'}
<h2>Review</h2>${paramTable(ST.draft,pv,errs)}${!errs.length&&pv&&pv.plannedIntents?.length?`<ul>${pv.plannedIntents.map(i=>`<li>${esc(i.type)}: $${(+i.amountUsd).toFixed(2)} ${esc(i.tokenIn)} → ${esc(i.tokenOut)} (${esc(i.trigger||"")})</li>`).join("")}</ul>`:'<p class="muted">Planned orders appear here.</p>'}
<p class="muted">Strategy hash: <code>${esc(short((pv&&pv.strategyHash)||s.strategyHash||"")||"—")}</code>. Orders run within your limits ($100 per trade; $500 of buys per rolling 24 hours per vault, shared by all agent keys; sells don't count) and stop if the key is revoked. Stock tokens can be frozen or restricted by their issuer; a frozen token can't be sold.</p>
<label><input type="checkbox" id="s_ack" ${ST.ack?"checked":""}> I understand: tools, not investment advice; testnet tokens have no value; I chose these parameters.</label>
<p class="disc"><b>Tools, not investment advice. Final copy pending.</b></p>
${ownerSimulated?'<p class="muted"><span class="rchip">Simulated owner wallet</span> The demo server signs owner actions for you.</p>':""}<button id="s_go" ${ST.busy?"disabled":""}>${cur&&cur.id!=id?"Replace current strategy & activate":"Activate strategy"}</button>${stratMockUsed?' <span class="muted">(mock data)</span>':""}</form>`}
let pvTimer;function SETUPbind(id,after){const f=$("#sf");if(!f)return;const upd=()=>{readSetup(id);const errs=stratErrors(id,ST.draft);const e=$("#serr");e.hidden=!errs.length;e.innerHTML=errs.map(esc).join("<br>");clearTimeout(pvTimer);
  pvTimer=setTimeout(async()=>{try{ST.preview=await sapi("preview_strategy",{id,version:sById(id).version,params:ST.draft})}catch(x){ST.preview=null}const a=document.activeElement&&document.activeElement.id||document.activeElement?.dataset&&Object.entries(document.activeElement.dataset)[0];render();restoreFocus(a)},250)};
 f.oninput=upd;f.onchange=(ev)=>{if(ev.target.dataset.bk){const t=ev.target.dataset.bk,inp=$(`[data-bw="${t}"]`);inp.disabled=!ev.target.checked;if(ev.target.checked&&!inp.value)inp.value=5}if(ev.target.id=="s_ack")ST.ack=ev.target.checked;upd()};
 const ad=$("#s_add");ad&&(ad.onclick=()=>{readSetup(id);ST.draft.dropsBps.push(Math.min(3000,(ST.draft.dropsBps.at(-1)||0)+300));render();$(`[data-drop="${ST.draft.dropsBps.length-1}"]`)?.focus()});
 document.querySelectorAll("[data-rmdrop]").forEach(b=>b.onclick=()=>{readSetup(id);ST.draft.dropsBps.splice(+b.dataset.rmdrop,1);render();$("#s_add,[data-drop]")?.focus()});
 if(!ST.preview)upd();
 f.onsubmit=async(ev)=>{ev.preventDefault();readSetup(id);const errs=stratErrors(id,ST.draft);if(errs.length){$("#serr").hidden=false;$("#serr").innerHTML=errs.map(esc).join("<br>");$("#serr").focus?.();say(errs[0]);return}
  if(!$("#s_ack").checked){$("#serr").hidden=false;$("#serr").textContent="Tick the acknowledgement to continue.";say("Tick the acknowledgement to continue");$("#s_ack").focus();return}
  const s=sById(id),go=async()=>{ST.busy=true;render();try{let pv=await sapi("preview_strategy",{id,version:s.version,params:ST.draft});if(pv&&pv.valid===false)throw new Error((pv.errors||[]).join(" ")||"Invalid parameters");
    const replace=!!(ST.status&&ST.status.activationId);
    await sapi("choose_strategy",{id,version:s.version,params:ST.draft,confirmHash:(pv&&pv.strategyHash)||s.strategyHash,replace});ST.busy=false;ST.draft=null;ST.status=undefined;await loadStrats(true);say(s.name+" active");go_(after)}catch(x){ST.busy=false;fail("choose_strategy",x)}};
  if(ST.status&&ST.status.id!=id)confirmDlg("Replace current strategy?",`One strategy per vault. Activating ${esc(s.name)} stops ${esc(sById(ST.status.id)?.name||"the current strategy")} and cancels its open orders (onchain, needs your wallet signature).`,"Replace & activate",go);
  else confirmDlg(`Activate ${esc(s.name)}?`,"This signs the strategy's orders with your agent key. They run within your $100/trade and $500-per-24h buy limits. Onchain action; needs your wallet signature.","Activate",go)}}
const go_=(h)=>{location.hash=h};
function restoreFocus(a){if(!a)return;if(typeof a=="string")$("#"+a)?.focus();else{const [k,v]=a;document.querySelector(`[data-${k.replace(/[A-Z]/g,m=>"-"+m.toLowerCase())}="${v}"]`)?.focus()}}
function statusView(){const s=ST.status;if(!s)return"";const meta=sById(s.id)||{name:s.id};const on=s.status=="active";
 return `<section class="card" aria-labelledby="sv-h"><div class="row">${avatar(s.id,80)}<div><h2 id="sv-h" style="margin:0">${esc(meta.name)} <span class="badge">Testnet</span></h2>
<p style="margin:0">State: <b>${on?"● Active":s.status=="paused"?"⏸ Paused":esc(s.status)}</b> · hash <code>${esc(short(s.strategyHash||"")||"—")}</code></p></div></div>
<div class="grid"><div class="st"><b>Last action</b><br>${s.lastAction?`${esc(s.lastAction.text)} · ${new Date(s.lastAction.ts).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}`:"None yet"}</div>
<div class="st"><b>Next action</b><br>${s.nextAction?`${esc(s.nextAction.text)} · ${new Date(s.nextAction.ts).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}`:on?"Waiting for market hours or a trigger":"None while paused"}</div>
<div class="st"><b>Buy headroom (24h, all agents)</b><br>$${(+s.remaining24h||0).toFixed(2)} of $500 left · $${(+s.spent24h||0).toFixed(2)} spent</div></div>
<h3>Orders</h3>${(s.intents||[]).length?`<div class="tw"><table><thead><tr><th>Role</th><th>Status</th><th>Next run / limit</th><th>Execs</th><th>Note</th></tr></thead><tbody>${s.intents.map(i=>`<tr><td>${esc(i.role||i.type||"")}${i.rung!=null?" "+esc(i.rung):""}</td><td>${esc(i.status||"")}</td><td>${i.nextRunAt?new Date(i.nextRunAt).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):i.limitPrice!=null?"≤ $"+(+i.limitPrice).toFixed(2):"—"}</td><td>${esc(i.execs??"")}</td><td>${i.lastError?`<span class="err-t">⚠ ${esc(blockedText(i.lastError))}</span>`:""}</td></tr>`).join("")}</tbody></table></div>`:'<p class="muted">No orders yet.</p>'}
<h3>Recent strategy trades ${B}</h3>${(s.fills||[]).length?`<div class="tw"><table><thead><tr><th>Time</th><th>Side</th><th>Token</th><th>Amount</th><th>Status</th><th>Tx</th></tr></thead><tbody>${s.fills.map(f=>`<tr><td>${new Date(f.ts).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</td><td>${esc(f.side||"")}</td><td>${esc(f.symbol||"")}</td><td>$${(+f.amountUsd||0).toFixed(2)}</td><td>${f.status=="blocked"?`✕ ${esc(blockedText(f.lastError||"Blocked by limit"))}`:f.status=="filled"?"✓ Filled":esc(f.status||"")}</td><td>${txLink(f.txHash,f.explorerUrl)}</td></tr>`).join("")}</tbody></table></div>`:'<p class="muted">No strategy trades yet.</p>'}
<label class="row"><input type="checkbox" role="switch" id="s_pz" ${on?"":"checked"} ${["active","paused"].includes(s.status)?"":"disabled"}> Pause strategy <span>(${on?"Running":"Paused"})</span></label>
<p class="muted">Pausing cancels the strategy's open orders onchain and keeps your settings; resuming re-signs them. Each is an onchain action that needs your wallet signature. Revoking the agent key pauses the strategy too.</p>
${ownerSimulated?'<p class="muted"><span class="rchip">Simulated owner wallet</span></p>':""}<button class="danger" id="s_stop">Stop strategy…</button>${SDISC}</section>`}
function statusBind(){const p=$("#s_pz");if(p)p.onchange=()=>{const want=p.checked;p.checked=!want;const id=ST.status.activationId;
 if(want)confirmDlg("Pause strategy?","Pausing cancels the strategy's open orders onchain and keeps your settings. Onchain action; needs your wallet signature.","Sign & pause",async()=>{try{await sapi("pause_strategy",id);ST.status.status="paused";render();say("Strategy paused");loadStrats(true)}catch(e){fail("pause_strategy",e)}});
 else{if(!(S.key&&S.key.status=="active"))return fail("resume_strategy","Create or resume the agent key first (Agent key tab)");confirmDlg("Resume strategy?","Resuming re-signs the strategy's orders from your saved settings. Onchain action; needs your wallet signature.","Sign & resume",async()=>{try{await sapi("resume_strategy",id);ST.status.status="active";render();say("Strategy resumed");loadStrats(true)}catch(e){fail("resume_strategy",e)}})}};
 const st=$("#s_stop");st&&(st.onclick=()=>confirmDlg("Stop strategy?","Stopping cancels all its open orders onchain. You can pick a strategy again later. Needs your wallet signature.","Yes, stop",async()=>{try{await sapi("stop_strategy",ST.status.activationId);ST.status=null;render();say("Strategy stopped");loadStrats(true)}catch(e){fail("stop_strategy",e)}}));
 const r=$("#sRetry");r&&(r.onclick=()=>loadStrats(true))}
// Dashboard tab
function D6(){loadStrats();return dash("strategies",`<h1>Strategies</h1><p>Pick a template, set the rules, and StockClaw runs it within your agent key limits. One strategy at a time.</p>${statusView()}<h2>${ST.status?"Switch strategy":"Pick a strategy"}</h2>${gallery("#/dashboard/strategies")}`)}
function D6bind(){statusBind()}
function D6setup(id){return ()=>{loadStrats();return dash("strategies",SETUP(id,"#/dashboard/strategies","#/dashboard/strategies"))}}
// Onboarding step 6 (optional)
function O6(){loadStrats();return ob(5,`<h1>Pick a strategy (optional)</h1><p>Your agent can trade on request, or you can also run a strategy template within your limits. You can do this later from the dashboard.</p>${ST.status?statusView():""}${gallery("#/onboarding/strategy")}<p><a class="btn sec" href="#/dashboard/overview">Skip for now</a></p>`)}
function O6setup(id){return ()=>{loadStrats();return ob(5,SETUP(id,"#/onboarding/strategy","#/onboarding/strategy"))}}

// ---------- dev error-state panel ----------
const DEV=[["wrongnet","Wrong network (O2)"],["walletfail","Wallet creation fails (O2)"],["ratelimit","Faucet rate limit (O4)"],["oauthdeny","OAuth denied (O5)"],["limitsfail","Limits tx fails (Agent key)"],["service","Service issue banner (dashboard)"]];
const devPanel=()=>`<details class="dev" ${Object.values(S.dev).some(Boolean)?"open":""}><summary>Dev: simulate error states</summary><div class="row">${DEV.map(([k,l])=>`<label style="display:inline"><input type="checkbox" data-dev="${k}" ${S.dev[k]?"checked":""}> ${l}</label>`).join("")}</div></details>`;
// ---------- router ----------
const R={"/":[L1],"/onboarding/eligibility":[O1,O1bind],"/onboarding/wallet":[O2,O2bind],"/onboarding/key":[O3,O3bind],"/onboarding/faucet":[O4,O4bind],"/onboarding/client":[O5,O5bind],
"/dashboard/overview":[D1,D1bind],"/dashboard/orders":[D2,D2bind],"/dashboard/history":[D3],"/dashboard/fees":[D4,D4bind],"/dashboard/key":[D5,D5bind],"/dashboard/strategies":[D6,D6bind],"/onboarding/strategy":[O6,statusBind]};
let lastRoute;function render(){const p=(location.hash.slice(1)||"/").split("?")[0];let m=p.match(/^\/(dashboard\/strategies|onboarding\/strategy)\/([a-z-]+)$/);const [v,b]=m?(m[1][0]=="d"?[D6setup(m[2]),()=>SETUPbind(m[2],"#/dashboard/strategies")]:[O6setup(m[2]),()=>SETUPbind(m[2],"#/dashboard/strategies")]):(R[p]||R["/"]);
 if(p!==lastRoute){if(lastRoute)resetNote=null;draft=null;apiErr=null;S.err=null;if(stage&&(stage.fail||stage.n>3))stage=null}const changed=p!==lastRoute;lastRoute=p;$("#main").innerHTML=(resetNote?`<div class="st wait" role="status">${esc(resetNote)} <button class="sec" id="rnX">Dismiss</button></div>`:"")+(apiErr?`<div class="st err" role="alert" id="apiErr">✕ ${esc(apiErr)} <button class="sec" id="apiErrX">Dismiss</button></div>`:"")+v()+devPanel();const rn=$("#rnX");rn&&(rn.onclick=()=>{resetNote=null;render()});const ax=$("#apiErrX");ax&&(ax.onclick=()=>{apiErr=null;render()});document.querySelectorAll("#main table").forEach(t=>{const h=[...t.querySelectorAll("th")].map(x=>x.textContent);t.querySelectorAll("tbody tr").forEach(r=>[...r.children].forEach((c,i)=>c.dataset.l=h[i]||""))});b&&b();document.querySelectorAll("[data-dev]").forEach(c=>c.onchange=()=>{S.dev[c.dataset.dev]=c.checked;if(c.dataset.dev=="wrongnet")S.switched=false;S.err=null;save();render();say(c.parentNode.textContent.trim()+(c.checked?" on":" off"));document.querySelector(`[data-dev="${c.dataset.dev}"]`).focus()});
 document.querySelectorAll("[data-copy]").forEach(x=>x.onclick=()=>{navigator.clipboard?.writeText(x.dataset.copy).catch(()=>{});say("Copied")});
 const dr=$("#dataRetry");dr&&(dr.onclick=()=>loadDash(true));const t=$("#topRevoke");t&&(t.onclick=()=>confirmDlg("Revoke agent key?","This signs one transaction. You can create a new key later.","Yes, revoke",()=>doRevoke("revoked")));
 document.querySelectorAll('#main a[href^="#"]:not([href^="#/"])').forEach(a=>a.onclick=(e)=>{e.preventDefault();document.getElementById(a.getAttribute("href").slice(1))?.scrollIntoView()});
 if(changed){document.title="StockClaw · "+($("#main h1")?.textContent||"prototype");scrollTo(0,0);$("#main").focus({preventScroll:true})}}
addEventListener("hashchange",render);render();

// ---- Persistent banner (shared bar from index.html; landing reuses the same bar) ----
const BANNER="Local testnet demo: mock tokens, simulated prices, simulated owner wallet";
// ---- Owner token (presenter). sessionStorage only; never localStorage, never logged. ----
function paintBar(){const b=document.querySelector(".tnbar");if(!b)return;let t=b.querySelector(".bn-t");if(!t){b.innerHTML=`<span class="bn-t"></span> <span class="bn-o"></span> <a href="#" id="reset">Reset demo</a>`;t=b.querySelector(".bn-t")}
 t.textContent=BANNER+".";const o=b.querySelector(".bn-o");if(window.USE_MOCK){o.innerHTML="";return}
 o.innerHTML=getTok()?`· Owner token set <button type="button" class="linkbtn" id="forgetTok">Forget token</button>`:`· <button type="button" class="linkbtn" id="setTok">Set owner token</button>`}
document.addEventListener("click",e=>{if(e.target.id=="forgetTok"){forgetTok();say&&say("Owner token forgotten")}else if(e.target.id=="setTok"){askTok()}});
const owned=(fn)=>async(...a)=>{if(!await needOwner())throw new Error("Owner token needed: action cancelled.");
 try{return await fn(...a)}catch(e){if(e&&(e.status==401||e.status==403||/owner token required/i.test(e.message||""))){forgetTok();throw new Error("Owner token missing or wrong. Try the action again and enter the token.")}throw e}};
["submit_attestation","create_smart_account","create_session_key","revoke_session_key","cancel_order"].forEach(n=>{if(api[n])api[n]=owned(api[n])});
["choose_strategy","resume_strategy","pause_strategy","stop_strategy"].forEach(n=>{if(SREST[n])SREST[n]=owned(SREST[n])});
applyTok();

// Confirm screen: every parameter as submitted, plus the server preview's worst case and cap headroom.
const hum=(k)=>String(k).replace(/([A-Z])/g," $1").replace(/^./,c=>c.toUpperCase());
const fmtV=(k,v)=>Array.isArray(v)?v.map(x=>x&&typeof x=="object"?Object.entries(x).map(([a,b])=>/Bps$/.test(a)?`${b/100}%`:`${b}`).join(" "):x).join(", "):v&&typeof v=="object"?Object.entries(v).map(([a,b])=>`${a}: ${b}`).join(", "):/Bps$/.test(k)?`${v} bps (${v/100}%)`:String(v);
function paramTable(d,pv,errs){if(!d)return"";const rows=Object.entries(d).map(([k,v])=>`<tr><th scope="row">${esc(hum(k))} <code>${esc(k)}</code></th><td>${esc(fmtV(k,v))}</td></tr>`).join("");
 const m=(x)=>x==null||errs.length?"—":"$"+(+x).toFixed(2);
 return `<table class="ptab"><caption>Everything you're confirming</caption><tbody>${rows}<tr><th scope="row">Worst case per 24h <code>worstCaseUsdPer24h</code></th><td>${m(pv&&pv.worstCaseUsdPer24h)}</td></tr><tr><th scope="row">Buy headroom (24h) after this strategy <code>capHeadroom</code></th><td>${m(pv&&pv.capHeadroom)}${pv&&+pv.capHeadroom<0&&!errs.length?" (over the shared $500/24h buy cap)":""}</td></tr></tbody></table>`}
