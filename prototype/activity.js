/* StockClaw live activity feed + key breaker banner (dashboard Home).
   Feed: api.getActivity(sinceId) then api.openActivityStream (fetch-SSE in api.js, owner header, resumes from last id).
   Offline/connecting/live indicator. Breaker via api.getBreaker / api.resumeKey. No token handling here.
   Swaps: running -> "Trade in progress"; execute_swap done + result.status "pending" -> "Sent, confirming…" (no retry, no timeout),
   one card per swapId (seeded from GET /api/swaps?status=pending on load), upgraded in place when it settles.
   Mocks: ?mock=1&mockPending=1|fail|rich|richfail, &mockSeed=1. */
(function(){
const MOCK=new URLSearchParams(location.search).get("mock")==="1";
const e=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const F={jobs:new Map(),items:new Map(),lastId:0,stream:null,mode:"",mounted:false,first:true};
const add=list=>{let n=0;for(const x of list||[]){if(x==null||x.id==null||F.items.has(x.id))continue;F.items.set(x.id,x);n++;if(+x.id>+F.lastId)F.lastId=x.id}if(n){foldRows(list);draw()}};
const tm=ts=>{const d=new Date(ts);return isNaN(d)?"":d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})};
const short=h=>h?String(h).slice(0,6)+"…"+String(h).slice(-4):"";
const okUrl=u=>typeof u=="string"&&/^https?:\/\//.test(u);
function row(x){const side=x.side?`<span class="af-side af-${e(x.side)}">${e(x.side)}</span>`:"";const usd=x.usd!=null?`<span class="af-usd">$${(+x.usd).toFixed(2)}</span>`:"";
 const tx=x.txHash?(okUrl(x.explorerUrl)?`<a class="af-tx" href="${e(x.explorerUrl)}" target="_blank" rel="noopener" title="${e(x.txHash)}">${e(short(x.txHash))} ↗</a>`:`<span class="af-tx" title="${e(x.txHash)}">${e(short(x.txHash))}</span>`):"";
 const acts=(x.actions||[]).filter(a=>a&&(a.type=="revoke_key"||a.type=="resume_key")).map(a=>a.type=="revoke_key"?`<button class="af-act af-danger" data-revoke="${e(x.keyId||"")}">${e(a.label||"Revoke key")}</button>`:`<button class="af-act" data-resume="${e(x.keyId||"")}">${e(a.label||"Resume key")}</button>`).join("");
 return `<li class="af-${e(x.kind||"trade")}${F.first?"":" af-new"}"><time class="af-t" datetime="${e(x.ts)}">${tm(x.ts)}</time><span class="af-title">${e(x.title||"")}</span>${side}${usd}${tx}${acts?`<span class="af-acts">${acts}</span>`:""}</li>`}
// Swap cards. execute_swap can finish done + result.status "pending" (TX_PENDING, Lucius aeb1aea): sent, not confirmed. No retry,
// no timeout. One card per swap, deduped by swapId (also jobId, and txHash as a fallback) across: the pending job result, its
// settle event, a duplicate:true result for the same swap, items seeded from GET /api/swaps?status=pending, and the settled
// activity row. The card upgrades in place (pending -> confirmed | failed) and the matching activity row is folded into it.
// symbol/side/amountUsd are optional (new server fields): with them the card reads "Buy $50 AMD", without them it stays generic.
let cardN=0;
const txA=(h,u)=>h?(okUrl(u)?`<a class="af-tx" href="${e(u)}" target="_blank" rel="noopener" title="${e(h)}">${e(short(h))} ↗</a>`:`<span class="af-tx" title="${e(h)}">${e(short(h))}</span>`):"";
const amt=n=>{n=+n;return isFinite(n)?"$"+(n%1?n.toFixed(2):String(n)):""};
const what=c=>{const sd=/^sell$/i.test(c.side||"")?"Sell":/^buy$/i.test(c.side||"")?"Buy":"";const parts=[sd,c.amountUsd!=null?amt(c.amountUsd):"",c.symbol||""].filter(Boolean);return sd&&c.symbol?parts.join(" "):""};
function jobState(j){const r=j.result||{};if(j.status=="done"&&r.status=="pending")return "pending";if(j.status=="done")return "confirmed";if(j.status=="failed")return "failed";return "running"}
const open_=c=>c.st=="pending"||c.st=="confirmed"||c.st=="failed";
const jids=(jobId,jobIds)=>[jobId,...(Array.isArray(jobIds)?jobIds:[])].filter(x=>x!=null).map(String);
function findCard({jobId,jobIds,swapId,tx}){const J=jids(jobId,jobIds);for(const c of F.jobs.values()){if(swapId&&c.swapId==swapId)return c}
 for(const c of F.jobs.values()){if(J.some(x=>c.jobIds.has(x)))return c}
 if(tx)for(const c of F.jobs.values()){if(c.tx&&c.tx==tx)return c}return null}
