/* StockClaw basket fill donut — reusable component.
   Data contract (Lucius, confirmed): {id, basketId, basketVersion, basketHash, totalUsd, status:'pending'|'running'|'partial'|'filled'|'failed',
   createdAt, updatedAt, legs:[{legId, ticker, weight, targetUsd, filledUsd, status:'pending'|'filling'|'filled'|'failed', txHash?, error?}]}
   A ticker over $98 is split into several legs: slices are keyed by TICKER and aggregate their legs.
   Usage: BasketFill.mount(el, executionId)  — polls every 2s while pending/running, then stops.
   Data source: BFAdapter below, all through api.js (mock with ?mock=1, forced leg failure with ?mockFail=1). */
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
 start:async(basketId,usd,idempotencyKey)=>{const pv=await api.preview_basket_buy(basketId,usd);if(pv&&pv.preflight&&pv.preflight.ok===false)throw new Error((pv.preflight.failures||[]).join("; ")||"Preflight failed");
  return api.buy_basket({previewId:pv&&pv.previewId,id:basketId,usd,idempotencyKey})},
 get:id=>api.get_basket_execution(id),
 retry:(id,legId)=>api.retry_basket_leg(id,legId)};

// ---------------- aggregation: slices by ticker ----------------
function slices(x){const m=new Map();(x.legs||[]).forEach(l=>{let s=m.get(l.ticker);if(!s){s={ticker:l.ticker,weight:+l.weight||0,target:0,filled:0,legs:[]};m.set(l.ticker,s)}s.target+=+l.targetUsd||0;s.filled+=+l.filledUsd||0;s.legs.push(l)});
 return [...m.values()].map(s=>{const st=s.legs.map(l=>l.status);s.status=st.every(v=>v=="filled")?"filled":st.some(v=>v=="failed")?"failed":st.some(v=>v=="filling"||v=="filled")?"filling":"pending";
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
 s.status=="filled"?'<span class="bf-ok" aria-label="Filled">✓</span>':s.status=="failed"?`<button class="bf-retry" data-retry="${e(s.ticker)}" aria-label="Retry ${e(s.ticker)}${s.error?": "+e(s.error):""}">Retry</button>`:s.status=="filling"?'<span class="bf-dot" aria-label="Filling">…</span>':'<span class="bf-pend">Waiting</span>'}</span></li>`).join("")}</ul>`}

function mount(el,id,opts={}){if(!el)return;if(el._bf)clearTimeout(el._bf.t);const st={id,t:null,x:null};el._bf=st;
 const status=document.createElement("p");status.className="bf-live sr-only";status.setAttribute("aria-live","polite");
 const draw=x=>{const sl=slices(x);const was=el.querySelector(".bf-wrap");const html=`<div class="bf-wrap"><div class="bf-ring">${svg(sl,x)}</div>${legend(sl)}</div>`;
  const tmp=document.createElement("div");tmp.innerHTML=html;const nw=tmp.firstChild;
  const keys=w=>[...w.querySelectorAll(".bf-s")].map(g=>g.dataset.t).join();
  if(!was){el.innerHTML="";el.appendChild(nw);el.appendChild(status);(matchMedia("(prefers-reduced-motion: reduce)").matches?nw.classList.add("bf-in"):requestAnimationFrame(()=>requestAnimationFrame(()=>nw.classList.add("bf-in"))))}
  else if(keys(was)==keys(nw)){const og=was.querySelectorAll(".bf-s"),ng=nw.querySelectorAll(".bf-s");
   og.forEach((g,i)=>{g.setAttribute("class",ng[i].getAttribute("class"));const f=g.querySelector(".bf-f"),nf=ng[i].querySelector(".bf-f");f.setAttribute("stroke",nf.getAttribute("stroke"));f.setAttribute("stroke-dasharray",nf.getAttribute("stroke-dasharray"))});
   was.querySelector(".bf-c").replaceWith(nw.querySelector(".bf-c"));was.querySelector("svg").setAttribute("aria-label",nw.querySelector("svg").getAttribute("aria-label"));was.querySelector(".bf-lg").replaceWith(nw.querySelector(".bf-lg"))}
  else{was.replaceWith(nw);nw.classList.add("bf-in")}
  const done=sl.filter(s=>s.status=="filled").length;status.textContent=x.status=="filled"?"Basket filled":x.status=="partial"||x.status=="failed"?`Partial: ${done} of ${sl.length} filled`:`${done} of ${sl.length} filled`;
  el.querySelectorAll("[data-retry]").forEach(b=>b.onclick=async()=>{b.disabled=true;b.textContent="Retrying…";const s=sl.find(s=>s.ticker==b.dataset.retry);
   try{for(const l of s.legs.filter(l=>l.status=="failed"))await BFAdapter.retry(id,l.legId);clearTimeout(st.t);tick()}catch(err){b.disabled=false;b.textContent="Retry";status.textContent="Retry failed: "+err.message}});
  opts.onUpdate&&opts.onUpdate(x)};
 const tick=async()=>{if(el._bf!==st||!el.isConnected&&st.x)return;try{const x=await BFAdapter.get(id);st.x=x;draw(x);if(x.status=="pending"||x.status=="running")st.t=setTimeout(tick,opts.interval||2000)}
  catch(err){if(opts.onError){const s=el.closest("section");if(s)s.hidden=true;return}el.innerHTML=`<p class="st err" role="alert">Couldn't load the basket order: ${e(err.message)}</p>`}};
 tick();return st}
window.BasketFill={mount,slices,adapter:BFAdapter};
})();
