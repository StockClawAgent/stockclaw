/* StockClaw live activity feed + key breaker banner (dashboard Home). Lucius 502b3f4.
   Feed: api.get_activity(since) then live updates from GET /api/activity/stream (SSE). The stream is owner-only (Bearer header) and
   EventSource can't send headers, so we read the SSE stream with fetch() + Authorization header (token never goes in the URL).
   Reconnect with backoff (1s..30s); after 3 failures fall back to polling every 5s. One timer at a time; stops when Home unmounts.
   Breaker: GET /api/keys/breaker (no api.js wrapper yet -> ownerGet below), resume via api.resume_key. Never log the token. */
(function(){
const MOCK=new URLSearchParams(location.search).get("mock")==="1";
const e=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const tok=()=>{try{return sessionStorage.getItem("stockclaw-owner-token")||""}catch(_){return ""}};
const ownerGet=async p=>{const r=await fetch("/api/"+p,{headers:{authorization:"Bearer "+tok(),"x-owner-token":tok()}});const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j.error||"HTTP "+r.status),{status:r.status});return j};
const F={items:new Map(),lastId:0,lastTs:"",ctl:null,timer:null,fails:0,mode:"",mounted:false};
const add=list=>{let n=0;for(const x of list||[]){if(x==null||F.items.has(x.id))continue;F.items.set(x.id,x);n++;if(typeof x.id=="number"&&x.id>F.lastId)F.lastId=x.id;if(String(x.ts)>F.lastTs)F.lastTs=String(x.ts)}if(n)draw()};
const sinceArg=()=>MOCK?(F.lastTs||undefined):(F.lastId||undefined); // server: numeric id; api.js mock: ts string (mismatch reported)
const tm=ts=>{const d=new Date(ts);return isNaN(d)?"":d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})};
const short=h=>h?String(h).slice(0,6)+"…"+String(h).slice(-4):"";
const actType=a=>typeof a=="string"?a:a&&a.type;
function row(x){const side=x.side?`<span class="af-side af-${e(x.side)}">${e(x.side)}</span>`:"";const usd=x.usd!=null?`<span class="af-usd">$${(+x.usd).toFixed(2)}</span>`:"";
 const ex=typeof EXPLORER=="string"&&!(S&&S.localChain)&&/^0x[0-9a-f]{64}$/i.test(x.txHash||"");const tx=x.txHash?(ex?`<a class="af-tx" href="${EXPLORER}/tx/${e(x.txHash)}" target="_blank" rel="noopener" title="${e(x.txHash)}">${e(short(x.txHash))} ↗</a>`:`<span class="af-tx" title="${e(x.txHash)}">${e(short(x.txHash))}</span>`):"";
 const acts=(x.actions||[]).map(actType).filter(t=>t=="revoke_key"||t=="resume_key").map(t=>t=="revoke_key"?`<button class="af-act af-danger" data-revoke="${e(x.keyId||"")}">Revoke key</button>`:`<button class="af-act" data-resume="${e(x.keyId||"")}">Resume key</button>`).join("");
 return `<li class="af-${e(x.kind||"trade")}"><time class="af-t" datetime="${e(x.ts)}">${tm(x.ts)}</time><span class="af-title">${e(x.title||"")}</span>${side}${usd}${tx}${acts?`<span class="af-acts">${acts}</span>`:""}</li>`}
function draw(){const el=document.getElementById("afSlot");if(!el)return;const list=[...F.items.values()].sort((a,b)=>String(b.ts).localeCompare(String(a.ts))||(b.id>a.id?1:-1)).slice(0,25);
 el.innerHTML=list.length?`<ul class="af-list">${list.map(row).join("")}</ul>`:`<p class="dx-quiet">No agent activity yet. Trades your agent makes show up here as they happen.</p>`;
 const st=document.getElementById("afLive");st&&(st.textContent=F.mode=="sse"?"Live":F.mode=="poll"?"Updating every 5s":"");
 el.querySelectorAll("[data-revoke]").forEach(b=>b.onclick=()=>confirmDlg("Revoke agent key?","Your agent immediately loses the ability to trade. This signs one transaction. You can create a new key later.","Yes, revoke",()=>doRevoke("revoked")));
 el.querySelectorAll("[data-resume]").forEach(b=>b.onclick=()=>resume(b.dataset.resume,b))}