// a retried job's "in progress" card folds into its swap card once the duplicate result names the swapId
function upsert(ids,patch){let c=findCard(ids);if(!c){c={key:"c"+ ++cardN,jobIds:new Set()};F.jobs.set(c.key,c)}
 for(const jid of jids(ids.jobId,ids.jobIds)){c.jobIds.add(jid);for(const o of F.jobs.values())if(o!==c&&o.jobIds.has(jid)&&o.st=="running")F.jobs.delete(o.key)}for(const [k,v] of Object.entries({swapId:ids.swapId,tx:ids.tx,...patch}))if(v!=null&&v!=="")c[k]=v;return c}
const fields=r=>({url:r.explorerUrl,symbol:r.symbol,side:r.side,amountUsd:r.amountUsd!=null?+r.amountUsd:null});
function cardRow(c){const w=what(c),t=x=>w?`${e(w)} · ${x}`:x;
 if(c.st=="pending")return `<li class="af-job af-pending" data-job="${e(c.key)}" data-swap="${e(c.swapId||"")}"><span class="lv lv-wait"></span><span class="af-title">${t("Sent, confirming…")}</span>${txA(c.tx,c.url)}</li>`;
 if(c.st=="confirmed")return `<li class="af-job af-confirmed" data-job="${e(c.key)}" data-swap="${e(c.swapId||"")}"><span class="lv lv-on"></span><span class="af-title">${t("Confirmed")}</span>${txA(c.tx,c.url)}</li>`;
 if(c.st=="failed"){const i=SCErr.of(c.error||{});return `<li class="af-job af-failed" data-job="${e(c.key)}" data-swap="${e(c.swapId||"")}"><span class="lv lv-off"></span><span class="af-title">${t("Didn't go through.")} ${e(i.message)}</span>${txA(c.tx,c.url)}</li>`}
 return `<li class="af-job" data-job="${e(c.key)}"><span class="lv lv-wait"></span><span class="af-title">${e(/sell/i.test(c.jobKind||"")?"Sell in progress":/buy|swap|trade/i.test(c.jobKind||"")?"Trade in progress":"Working on it")}…</span></li>`}
// queued/running: "in progress"; pending: keep until settled; settled: in place. A swap that confirms without pending (automine) also
// becomes the Confirmed card when the result names its swapId (its activity row folds in); a fast failure or a job without swapId: dropped.
function onJob(j){if(!F.mounted||j==null||j.jobId==null)return;const st=jobState(j),r=(st=="failed"?j.error:j.result)||{},ids={jobId:j.jobId,jobIds:r.jobIds,swapId:r.swapId,tx:r.txHash},prev=findCard(ids),was=prev&&prev.st;
 if(st=="running"){if(!prev||prev.st=="running")upsert(ids,{st,jobKind:j.jobKind})}
 else if(st=="pending"){if(!prev||!/^(confirmed|failed)$/.test(prev.st))upsert(ids,{st,...fields(r)})}
 else if(prev&&prev.st!="running")upsert(ids,st=="failed"?{st,error:j.error,...fields(r)}:{st,...fields(r)}); // a failed settle carries swapId/symbol/side/amountUsd/txHash on error
 else if(prev&&st=="confirmed"&&ids.swapId)upsert(ids,{st,...fields(r)}); // automine: running -> confirmed with no pending step: same one card, Confirmed
 else if(prev)F.jobs.delete(prev.key);
 draw();if(st=="pending"&&was!="pending"&&!/^(confirmed|failed)$/.test(was||""))say("Trade sent, confirming");else if(was=="pending"&&st!="pending"&&st!="running")say(st=="confirmed"?"Trade confirmed":"Trade didn't go through")}
