/* StockClaw live activity feed + key breaker banner (dashboard Home).
   Feed: api.getActivity(sinceId) then api.openActivityStream (fetch-SSE in api.js, owner header, resumes from last id).
   Offline/connecting/live indicator. Breaker via api.getBreaker / api.resumeKey. No token handling here. */
(function(){
const MOCK=new URLSearchParams(location.search).get("mock")==="1";
const e=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const F={jobs:new Map(),items:new Map(),lastId:0,stream:null,mode:"",mounted:false,first:true};
const add=list=>{let n=0;for(const x of list||[]){if(x==null||x.id==null||F.items.has(x.id))continue;F.items.set(x.id,x);n++;if(+x.id>+F.lastId)F.lastId=x.id}if(n)draw()};
const tm=ts=>{const d=new Date(ts);return isNaN(d)?"":d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})};
const short=h=>h?String(h).slice(0,6)+"…"+String(h).slice(-4):"";
const okUrl=u=>typeof u=="string"&&/^https?:\/\//.test(u);
function row(x){const side=x.side?`<span class="af-side af-${e(x.side)}">${e(x.side)}</span>`:"";const usd=x.usd!=null?`<span class="af-usd">$${(+x.usd).toFixed(2)}</span>`:"";
 const tx=x.txHash?(okUrl(x.explorerUrl)?`<a class="af-tx" href="${e(x.explorerUrl)}" target="_blank" rel="noopener" title="${e(x.txHash)}">${e(short(x.txHash))} ↗</a>`:`<span class="af-tx" title="${e(x.txHash)}">${e(short(x.txHash))}</span>`):"";
 const acts=(x.actions||[]).filter(a=>a&&(a.type=="revoke_key"||a.type=="resume_key")).map(a=>a.type=="revoke_key"?`<button class="af-act af-danger" data-revoke="${e(x.keyId||"")}">${e(a.label||"Revoke key")}</button>`:`<button class="af-act" data-resume="${e(x.keyId||"")}">${e(a.label||"Resume key")}</button>`).join("");
 return `<li class="af-${e(x.kind||"trade")}${F.first?"":" af-new"}"><time class="af-t" datetime="${e(x.ts)}">${tm(x.ts)}</time><span class="af-title">${e(x.title||"")}</span>${side}${usd}${tx}${acts?`<span class="af-acts">${acts}</span>`:""}</li>`}
const LIVE={live:["Live","on"],connecting:["Connecting…","wait"],reconnecting:["Reconnecting…","wait"],offline:["Offline. We'll reconnect when you're back online.","off"],error:["Sign in to see live activity.","off"]};
function draw(){const el=document.getElementById("afSlot");if(!el)return;const list=[...F.items.values()].sort((a,b)=>String(b.ts).localeCompare(String(a.ts))||(+b.id-+a.id)).slice(0,25);
 if(F.loading&&!list.length){el.innerHTML=`<ul class="af-list sk-list" aria-hidden="true">${'<li><span class="sk sk-t"></span><span class="sk sk-l"></span></li>'.repeat(3)}</ul>`}
 else{const jb=[...F.jobs.values()].map(j=>`<li class="af-job"><span class="lv lv-wait"></span><span class="af-title">${e(/sell/i.test(j.jobKind||"")?"Sell in progress":/buy|swap|trade/i.test(j.jobKind||"")?"Trade in progress":"Working on it")}…</span></li>`).join("");el.innerHTML=(list.length||jb)?`<ul class="af-list">${jb}${list.map(row).join("")}</ul>`:`<div class="empty"><img src="logo3d/blob-3d-eyeless-256.webp" width="64" height="45" alt="" loading="lazy"><p>No agent trades yet. They'll show up here as they happen.</p></div>`}
 F.first=false;
 const st=document.getElementById("afLive");if(st){const m=LIVE[F.mode];st.innerHTML=m?`<span class="lv lv-${m[1]}"></span>${m[0]}${F.mode=="error"?' <button class="dx-link" id="afSignin">Enter owner token</button>':""}`:"";const si=document.getElementById("afSignin");si&&(si.onclick=()=>{close();open()})}
 el.querySelectorAll("[data-revoke]").forEach(b=>b.onclick=()=>confirmDlg("Revoke agent key?","Your agent immediately loses the ability to trade. This signs one transaction. You can create a new key later.","Yes, revoke",()=>doRevoke("revoked")));
 el.querySelectorAll("[data-resume]").forEach(b=>b.onclick=()=>resume(b.dataset.resume,b))}
function setMode(m){if(F.mode!==m){F.mode=m;draw()}}
// api.js drives the indicator: connecting | live | reconnecting | error ('error' = owner token missing/rejected; re-opening prompts via the masked hook)
function open(){if(!F.mounted||F.stream)return;if(navigator.onLine===false)return setMode("offline");
 F.stream=api.openActivityStream(ev=>{if(F.mounted)add([ev])},{since:F.lastId||undefined,onJob:j=>{if(!F.mounted||j.jobId==null)return;if(j.status=="queued"||j.status=="running")F.jobs.set(j.jobId,j);else F.jobs.delete(j.jobId);draw()},onState:(st)=>{if(!F.mounted)return;if(st=="error")F.stream=null;setMode(st)}})}
function close(){F.stream&&F.stream.close();F.stream=null}
addEventListener("offline",()=>{if(F.mounted){close();setMode("offline")}});
addEventListener("online",()=>{if(F.mounted){open();api.getActivity(F.lastId||undefined).then(add,()=>{})}});
async function start(){F.mounted=true;F.loading=true;draw();try{add(await api.getActivity(F.lastId||undefined))}catch(_){}F.loading=false;draw();open()}
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
window.SCActivity={feed:F,breaker:BR,stop,refreshBreaker};
})();
