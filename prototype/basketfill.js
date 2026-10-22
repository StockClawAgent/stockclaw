/* StockClaw basket fill donut — reusable component.
   Data contract (Lucius, confirmed): {id, basketId, basketVersion, basketHash, totalUsd, status:'pending'|'running'|'partial'|'filled'|'failed',
   createdAt, updatedAt, legs:[{legId, ticker, weight, targetUsd, filledUsd, status:'pending'|'filling'|'filled'|'failed', txHash?, error?}]}
   A ticker over $98 is split into several legs: slices are keyed by TICKER and aggregate their legs.
   Usage: BasketFill.mount(el, executionId) — follows api.subscribeExecution (SSE, api.js falls back to polling) until a terminal status.
   Data source: BFAdapter below, all through api.js (mock with ?mock=1, forced leg failure with ?mockFail=1).
   A failed leg can later become filled (leg_filled after a late mine, R7-4): it renders as filled; after a terminal partial/failed
   the stream is re-opened while a failed leg still has a tx out. A leg with a tx out (server `confirming: true`, or txHash + failed until that lands) shows "Confirming…", never Retry.
   ?mock=1&mockHeal=1 exercises failed+tx -> Confirming… -> filled; add &mockConfirmFlag=1 for the server flag, or =end for flag true -> false (watch over, Retry returns). */