// the settled activity row for a swap we have a card for: upgrade the card, hide the row (one card per swap)
const rowCard=x=>x&&(x.swapId||x.txHash)?[...F.jobs.values()].find(c=>open_(c)&&((x.swapId&&c.swapId==x.swapId)||(!x.swapId&&x.txHash&&c.tx==x.txHash))):null;
function foldRows(list){for(const x of list||[]){const c=rowCard(x);if(c&&c.st=="pending"){c.st="confirmed";if(!c.side&&x.side)c.side=x.side;if(c.amountUsd==null&&x.usd!=null)c.amountUsd=+x.usd;if(!c.url&&x.explorerUrl)c.url=x.explorerUrl;if(!c.tx&&x.txHash)c.tx=x.txHash;say("Trade confirmed")}}}
// seed pending swaps that were already out when the page opened (GET /api/swaps?status=pending, Lucius). 404/any error: silent.
function seedItems(list){for(const x of Array.isArray(list)?list:(list&&(list.swaps||list.items))||[]){if(!x||/^(confirmed|filled|failed)$/.test(x.status||""))continue;
  if([...F.items.values()].some(y=>(x.swapId&&y.swapId==x.swapId)||(x.txHash&&y.txHash==x.txHash)))continue; // already settled into the feed
  const c=findCard({jobId:x.jobId,jobIds:x.jobIds,swapId:x.swapId,tx:x.txHash});if(c&&/^(confirmed|failed)$/.test(c.st))continue;
  upsert({jobId:x.jobId,jobIds:x.jobIds,swapId:x.swapId,tx:x.txHash},{st:"pending",...fields(x)})}draw()}
async function seed(){try{if(MOCK){if(mq.get("mockSeed")=="1")seedItems(mockSeedList())}else if(typeof getTok=="function"&&getTok()&&typeof rest=="function")seedItems(await rest("GET","/swaps?status=pending",null,true))}catch(_){}}
// ---------- mocks: ?mock=1 &mockPending=1 (generic, confirms) | =fail | =rich (enriched + duplicate + settled row) | =richfail (enriched, failed settle) ; &mockSeed=1 ; &mockPendingMs
const mq=new URLSearchParams(location.search),hx=n=>"0x"+n.repeat(12).slice(0,64),mUrl=h=>EXPLORER+"/tx/"+h;
function mockSeedList(){const at=new Date(Date.now()-90e3).toISOString();return [
 {swapId:"sw_seed1",jobId:8001,jobIds:[8001],txHash:hx("5eed1a"),explorerUrl:mUrl(hx("5eed1a")),symbol:"NVDA",side:"buy",amountUsd:40,createdAt:at,status:"pending"},
 {swapId:"sw_seed2",jobId:8002,jobIds:[8002,8003],txHash:hx("5eed2b"),explorerUrl:null,symbol:"PLTR",side:"sell",amountUsd:25.5,createdAt:at,status:"pending"}]}
