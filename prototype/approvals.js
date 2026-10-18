/* StockClaw approve-sell (agent sells over $500 in 24h need the owner's approval). Per-sell approvals, 1h expiry, passkey-signed.
   API (owner token only, via api.js once Lucius's mock lands):
     GET  /api/approvals?status=pending -> [{id, agentKeyId, agentName, ticker, amountIn, estUsdgOut, estUsdgOutMin, reason, status, createdAt, expiresAt, challenge?}]
     POST /api/approvals/:id/approve {webauthnAssertion}   (server re-quotes; >3% move -> 'Price moved, ask agent to re-propose')
     POST /api/approvals/:id/reject
   APRAdapter is the ONE place to wire api.js. Until then a local simulator (APRSim) runs only with ?mock=1. Delete APRSim when api.js ships.
   Never log the assertion or the owner token. */
(function(){
const q=new URLSearchParams(location.search),MOCK=q.get("mock")==="1";
const STUB=MOCK; // headless/demo: stub navigator.credentials in mock mode only
const e=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const b64u=buf=>btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const fromB64u=s=>Uint8Array.from(atob(String(s).replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));

// ---------- local simulator (remove when api.js has list_approvals / approve_sell / reject_sell) ----------
const APRSim={items:null,
 seed(){const now=Date.now(),m=60e3;const mk=(id,agentName,ticker,amountIn,est,age,exp,reason,flags={})=>({id,agentKeyId:"key-sim",agentName,ticker,amountIn,estUsdgOut:est,estUsdgOutMin:+(est*0.99).toFixed(2),reason,status:"pending",createdAt:new Date(now-age*m).toISOString(),expiresAt:new Date(now+exp).toISOString(),challenge:"sim:"+id+":paramsHash",...flags});
  this.items=[mk("ap-1","Dip Hunter","TSLA",0.42,98.4,1,52*m,"Over $500 of agent sells in 24h ($540 so far)."),
   mk("ap-2","Trend Flip","PLTR",0.6,61.2,4,38*m,"EMA crossed back below VWAP; over the 24h agent-sell limit.",{_move:true}),
   mk("ap-3","Steady Stacker","NFLX",0.09,88.1,58,q.get("aprExpire")==="1"?4000:9*m,"Rebalance sell; over the 24h agent-sell limit."),
   mk("ap-4","Dip Hunter","AMD",0.3,47.1,70,-1,"Older request."),mk("ap-5","AI Thematic","AMZN",0.2,40.5,80,-1,"Older request.")];this.items.slice(3).forEach(x=>x.expiresAt=new Date(now+20*m).toISOString())},
 list(){if(!this.items)this.seed();return Promise.resolve(this.items.filter(x=>x.status=="pending"&&Date.parse(x.expiresAt)>Date.now()).map(x=>({...x})))},
 approve(id){const x=this.items.find(x=>x.id==id);return new Promise((ok,no)=>setTimeout(()=>{if(!x||Date.parse(x.expiresAt)<=Date.now())return no(Object.assign(new Error("This approval expired. Ask your agent to re-propose."),{code:"expired"}));
  if(x._move){x.status="failed";return no(Object.assign(new Error("Price moved, ask agent to re-propose"),{code:"price_moved"}))}x.status="approved";ok({status:"approved"})},700))},
 reject(id){const x=this.items.find(x=>x.id==id);if(x)x.status="rejected";return Promise.resolve({status:"rejected"})}};

// ---------- the ONE adapter ----------
const A=window.api||{};const live=()=>typeof A.list_approvals=="function";
const APRAdapter={
 list:()=>live()?A.list_approvals("pending"):MOCK?APRSim.list():Promise.resolve([]),
 approve:(id,webauthnAssertion)=>live()?A.approve_sell(id,{webauthnAssertion}):APRSim.approve(id),
 reject:id=>live()?A.reject_sell(id):APRSim.reject(id),
 challenge:a=>a.challenge, // supplied by the server/mock (approval id + params hash); we don't invent crypto
 // Card copy and actions live here (per-sell is final).
 copy:{title:a=>`${a.agentName} wants to sell ${a.amountIn} ${a.ticker} for ~$${(+a.estUsdgOut).toFixed(2)} mUSDG`,primary:"Approve sell",secondary:"Decline",
  note:"Simulated owner signature (demo)",expired:"Expired. Ask your agent to re-propose.",declined:"Declined. Your agent won't sell this.",approved:"Approved. The sell is going through."}};

// ---------- passkey ----------
const pk=()=>S.passkey||null;
async function createPasskey(){if(STUB&&(!window.PublicKeyCredential||q.get("stubpk")!=="0")){await new Promise(r=>setTimeout(r,400));return {id:"stub-"+Date.now().toString(36),stub:true}}
 const cred=await navigator.credentials.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rp:{name:"StockClaw",id:location.hostname},
  user:{id:crypto.getRandomValues(new Uint8Array(16)),name:"owner@stockclaw.local",displayName:"StockClaw owner"},pubKeyCredParams:[{type:"public-key",alg:-7},{type:"public-key",alg:-257}],
  authenticatorSelection:{residentKey:"preferred",userVerification:"required"},timeout:60000,attestation:"none"}});return {id:b64u(cred.rawId)}}