function clearT(){clearTimeout(F.timer);F.timer=null}
function poll(){clearT();F.mode="poll";draw();const go=async()=>{if(!F.mounted)return;try{add(await api.get_activity(sinceArg()))}catch(_){}if(F.mounted)F.timer=setTimeout(go,5000)};F.timer=setTimeout(go,5000)}
async function sse(){clearT();if(!F.mounted)return;if(F.fails>=3||MOCK||!window.ReadableStream)return poll();
 F.ctl=new AbortController();F.mode="sse";draw(); /* server flushes headers only on first event/ping */try{const r=await fetch("/api/activity/stream"+(F.lastId?"?since="+F.lastId:""),{headers:{authorization:"Bearer "+tok(),accept:"text/event-stream"},signal:F.ctl.signal});
  if(!r.ok||!r.body)throw new Error("HTTP "+r.status);F.mode="sse";F.fails=0;draw();const rd=r.body.getReader(),dec=new TextDecoder();let buf="";
  for(;;){const {value,done}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;while((i=buf.indexOf("\n\n"))>=0){const blk=buf.slice(0,i);buf=buf.slice(i+2);const data=blk.split("\n").filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).join("\n");if(data)try{add([JSON.parse(data)])}catch(_){}}}
  throw new Error("stream closed")}
 catch(err){if(!F.mounted||err.name=="AbortError")return;F.fails++;const wait=Math.min(30000,1000*2**(F.fails-1));F.mode=F.fails>=3?"poll":"";draw();F.timer=setTimeout(sse,F.fails>=3?0:wait)}}
async function start(){F.mounted=true;try{add(await api.get_activity(sinceArg()))}catch(_){}draw();sse()}
function stop(){F.mounted=false;clearT();F.ctl&&F.ctl.abort();F.ctl=null}
// ---------- breaker ----------
const BR={tripped:[],msg:""};
async function loadBreaker(){try{const r=MOCK?(new URLSearchParams(location.search).get("mockBreaker")==="1"?{tripped:[{keyId:(S.key&&S.key.id)||"sk_mock",reason:"5 trades in 2 minutes (anomaly threshold)",trippedAt:new Date().toISOString()}]}:{tripped:[]}):await ownerGet("keys/breaker");BR.tripped=r.tripped||[]}catch(_){BR.tripped=[]}drawBreaker()}
const agentName=()=>{const id=ST&&ST.status&&ST.status.id;return ({"steady-stacker":"Steady Stacker","dip-hunter":"Dip Hunter","trend-flip":"Trend Flip","ai-thematic":"AI Thematic","weekend-edge":"Weekend Edge"})[id]||"Your agent"};
function drawBreaker(){const el=document.getElementById("brSlot");if(!el)return;const t=BR.tripped[0];
 el.innerHTML=t?`<div class="br-ban" role="alert"><p><b>${e(agentName())} paused:</b> ${e(t.reason||"unusual activity")}</p><button class="dx-primary" id="brGo" data-key="${e(t.keyId)}">Resume</button>${BR.msg?`<p class="st err">${e(BR.msg)}</p>`:""}</div>`:"";
 const b=document.getElementById("brGo");b&&(b.onclick=()=>resume(b.dataset.key,b));
 // one primary action: while the breaker banner shows, demote Home's other primary button
 document.querySelectorAll(".dx-hero .dx-primary").forEach(x=>x.classList.toggle("dx-demoted",!!t))}
async function resume(keyId,btn){btn&&(btn.disabled=true);try{await api.resume_key(keyId);BR.tripped=BR.tripped.filter(x=>x.keyId!=keyId);BR.msg="";say("Agent key resumed")}catch(err){BR.msg="Couldn't resume: "+err.message}drawBreaker();draw()}
// ---------- mount on Home ----------
{const [V,B]=R["/dashboard/overview"];
 R["/dashboard/overview"]=[()=>V().replace('<div class="dx-body">','<div class="dx-body"><div id="brSlot"></div>').replace(/(<section class="dx-sec" aria-labelledby="dx-act"><h2 id="dx-act">Activity<\/h2>)[\s\S]*?(<\/section>)/,'$1<p class="dx-mut dx-small" id="afLive" aria-live="polite"></p><div id="afSlot" aria-live="polite"></div>$2'),
  ()=>{B();draw();drawBreaker();if(!F.mounted)start();loadBreaker()}]}
addEventListener("hashchange",()=>{if(!/^#\/dashboard\/overview/.test(location.hash))stop()});
window.SCActivity={feed:F,breaker:BR,stop};
})();