function mockJobs(){const m=mq.get("mockPending"),seedOn=mq.get("mockSeed")=="1";if(!MOCK||(!m&&!seedOn))return;const ms=+mq.get("mockPendingMs")||8000,at=new Date().toISOString();
 const J=(id,x)=>({jobId:id,kind:"job",jobKind:"trade.execute_swap",createdAt:at,statusUrl:"/api/jobs/"+id,...x});let rowId=500;
 const row=(x)=>add([{id:++rowId,ts:new Date().toISOString(),kind:"trade",keyId:"sk_mock",actions:[{type:"revoke_key",label:"Revoke agent key",method:"POST",href:"/api/revoke_session_key"}],...x}]);
 if(seedOn){const [a,b]=mockSeedList();
  setTimeout(()=>onJob(J(a.jobId,{status:"done",result:{status:"confirmed",txHash:a.txHash,explorerUrl:a.explorerUrl,amountOut:0.21,swapId:a.swapId,symbol:a.symbol,side:a.side,amountUsd:a.amountUsd}})),ms);
  setTimeout(()=>row({title:"Agent sold $25.50 of PLTR",side:"sell",usd:25.5,txHash:b.txHash,explorerUrl:b.explorerUrl,swapId:b.swapId}),ms+700)}
 if(!m)return;const tx=hx("5e7dbe"),url=mUrl(tx),rich=/^rich/.test(m),F2=rich?{symbol:"AMD",side:"buy",amountUsd:50}:{};
 setTimeout(()=>onJob(J(9001,{status:"running"})),300);
 setTimeout(()=>onJob(J(9001,{status:"done",result:{status:"pending",txHash:tx,explorerUrl:url,swapId:"sw_mock1",code:"TX_PENDING",message:"Sent. Waiting for the network to confirm it.",retryable:false,hint:"Don't retry it. It will confirm or fail on its own.",...F2}})),900);
 if(rich){setTimeout(()=>onJob(J(9002,{status:"running"})),1500); // the agent retried: same swap comes back as duplicate:true under a new job
  setTimeout(()=>onJob(J(9002,{status:"done",result:{status:"pending",txHash:tx,explorerUrl:url,swapId:"sw_mock1",code:"TX_PENDING",message:"Already sent.",retryable:false,duplicate:true,...F2}})),1900);
  if(!/fail$/.test(m))setTimeout(()=>row({title:"Agent bought $50.00 of AMD",side:"buy",usd:50,txHash:tx,explorerUrl:url,swapId:"sw_mock1"}),900+ms);}
 // the server settles every job of the swap (jobIds); a failed settle carries swapId/symbol/side/amountUsd/txHash on error
 const jobsOut=rich?[9001,9002]:[9001];
 if(/fail$/.test(m))jobsOut.forEach((id,k)=>setTimeout(()=>onJob(J(id,{status:"failed",error:{error:"Blocked: dropped",code:"TX_REVERTED",message:"The swap reverted onchain. Nothing was spent.",retryable:false,status:409,swapId:"sw_mock1",txHash:tx,explorerUrl:url,...F2}})),900+ms+(rich?400:0)+k*100));
 else setTimeout(()=>onJob(J(9001,{status:"done",result:{status:"confirmed",txHash:tx,explorerUrl:url,amountOut:0.0412,swapId:"sw_mock1",...F2}})),900+ms+(rich?400:0))}
const LIVE={live:["Live","on"],connecting:["Connecting…","wait"],reconnecting:["Reconnecting…","wait"],offline:["Offline. We'll reconnect when you're back online.","off"],error:["Sign in to see live activity.","off"]};
function draw(){const el=document.getElementById("afSlot");if(!el)return;const list=[...F.items.values()].filter(x=>!rowCard(x)).sort((a,b)=>String(b.ts).localeCompare(String(a.ts))||(+b.id-+a.id)).slice(0,25);
 if(F.loading&&!list.length){el.innerHTML=`<ul class="af-list sk-list" aria-hidden="true">${'<li><span class="sk sk-t"></span><span class="sk sk-l"></span></li>'.repeat(3)}</ul>`}
 else{const jb=[...F.jobs.values()].map(cardRow).join("");el.innerHTML=(list.length||jb)?`<ul class="af-list">${jb}${list.map(row).join("")}</ul>`:`<div class="empty"><img src="logo3d/blob-mark-transparent.svg" width="64" height="45" alt="" loading="lazy"><p>${F.mode=="offline"?"Can't reach StockClaw. Activity will show when you're back online.":"No agent trades yet. They'll show up here as they happen."}</p></div>`}
 F.first=false;
 const st=document.getElementById("afLive");if(st){const m=LIVE[F.mode];st.innerHTML=m?`<span class="lv lv-${m[1]}"></span>${m[0]}${F.mode=="error"?' <button class="dx-link" id="afSignin">Enter owner token</button>':""}`:"";const si=document.getElementById("afSignin");si&&(si.onclick=()=>{close();open()})}
 el.querySelectorAll("[data-revoke]").forEach(b=>b.onclick=()=>confirmDlg("Revoke agent key?","Your agent immediately loses the ability to trade. This signs one transaction. You can create a new key later.","Yes, revoke",()=>doRevoke("revoked")));
 el.querySelectorAll("[data-resume]").forEach(b=>b.onclick=()=>resume(b.dataset.resume,b))}