async function signApproval(a){const ch=APRAdapter.challenge(a);if(STUB&&(pk()?.stub||q.get("stubpk")!=="0")){await new Promise(r=>setTimeout(r,300));return {stub:true,id:pk()?.id}}
 const enc=new TextEncoder().encode(String(ch));const as=await navigator.credentials.get({publicKey:{challenge:enc,allowCredentials:[{type:"public-key",id:fromB64u(pk().id)}],userVerification:"required",timeout:60000}});
 return {id:b64u(as.rawId),clientDataJSON:b64u(as.response.clientDataJSON),authenticatorData:b64u(as.response.authenticatorData),signature:b64u(as.response.signature)}}

// ---------- onboarding step: Set up passkey ----------
let pkBusy=false,pkErr="";
function PK(){const has=pk();return SCdx.obx(2,`<h1>${has?"Passkey ready":"Set up a passkey"}</h1>
<p class="dx-lede">If an agent wants to sell more than $500 in 24h, you approve it with this passkey: Face ID, Touch ID or your device PIN.</p>
${has?`<p class="dx-mut">✓ Passkey saved on this device.</p><a class="dx-primary" href="#/onboarding/client">Continue</a>`:
`<button class="dx-primary" id="pkGo" ${pkBusy?"disabled":""}>${pkBusy?"Waiting for your device…":"Set up passkey"}</button> <a class="dx-link" href="#/onboarding/client" id="pkSkip">Skip for now</a>
<p class="dx-mut dx-small">Skipping is fine, but you'll need a passkey to approve large agent sells.</p>`}
<p class="st err" role="alert" ${pkErr?"":"hidden"}>${e(pkErr)}</p><p class="dx-mut dx-small">${e(APRAdapter.copy.note)}</p>`)}
function PKbind(){const b=document.getElementById("pkGo");b&&(b.onclick=async()=>{pkBusy=true;pkErr="";render();try{S.passkey=await createPasskey();save();say("Passkey saved")}catch(err){pkErr=err&&err.name=="NotAllowedError"?"Passkey setup was cancelled.":"Couldn't set up a passkey: "+(err.message||err)}pkBusy=false;render();document.querySelector(".dx-primary")?.focus()})}
R["/onboarding/passkey"]=[PK,PKbind];
{const p=(location.hash.slice(1)||"/").split("?")[0];if(p==="/onboarding/passkey"){document.body.classList.remove("is-landing");document.body.classList.add("sc-app");render()}}

// ---------- dashboard cards ----------
const ui={items:[],st:{},timer:null};
const left=a=>Math.max(0,Date.parse(a.expiresAt)-Date.now());
const fmtLeft=ms=>{const m=Math.floor(ms/60e3),s=Math.floor(ms%60e3/1e3);return m>=1?`${m}m left`:`${s}s left`};
function card(a,i){const s=ui.st[a.id]||{k:left(a)?"pending":"expired"};const C=APRAdapter.copy;
 const muted=s.k=="expired"||s.k=="moved"||s.k=="declined";
 const body=s.k=="approved"?`<p class="apr-ok"><span aria-hidden="true">✓</span> ${e(C.approved)}</p>`:
  s.k=="expired"?`<p class="apr-msg">${e(C.expired)}</p>`:s.k=="moved"?`<p class="apr-msg">${e(s.msg)}</p>`:s.k=="declined"?`<p class="apr-msg">${e(C.declined)}</p>`:
  s.k=="nopk"?`<p class="apr-msg">You need a passkey to approve sells.</p><a class="dx-primary" href="#/onboarding/passkey">Set up passkey</a>`:
  `<div class="apr-act"><button class="${i?"apr-btn2":"dx-primary"}" data-ap="${e(a.id)}" ${s.k=="approving"?"disabled":""}>${s.k=="approving"?"Approving…":e(C.primary)}</button> <button class="dx-link" data-dc="${e(a.id)}" ${s.k=="approving"?"disabled":""}>${e(C.secondary)}</button></div>${s.msg?`<p class="st err" role="alert">${e(s.msg)}</p>`:""}`;
 return `<li class="apr apr-${s.k}${muted?" apr-muted":""}" data-id="${e(a.id)}"><p class="apr-t">${e(C.title(a))}</p><p class="apr-r">${e(a.reason||"")}${s.k=="pending"||s.k=="approving"||s.k=="nopk"?` · <span class="apr-cd" data-cd="${e(a.id)}">${fmtLeft(left(a))}</span>`:""}</p>${body}<p class="apr-n">${e(C.note)}</p></li>`}
function draw(){const el=document.getElementById("aprSlot");if(!el)return;const list=ui.items.slice().sort((x,y)=>Date.parse(y.createdAt)-Date.parse(x.createdAt));
 if(!list.length){el.innerHTML="";return}const vis=list.slice(0,3),more=list.length-vis.length;
 el.innerHTML=`<section class="apr-wrap" aria-labelledby="aprH"><h2 id="aprH" class="sr-only">Sell approvals</h2><ul class="apr-list">${vis.map((x,i)=>card(x,i)).join("")}</ul>${more>0?`<p class="dx-mut dx-small apr-more">+${more} more waiting</p>`:""}</section>`;
 el.querySelectorAll("[data-ap]").forEach(b=>b.onclick=()=>approve(b.dataset.ap));el.querySelectorAll("[data-dc]").forEach(b=>b.onclick=()=>decline(b.dataset.dc))}
function set(id,k,msg,focus){ui.st[id]={k,msg};draw();const a=ui.items.find(x=>x.id==id);say(k=="approved"?"Sell approved":k=="declined"?"Sell declined":k=="expired"?"Approval expired":k=="moved"?msg:k=="approving"?"Approving sell":"");
 if(focus){const li=document.querySelector(`.apr[data-id="${CSS.escape(id)}"]`);(li?.querySelector("button,a")||document.querySelector(".apr-list button"))?.focus()}}
async function approve(id){const a=ui.items.find(x=>x.id==id);if(!a)return;if(!left(a))return set(id,"expired");if(!pk())return set(id,"nopk",null,true);
 set(id,"approving");let as;try{as=await signApproval(a)}catch(err){return set(id,"pending",err&&err.name=="NotAllowedError"?"Passkey check was cancelled.":"Passkey check failed.",true)}
 try{await APRAdapter.approve(id,as);as=null;set(id,"approved",null,false);setTimeout(()=>{const li=document.querySelector(`.apr[data-id="${CSS.escape(id)}"]`);li&&li.classList.add("apr-fade");setTimeout(()=>{ui.items=ui.items.filter(x=>x.id!=id);draw();if(typeof loadDash=="function")try{loadDash()}catch(_){}},400)},q.get("aprHold")==="1"?6e4:1800)}
 catch(err){as=null;const m=String(err&&err.message||err);if(/price moved/i.test(m)||err.code=="price_moved")set(id,"moved",m,true);else if(/expired/i.test(m)||err.code=="expired")set(id,"expired",null,true);else set(id,"pending","Couldn't approve: "+m,true)}}
async function decline(id){try{await APRAdapter.reject(id);set(id,"declined",null,true)}catch(err){set(id,"pending","Couldn't decline: "+(err.message||err),true)}}
function tickCd(){document.querySelectorAll("[data-cd]").forEach(s=>{const a=ui.items.find(x=>x.id==s.dataset.cd);if(!a)return;const l=left(a);if(!l&&(!ui.st[a.id]||ui.st[a.id].k=="pending"))set(a.id,"expired");else s.textContent=fmtLeft(l)})}
async function mount(){clearInterval(ui.timer);try{const got=await APRAdapter.list();const keep=ui.items.filter(x=>ui.st[x.id]&&ui.st[x.id].k!="pending");ui.items=[...got.filter(g=>!keep.some(k=>k.id==g.id)),...keep]}catch(_){}
 draw();ui.timer=setInterval(()=>{if(!document.getElementById("aprSlot"))return clearInterval(ui.timer);tickCd()},1000)}
{const [V,B]=R["/dashboard/overview"];R["/dashboard/overview"]=[()=>V().replace('<div class="dx-body">','<div class="dx-body"><div id="aprSlot" aria-live="polite"></div>'),()=>{B();mount()}]}
window.SCApprovals={adapter:APRAdapter,_sim:APRSim};
})();