(function(){
const e=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const usd=n=>"$"+(+n||0).toFixed(2);
// Per-ticker colors from landing.js's fixed map; tickers it doesn't know (testnet-only ones) get the first palette color unused in this order.
const PAL=["#C6FF3D","#3DE0FF","#FF5FA2","#FFE14D","#A78BFA","#5AA9FF","#5EF2B8","#FF7AF5","#9DFF8A","#7DF9FF","#F5F5F5","#D4D4D4"];
let LOCAL={};const known=t=>window.SCBaskets&&SCBaskets.has&&SCBaskets.has(t)?SCBaskets.col(t):null;
function assign(tickers){LOCAL={};const used=new Set(tickers.map(known).filter(Boolean));tickers.forEach(t=>{if(!known(t)){const c=PAL.find(c=>!used.has(c))||"#D4D4D4";used.add(c);LOCAL[t]=c}})}
const color=t=>known(t)||LOCAL[t]||"#D4D4D4";

// ---------------- the ONE adapter (api.js: Lucius 502b3f4) ----------------
// preview -> buy {previewId, id, usd, idempotencyKey}; api.js sends it as the Idempotency-Key header (reused on "Try again").
const uuid=()=>crypto.randomUUID?crypto.randomUUID():"k-"+Date.now().toString(36)+Math.random().toString(36).slice(2);
const BFAdapter={
 newKey:uuid,
 list:()=>api.list_baskets(),
 // buy with previewId (202 + execution). PREVIEW_EXPIRED: re-preview once, silently.
 start:async(basketId,usd,idempotencyKey)=>{const pre=async()=>{const pv=await api.preview_basket_buy(basketId,usd);if(pv&&pv.preflight&&pv.preflight.ok===false)throw Object.assign(new Error("preflight"),{data:{code:"PREFLIGHT",message:(pv.preflight.failures||[]).join(" ")||"This basket can't be bought right now.",retryable:false}});return pv};
  let pv=await pre();try{return await api.buy_basket({previewId:pv.previewId,idempotencyKey})}
  catch(err){if(SCErr.of(err).code!=="PREVIEW_EXPIRED")throw err;pv=await pre();return api.buy_basket({previewId:pv.previewId,idempotencyKey})}},
 subscribe:(id,on)=>MOCK_HEAL?healSub(id,on):api.subscribeExecution(id,on),
 retry:(id,legId)=>api.retry_basket_leg(id,legId)};

// ?mock=1&mockHeal=1: like the server after R7-4. Legs fill one by one; leg 2 times out (failed, tx already sent), the stream ends
// "partial"; ~6s later that tx mines and the leg reconciles to filled. Re-subscribing returns the current snapshot, as the server does.
const MOCK_HEAL=/[?&]mock=1/.test(location.search)&&/[?&]mockHeal=1/.test(location.search),HEAL={};
function healState(id){const h=HEAL[id],t=Date.now()-h.t0,n=h.legs.length,end=(n+1)*1200,healAt=end+(+new URLSearchParams(location.search).get("mockHealMs")||6000);
 const legs=h.legs.map((l,i)=>{let status=t>(i+1)*1200?"filled":t>i*1200?"filling":"pending";const tx="0xMOCKLEG"+i+"a11ce";
  const fl=(location.search.match(/[?&]mockConfirmFlag=(\w+)/)||[])[1]; // 1: flag true then fills; end: flag true, then false (watch over) -> Retry
  if(i==1&&status=="filled")status=t>healAt&&fl!="end"?"filled":"failed";
  return {legId:l.legId,ticker:l.ticker,weight:l.weight,targetUsd:l.targetUsd,filledUsd:status=="filled"?l.targetUsd:0,status,...(status!="pending"?{txHash:tx}:{}),...(status=="failed"&&fl?{confirming:!(fl=="end"&&t>healAt)}:{}),...(status=="failed"?{error:"Sent, still waiting for the network. Retry checks the receipt first."}:{})}});
 const all=legs.every(l=>l.status=="filled"),busy=legs.some(l=>l.status=="pending"||l.status=="filling");
 return {id,basketId:h.basketId,totalUsd:h.totalUsd,status:all?"filled":busy?(t<300?"pending":"running"):"partial",createdAt:new Date(h.t0).toISOString(),updatedAt:new Date().toISOString(),legs}}
function healSub(id,on){let closed=false,prev=null;(async()=>{if(!HEAL[id]){const x=await api.get_basket_execution(id).catch(()=>null);if(!x)return;HEAL[id]={t0:Date.now(),legs:x.legs,basketId:x.basketId,totalUsd:x.totalUsd}}
  const tick=()=>{if(closed)return;const x=healState(id);if(!prev)on({type:"snapshot",executionId:id,execution:x});else{x.legs.forEach(l=>{const o=prev.legs.find(p=>p.legId==l.legId);if(o.status!=l.status||o.confirming!==l.confirming)on({type:"leg_"+l.status,executionId:id,legId:l.legId,ticker:l.ticker,targetUsd:l.targetUsd,filledUsd:l.filledUsd,...(l.txHash?{txHash:l.txHash}:{}),...(l.error?{code:l.error}:{}),...(l.confirming!=null?{confirming:l.confirming}:{})})});if(prev.status!=x.status)on({type:"execution_status",executionId:id,status:x.status})}
   prev=x;if(["filled","partial","failed"].includes(x.status))return;setTimeout(tick,250)};tick()})();return {close:()=>{closed=true}}}

// ---------------- aggregation: slices by ticker ----------------
// A leg whose tx is out but not settled is "confirming": no Retry (retrying could double-buy), shows "Confirming…".
// Server flag `confirming` (Lucius 1dc3602, failed legs with a txHash only): true = tx still watched, false = terminal, Retry is safe.
// Once any snapshot/event has carried the flag, the old txHash + failed fallback is off for good (a flag-less failed leg gets Retry).
let FLAG_SEEN=false;const seeFlag=l=>{if(l&&typeof l.confirming=="boolean")FLAG_SEEN=true};
const confirming=l=>l.status=="failed"&&(typeof l.confirming=="boolean"?l.confirming:(!FLAG_SEEN&&!!l.txHash));
function slices(x){const m=new Map();(x.legs||[]).forEach(l=>{let s=m.get(l.ticker);if(!s){s={ticker:l.ticker,weight:+l.weight||0,target:0,filled:0,legs:[]};m.set(l.ticker,s)}s.target+=+l.targetUsd||0;s.filled+=+l.filledUsd||0;s.legs.push(l)});
 return [...m.values()].map(s=>{const st=s.legs.map(l=>l.status);s.status=st.every(v=>v=="filled")?"filled":s.legs.some(l=>l.status=="failed"&&!confirming(l))?"failed":s.legs.some(confirming)?"confirming":st.some(v=>v=="filling"||v=="filled")?"filling":"pending";
  s.frac=s.target?Math.min(1,s.filled/s.target):0;s.error=(s.legs.find(l=>l.error)||{}).error;return s})}

// ---------------- render ----------------
const R=70,C=2*Math.PI*R,G=3;
function svg(sl,x){assign(sl.map(s=>s.ticker));const tot=sl.reduce((a,s)=>a+s.target,0)||1;let acc=0;const done=sl.filter(s=>s.status=="filled").length;
 const center=x.status=="filled"?"Done":x.status=="partial"||x.status=="failed"?"Partial":`${done}/${sl.length}`;
 const sub=x.status=="filled"||x.status=="partial"||x.status=="failed"?`${done}/${sl.length} filled`:"filled";
 const segs=sl.map((s,i)=>{const len=Math.max(.5,s.target/tot*C-G),rot=acc/C*360-90;acc+=s.target/tot*C;const c=color(s.ticker);
  const fill=s.status=="failed"?len:len*s.frac;
  return `<g transform="rotate(${rot.toFixed(2)} 90 90)" class="bf-s bf-${s.status}" data-t="${e(s.ticker)}">
<circle r="${R}" cx="90" cy="90" fill="none" stroke="${c}" stroke-opacity=".28" stroke-width="2" stroke-dasharray="${len.toFixed(2)} ${C}" transform="translate(0 0)"/>
<circle r="${R+11}" cx="90" cy="90" fill="none" stroke="${c}" stroke-opacity=".28" stroke-width="1.5" stroke-dasharray="${(len*(R+11)/R).toFixed(2)} ${C*2}"/>
<circle r="${R-11}" cx="90" cy="90" fill="none" stroke="${c}" stroke-opacity=".28" stroke-width="1.5" stroke-dasharray="${(len*(R-11)/R).toFixed(2)} ${C*2}"/>
<circle class="bf-f" r="${R}" cx="90" cy="90" fill="none" stroke="${s.status=="failed"?"url(#bf-hatch-"+i+")":c}" stroke-width="22" stroke-dasharray="${fill.toFixed(2)} ${C}"/>
<defs><pattern id="bf-hatch-${i}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#0A0A0A"/><rect width="2" height="6" fill="${c}" fill-opacity=".45"/></pattern></defs></g>`}).join("");
 return `<svg class="bf-dn" viewBox="0 0 180 180" role="img" aria-label="${e(center)}: ${done} of ${sl.length} tickers filled">${segs}</svg><div class="bf-c" aria-hidden="true"><b>${e(center)}</b><span>${e(sub)}</span></div>`}
function legend(sl){return `<ul class="bf-lg">${sl.map(s=>`<li class="bf-${s.status}"><span class="bf-sw" style="background:${color(s.ticker)}" aria-hidden="true"></span><span class="bf-t" style="color:${color(s.ticker)}">${e(s.ticker)}</span><span class="bf-w">${usd(s.filled)} <span class="bf-of">of ${usd(s.target)}</span></span><span class="bf-st">${
 s.status=="filled"?'<span class="bf-ok" aria-label="Filled">✓</span>':s.status=="failed"?`<button class="bf-retry" data-retry="${e(s.ticker)}" aria-label="Retry ${e(s.ticker)}${s.error?": "+e(s.error):""}">Retry</button>`:s.status=="confirming"?'<span class="bf-pend bf-conf">Confirming…</span>':s.status=="filling"?'<span class="bf-dot" aria-label="Filling">…</span>':'<span class="bf-pend">Waiting</span>'}</span></li>`).join("")}</ul>`}

function mount(el,id,opts={}){if(!el)return;if(el._bf)el._bf.sub&&el._bf.sub.close();const st={id,sub:null,x:null};el._bf=st;
 const status=document.createElement("p");status.className="bf-live sr-only";status.setAttribute("aria-live","polite");
 const draw=x=>{const sl=slices(x);const was=el.querySelector(".bf-wrap");const html=`<div class="bf-wrap"><div class="bf-ring">${svg(sl,x)}</div>${legend(sl)}</div>`;
  const tmp=document.createElement("div");tmp.innerHTML=html;const nw=tmp.firstChild;
  const keys=w=>[...w.querySelectorAll(".bf-s")].map(g=>g.dataset.t).join();
  if(!was){el.innerHTML="";el.appendChild(nw);el.appendChild(status);(matchMedia("(prefers-reduced-motion: reduce)").matches?nw.classList.add("bf-in"):requestAnimationFrame(()=>requestAnimationFrame(()=>nw.classList.add("bf-in"))))}
  else if(keys(was)==keys(nw)){const og=was.querySelectorAll(".bf-s"),ng=nw.querySelectorAll(".bf-s");
   og.forEach((g,i)=>{g.setAttribute("class",ng[i].getAttribute("class"));const f=g.querySelector(".bf-f"),nf=ng[i].querySelector(".bf-f");f.setAttribute("stroke",nf.getAttribute("stroke"));f.setAttribute("stroke-dasharray",nf.getAttribute("stroke-dasharray"))});
   was.querySelector(".bf-c").replaceWith(nw.querySelector(".bf-c"));was.querySelector("svg").setAttribute("aria-label",nw.querySelector("svg").getAttribute("aria-label"));was.querySelector(".bf-lg").replaceWith(nw.querySelector(".bf-lg"))}
  else{was.replaceWith(nw);nw.classList.add("bf-in")}
  const done=sl.filter(s=>s.status=="filled").length;status.textContent=x.status=="filled"?"Basket filled":x.status=="partial"||x.status=="failed"?`Partial: ${done} of ${sl.length} filled${sl.some(s=>s.status=="confirming")?", rest confirming":""}`:`${done} of ${sl.length} filled`;
  el.querySelectorAll("[data-retry]").forEach(b=>b.onclick=async()=>{b.disabled=true;b.textContent="Retrying…";const s=sl.find(s=>s.ticker==b.dataset.retry);
   try{for(const l of s.legs.filter(l=>l.status=="failed"&&!confirming(l)))await BFAdapter.retry(id,l.legId);follow()}catch(err){b.disabled=false;b.textContent="Retry";const i=SCErr.of(err);status.textContent=i.message}});
  opts.onUpdate&&opts.onUpdate(x)};
 // events: snapshot {execution} | leg_* {legId, ticker, targetUsd, filledUsd, txHash?, confirming? (failed+tx), error?, code?} | execution_status {status}
 const onEv=ev=>{if(el._bf!==st||!el.isConnected&&st.x)return st.sub&&st.sub.close();
  if(ev.type=="snapshot"){st.x=JSON.parse(JSON.stringify(ev.execution));(st.x.legs||[]).forEach(seeFlag)}
  else if(!st.x)return;
  else if(/^leg_/.test(ev.type)){const k=ev.type.slice(4);let l=st.x.legs.find(l=>l.legId==ev.legId);if(!l){l={legId:ev.legId,ticker:ev.ticker,weight:0};st.x.legs.push(l)}
   Object.assign(l,{status:k,ticker:ev.ticker||l.ticker,targetUsd:ev.targetUsd!=null?ev.targetUsd:l.targetUsd,filledUsd:ev.filledUsd!=null?ev.filledUsd:l.filledUsd},ev.txHash?{txHash:ev.txHash}:{},(ev.error||ev.code)?{error:ev.error||ev.code}:{},typeof ev.confirming=="boolean"?{confirming:ev.confirming}:{});seeFlag(ev);
   if(k=="filled"||k=="filling"){delete l.error;if(k=="filled")delete l.confirming} // a failed leg whose tx mined late (R7-4) arrives as leg_filled: it replaces the failed state
   if(st.x.status=="pending")st.x.status="running"}
  else if(ev.type=="execution_status"){st.x.status=ev.status}
  draw(st.x);watch()};
 const follow=()=>{st.sub&&st.sub.close();st.sub=BFAdapter.subscribe(id,onEv)};
 // The server stream ends at a terminal status, but a failed leg that has a txHash is still reconciled server-side and can
 // become filled later. While one is out, re-open the stream every 5s (snapshot = current state): until the server flag says
 // confirming:false (or the leg fills); on the old txHash+failed fallback, for up to 10 min.
 const watch=()=>{clearTimeout(st.w);const x=st.x;if(!x||!["partial","failed"].includes(x.status)||!el.isConnected||el._bf!==st)return;
  if(!(x.legs||[]).some(confirming))return;st.w0=st.w0||Date.now();if(!FLAG_SEEN&&Date.now()-st.w0>6e5)return;st.w=setTimeout(()=>{if(el.isConnected&&el._bf===st)follow()},5000)};
 follow();return st}
window.BasketFill={mount,slices,adapter:BFAdapter};
})();