function setMode(m){if(F.mode!==m){F.mode=m;draw()}}
// api.js drives the indicator: connecting | live | reconnecting | error ('error' = owner token missing/rejected; re-opening prompts via the masked hook)
function open(){if(!F.mounted||F.stream)return;if(navigator.onLine===false)return setMode("offline");
 F.stream=api.openActivityStream(ev=>{if(F.mounted)add([ev])},{since:F.lastId||undefined,onJob,onState:(st)=>{if(!F.mounted)return;if(st=="error")F.stream=null;setMode(st)}})}
function close(){F.stream&&F.stream.close();F.stream=null}
addEventListener("offline",()=>{if(F.mounted){close();setMode("offline")}});
addEventListener("online",()=>{if(F.mounted){open();api.getActivity(F.lastId||undefined).then(add,()=>{})}});
async function start(){F.mounted=true;F.loading=true;draw();try{add(await api.getActivity(F.lastId||undefined))}catch(e){if(e&&(e.name=="Unreachable"||e.code=="NETWORK"||/Unreachable|Failed to fetch|NetworkError/i.test(String((e&&e.name)||"")+" "+String((e&&e.message)||e))))setMode("offline")}F.loading=false;draw();open();await seed();mockJobs()}
function stop(){F.mounted=false;close()}
// ---------- breaker ----------
const BR={tripped:[],msg:""};
async function loadBreaker(){try{const r=MOCK&&new URLSearchParams(location.search).get("mockBreaker")==="1"?{tripped:[{keyId:(S.key&&S.key.id)||"sk_mock",reason:"5 trades in 2 minutes (anomaly threshold)",trippedAt:new Date().toISOString()}]}:await api.getBreaker();BR.tripped=r.tripped||[]}catch(_){BR.tripped=[]}drawBreaker()}
const agentName=()=>{const id=ST&&ST.status&&ST.status.id;return ({"steady-stacker":"Steady Stacker","dip-hunter":"Dip Hunter","trend-flip":"Trend Flip","ai-thematic":"AI Thematic","weekend-edge":"Weekend Edge"})[id]||"Your agent"};
function drawBreaker(){const el=document.getElementById("brSlot");if(!el)return;const t=BR.tripped[0];
 el.innerHTML=t?`<div class="br-ban" role="alert"><p><b>${e(agentName())} paused:</b> ${e(t.reason||"unusual activity")}</p><button class="dx-primary" id="brGo" data-key="${e(t.keyId)}">Resume</button>${BR.msg?`<p class="st err">${e(BR.msg)}</p>`:""}</div>`:"";
 const b=document.getElementById("brGo");b&&(b.onclick=()=>resume(b.dataset.key,b));
 // one primary action: while the breaker banner shows, demote Home's other primary button
 document.querySelectorAll(".dx-hero .dx-primary").forEach(x=>x.classList.toggle("dx-demoted",!!t))}
async function refreshBreaker(){await loadBreaker()}
async function resume(keyId,btn){btn&&(btn.disabled=true);try{await api.resumeKey(keyId);BR.tripped=BR.tripped.filter(x=>x.keyId!=keyId);BR.msg="";say("Agent key resumed")}catch(err){const i=SCErr.of(err);SCErr.act(i);BR.msg=i.message+(i.hint?" "+i.hint:"")}drawBreaker();draw()}
// ---------- mount on Home ----------
{const [V,B]=R["/dashboard/overview"];
 R["/dashboard/overview"]=[()=>V().replace('<div class="dx-body">','<div class="dx-body"><div id="brSlot"></div>').replace(/(<section class="dx-sec" aria-labelledby="dx-act"><h2 id="dx-act">Activity<\/h2>)[\s\S]*?(<\/section>)/,'$1<p class="dx-mut dx-small" id="afLive" aria-live="polite"></p><div id="afSlot" aria-live="polite"></div>$2'),
  ()=>{B();draw();drawBreaker();if(!F.mounted)start();loadBreaker()}]}
addEventListener("hashchange",()=>{if(!/^#\/dashboard\/overview/.test(location.hash))stop()});
window.SCActivity={feed:F,breaker:BR,stop,refreshBreaker,onJob,addRows:add};
})();
