/* StockClaw approve-sell (agent sells over $500 in 24h need the owner's approval). Per-sell approvals, 1h expiry, passkey-signed.
   API (owner token only, via api.js once Lucius's mock lands):
     GET  /api/approvals?status=pending -> [{id, agentKeyId, agentName, ticker, amountIn, estUsdgOut, estUsdgOutMin, reason, status, createdAt, expiresAt, challenge?}]
     POST /api/approvals/:id/approve {webauthnAssertion}   (server re-quotes; >3% move -> 'Price moved, ask agent to re-propose')
     POST /api/approvals/:id/reject
   APRAdapter is the ONE place that talks to api.js (Lucius 502b3f4; ?mock=1 / ?mockFail=1 use its mocks).
   Never log the assertion or the owner token. */
(function(){
const q=new URLSearchParams(location.search),MOCK=q.get("mock")==="1";
const STUB=MOCK; // headless screenshots only: stub navigator.credentials in ?mock=1
const e=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const b64u=buf=>btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const fromB64u=s=>Uint8Array.from(atob(String(s).replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));

// ---------- the ONE adapter ----------
const APRAdapter={
 list:()=>api.list_approvals("pending"),
 approve:(id,webauthnAssertion)=>api.approve_sell(id,webauthnAssertion,"approve:"+id), // same key on every retry of this approval
 reject:id=>api.reject_sell(id),
 pkOptions:assertion=>api.passkey_register_options(assertion),
 pkVerify:response=>api.passkey_register_verify(response),
 challenge:a=>a.challenge,
 // Contract errors -> friendly copy. kind: 'invalid' (muted), 'done' (resolve as approved), 'moved' (server text), 'error'.
 // Server error contract via SCErr. kind: 'invalid' (muted, retire), 'done' (resolve as approved), 'moved', 'error' (stay pending; Retry only if retryable).
 friendly(err){const i=SCErr.of(err);SCErr.act(i);const msg=i.message+(i.hint?" "+i.hint:"");
  if(err&&err.name==="NotAllowedError")return {kind:"error",msg:"Passkey check was cancelled. Try again when you're ready.",retry:true};
  if(i.code=="PRICE_MOVED")return {kind:"moved",msg};
  if(/^(EXPIRED|NOT_FOUND|PER_TRADE_CAP|CONFLICT|KEY_INACTIVE|TOKEN_NOT_ALLOWED|TRANSFER_BLOCKED)$/.test(i.code))return {kind:"invalid",msg};
  return {kind:"error",msg:msg+(SCErr.extra[i.code]?" "+SCErr.extra[i.code]:""),retry:i.retryable}},
 // logic keys off reasonCode; reasonText is the server's display copy
 reasonCode:a=>a.reasonCode||"",
 reasonText:a=>a.reasonText||(a.reasonCode==="SELL_CAP_EXCEEDED"?"Over the $500 agent sell limit, needs your approval":"Needs your approval"), // supplied by the server/mock (approval id + params hash); we don't invent crypto
 // Card copy and actions live here (per-sell is final).
 copy:{title:a=>`${a.agentName||a.keyLabel||"Your agent"} wants to sell ${a.amountIn} ${a.ticker} for ~$${(+a.estUsdgOut).toFixed(2)} mUSDG`,primary:"Approve sell",secondary:"Decline",
  note:"",expired:"Approval expired or invalid. Ask your agent to re-propose.",declined:"Declined. Your agent won't sell this.",approved:"Approved. The sell is going through."}};

// ---------- passkey ----------
const pk=()=>S.passkey||null;
const toBuf=s=>fromB64u(s).buffer;
async function createPasskey(){
 // A 2nd passkey: the server answers 403 + stepUpChallenge; sign it with the existing passkey and ask for options again.
 let o;try{o=await APRAdapter.pkOptions()}catch(err){if(!(err&&err.stepUpChallenge&&(err.code=="STEP_UP_REQUIRED"||err.status===403)))throw err;pkStepUp=true;
  if(STUB)o=await APRAdapter.pkOptions({stub:true});else o=await APRAdapter.pkOptions(await assert(err.stepUpChallenge))}
 if(STUB){await new Promise(r=>setTimeout(r,300));const v=await APRAdapter.pkVerify({id:"stub",stub:true});return {id:v.credentialId||"stub",stub:true}}
 const pubKey={...o,challenge:toBuf(o.challenge),user:{...o.user,id:toBuf(o.user.id)},excludeCredentials:(o.excludeCredentials||[]).map(c=>({...c,id:toBuf(c.id)})),
  authenticatorSelection:{...(o.authenticatorSelection||{}),userVerification:"required"}};
 const c=await navigator.credentials.create({publicKey:pubKey});
 const resp={id:c.id,rawId:b64u(c.rawId),type:c.type,response:{clientDataJSON:b64u(c.response.clientDataJSON),attestationObject:b64u(c.response.attestationObject),transports:c.response.getTransports?c.response.getTransports():[]},clientExtensionResults:c.getClientExtensionResults()};
 const v=await APRAdapter.pkVerify(resp);if(!v||v.verified===false)throw new Error("The server couldn't verify the passkey");return {id:v.credentialId||c.id}}
async function assert(challenge){const as=await navigator.credentials.get({publicKey:{challenge:toBuf(challenge),allowCredentials:pk()&&!pk().stub?[{type:"public-key",id:toBuf(pk().id)}]:[],userVerification:"required",timeout:60000}});
 return {id:as.id,rawId:b64u(as.rawId),type:as.type,response:{clientDataJSON:b64u(as.response.clientDataJSON),authenticatorData:b64u(as.response.authenticatorData),signature:b64u(as.response.signature),userHandle:as.response.userHandle?b64u(as.response.userHandle):null}}}
async function signApproval(a){if(STUB){await new Promise(r=>setTimeout(r,300));return {stub:true}}return assert(APRAdapter.challenge(a))}

// ---------- onboarding step: Set up passkey ----------
let pkBusy=false,pkErr="",pkStepUp=false;
function PK(){const has=pk();return SCdx.obx(2,`<h1>${has?"Passkey ready":"Set up a passkey"}</h1>
<p class="dx-lede">If an agent wants to sell more than $500 in 24h, you approve it with this passkey: Face ID, Touch ID or your device PIN.</p>
${has?`<p class="dx-mut">✓ Passkey saved on this device.</p><a class="dx-primary" href="#/onboarding/client">Continue</a>`:
`<button class="dx-primary" id="pkGo" ${pkBusy?"disabled":""}>${pkBusy?"Waiting for your device…":"Set up passkey"}</button> <a class="dx-link" href="#/onboarding/client" id="pkSkip">Skip for now</a>
<p class="dx-mut dx-small">Skipping is fine, but you'll need a passkey to approve large agent sells.</p>`}
<p class="st err" role="alert" ${pkErr?"":"hidden"}>${e(pkErr)}</p><p class="dx-mut dx-small">${e(APRAdapter.copy.note)}</p>`)}
function PKbind(){const b=document.getElementById("pkGo");b&&(b.onclick=async()=>{pkBusy=true;pkErr="";pkStepUp=false;render();try{S.passkey=await createPasskey();save();say("Passkey saved")}catch(err){pkErr=err&&err.name=="NotAllowedError"?(pkStepUp?"Adding a new passkey needs the one you set up before. Use that device, then try again.":"Passkey setup was cancelled. Try again when you're ready."):SCErr.of(err).message}pkBusy=false;render();document.querySelector(".dx-primary")?.focus()})}
R["/onboarding/passkey"]=[PK,PKbind];
{const p=(location.hash.slice(1)||"/").split("?")[0];if(p==="/onboarding/passkey"){document.body.classList.remove("is-landing");document.body.classList.add("sc-app");render()}}

// ---------- dashboard cards ----------
const ui={items:[],st:{},timer:null};
const left=a=>Math.max(0,Date.parse(a.expiresAt)-Date.now());
const fmtLeft=ms=>{const m=Math.floor(ms/60e3),s=Math.floor(ms%60e3/1e3);return m>=1?`${m}m left`:`${s}s left`};
function card(a,i,active){const s=ui.st[a.id]||{k:left(a)?"pending":"expired"};const C=APRAdapter.copy;
 if(!active&&(s.k=="pending"||s.k=="nopk"))return `<li class="apr apr-q" data-id="${e(a.id)}"><p class="apr-qt">${e(C.title(a))}</p><p class="apr-r">Queued, next up after this one · <span class="apr-cd" data-cd="${e(a.id)}">${fmtLeft(left(a))}</span></p></li>`;
 const muted=s.k=="expired"||s.k=="moved"||s.k=="declined";
 const body=s.k=="approved"?`<p class="apr-ok"><span aria-hidden="true">✓</span> ${e(s.msg||C.approved)}</p>`:
  s.k=="expired"?`<p class="apr-msg">${e(s.msg||C.expired)}</p>`:s.k=="moved"?`<p class="apr-msg">${e(s.msg)}</p>`:s.k=="declined"?`<p class="apr-msg">${e(C.declined)}</p>`:
  s.k=="nopk"?`<p class="apr-msg">You need a passkey to approve sells.</p><a class="dx-primary" href="#/onboarding/passkey">Set up passkey</a>`:
  `<div class="apr-act"><button class="dx-primary" data-ap="${e(a.id)}" ${s.k=="approving"||s.nr?"disabled":""}>${s.k=="approving"?"Approving…":e(C.primary)}</button> <button class="dx-link" data-dc="${e(a.id)}" ${s.k=="approving"?"disabled":""}>${e(C.secondary)}</button></div>${s.msg?`<p class="st err" role="alert">${e(s.msg)}</p>`:""}`;
 return `<li class="apr apr-${s.k}${muted?" apr-muted":""}" data-id="${e(a.id)}"><p class="apr-t">${e(C.title(a))}</p>${a.keyLabel&&a.agentName&&a.keyLabel!=a.agentName?`<p class="apr-k">${e(a.keyLabel)}</p>`:""}<p class="apr-r">${e(APRAdapter.reasonText(a))}${s.k=="pending"||s.k=="approving"||s.k=="nopk"?` · <span class="apr-cd" data-cd="${e(a.id)}">${fmtLeft(left(a))}</span>`:""}</p>${body}${a.ownerSignatureSimulated&&C.note?`<p class="apr-n">${e(C.note)}</p>`:""}</li>`}
function draw(){const el=document.getElementById("aprSlot");if(!el)return;const list=ui.items.slice().sort((x,y)=>Date.parse(x.createdAt)-Date.parse(y.createdAt));
 const unres=x=>{const k=(ui.st[x.id]||{k:"pending"}).k;return k=="pending"||k=="approving"||k=="nopk"};const act=(list.find(x=>unres(x)&&left(x))||{}).id;
 if(!list.length){el.innerHTML="";return}const vis=list.slice(0,3),more=list.length-vis.length;
 el.innerHTML=`<section class="apr-wrap" aria-labelledby="aprH"><h2 id="aprH" class="sr-only">Sell approvals</h2><ul class="apr-list">${vis.map((x,i)=>card(x,i,x.id==act)).join("")}</ul>${more>0?`<p class="dx-mut dx-small apr-more">+${more} more waiting</p>`:""}</section>`;
 el.querySelectorAll("[data-ap]").forEach(b=>b.onclick=()=>approve(b.dataset.ap));el.querySelectorAll("[data-dc]").forEach(b=>b.onclick=()=>decline(b.dataset.dc))}
function set(id,k,msg,focus){ui.st[id]={k,msg};draw();const a=ui.items.find(x=>x.id==id);say(k=="approved"?"Sell approved":k=="declined"?"Sell declined":k=="expired"?"Approval expired":k=="moved"?msg:k=="approving"?"Approving sell":"");
 if(focus){const li=document.querySelector(`.apr[data-id="${CSS.escape(id)}"]`);(li?.querySelector("button,a")||document.querySelector(".apr-list button"))?.focus()}}
async function approve(id){const a=ui.items.find(x=>x.id==id);if(!a)return;if(!left(a))return set(id,"expired");if(!pk())return set(id,"nopk",null,true);
 set(id,"approving");let as;try{as=await signApproval(a)}catch(err){return set(id,"pending",err&&err.name=="NotAllowedError"?"Passkey check was cancelled. Try again when you're ready.":"Passkey check failed. Try again.",true)}
 try{await APRAdapter.approve(id,as);as=null;set(id,"approved",null,false);retire(id)}
 catch(err){as=null;const f=APRAdapter.friendly(err);if(f.kind=="done"){ui.st[id]={k:"approved",msg:f.msg};draw();retire(id)}else if(f.kind=="moved"){set(id,"moved",f.msg,true);retire(id,4000)}else if(f.kind=="invalid"){set(id,"expired",f.msg,true);retire(id,4000)}else{set(id,"pending",f.msg,true);if(!f.retry){ui.st[id].nr=true;draw()}}}}
function retire(id,ms=1800){if(q.get("aprHold")==="1")return;setTimeout(()=>{const li=document.querySelector(`.apr[data-id="${CSS.escape(id)}"]`);li&&li.classList.add("apr-fade");setTimeout(()=>{ui.items=ui.items.filter(x=>x.id!=id);draw();document.querySelector(".apr-list .dx-primary")?.focus()},400)},ms)}
async function decline(id){try{await APRAdapter.reject(id);set(id,"declined",null,true);retire(id,1500)}catch(err){set(id,"pending","Couldn't decline right now. Try again in a moment.",true)}}
function tickCd(){document.querySelectorAll("[data-cd]").forEach(s=>{const a=ui.items.find(x=>x.id==s.dataset.cd);if(!a)return;const l=left(a);if(!l&&(!ui.st[a.id]||ui.st[a.id].k=="pending")){set(a.id,"expired");retire(a.id,4000)}else s.textContent=fmtLeft(l)})}
async function mount(){clearInterval(ui.timer);try{const got=await APRAdapter.list();const keep=ui.items.filter(x=>ui.st[x.id]&&ui.st[x.id].k!="pending");ui.items=[...got.filter(g=>!keep.some(k=>k.id==g.id)),...keep]}catch(_){}
 draw();ui.timer=setInterval(()=>{if(!document.getElementById("aprSlot"))return clearInterval(ui.timer);tickCd()},1000)}
{const [V,B]=R["/dashboard/overview"];R["/dashboard/overview"]=[()=>V().replace('<div class="dx-body">','<div class="dx-body"><div id="aprSlot" aria-live="polite"></div>'),()=>{B();mount()}]}
window.SCApprovals={adapter:APRAdapter,refresh:()=>{if(document.getElementById("aprSlot"))mount()}};
})();
