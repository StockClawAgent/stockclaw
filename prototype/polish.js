/* StockClaw polish layer: step transitions + animated progress, sticky mobile primary, money tick-up, copy check, success moments.
   One shared rAF loop (SCFrame). Wraps the global render() without changing any route code. Respects prefers-reduced-motion. */
(function(){
const RM=matchMedia("(prefers-reduced-motion: reduce)");
// ---- single rAF loop ----
const tasks=new Set();let raf=0;
function loop(t){raf=0;for(const f of [...tasks]){if(f(t)===false)tasks.delete(f)}if(tasks.size)raf=requestAnimationFrame(loop)}
const SCFrame={add(f){tasks.add(f);if(!raf)raf=requestAnimationFrame(loop)},del(f){tasks.delete(f)}};window.SCFrame=SCFrame;
// ---- money tick-up ----
const seen=new Map();const fmt=(v,dec)=>"$"+v.toLocaleString("en-US",{minimumFractionDigits:dec,maximumFractionDigits:dec});
function tick(el,key){const m=/^\$([\d,]+(?:\.(\d+))?)$/.exec(el.textContent.trim());if(!m)return;const to=+m[1].replace(/,/g,""),dec=(m[2]||"").length;
 const from=seen.has(key)?seen.get(key):0;seen.set(key,to);if(RM.matches||from===to)return;el.classList.add("sc-num");const t0=performance.now(),D=from?420:700;
 el.textContent=fmt(from,dec);SCFrame.add(t=>{if(!el.isConnected)return false;const k=Math.min(1,(t-t0)/D),e=1-Math.pow(1-k,3);el.textContent=fmt(from+(to-from)*e,dec);return k<1})}
// ---- render wrapper ----
let prevRoute=null,prevStep=-1;
const route=()=>(location.hash.slice(1)||"/").split("?")[0];
function after(){const r=route(),changed=r!==prevRoute,main=document.getElementById("main");if(!main)return;
 const steps=main.querySelector(".dx-steps");let idx=-1;
 if(steps){const lis=[...steps.children];idx=lis.findIndex(l=>l.classList.contains("on"));const n=lis.length,f=(idx+1)/n,pf=prevStep>=0?(prevStep+1)/n:f;
  const bar=document.createElement("div");bar.className="sc-prog";bar.setAttribute("aria-hidden","true");bar.innerHTML="<i></i>";bar.firstChild.style.setProperty("--p",changed?pf:f);steps.appendChild(bar);
  if(changed&&pf!==f)requestAnimationFrame(()=>requestAnimationFrame(()=>bar.firstChild.style.setProperty("--p",f)))}
 if(changed&&!RM.matches){const pane=main.querySelector(".dx-ob")||main.querySelector(".dx-body")||main.firstElementChild;
  if(pane){const c=idx>=0&&prevStep>=0&&idx!==prevStep?(idx>prevStep?"sc-in-f":"sc-in-b"):"sc-in";pane.style.willChange="transform,opacity";pane.classList.add(c);
   pane.addEventListener("animationend",function h(ev){if(ev.target!==pane)return;pane.classList.remove(c);pane.style.willChange="";pane.removeEventListener("animationend",h)})}}
 if(changed&&steps){const h=main.querySelector(".dx-ob h1");if(h){h.tabIndex=-1;h.focus({preventScroll:true})}}
 // sticky primary on mobile flows: onboarding steps + basket fill page
 document.querySelectorAll(".sc-dock").forEach(x=>x.classList.remove("sc-dock"));
 const flow=main.querySelector(".dx-ob")||(r=="/dashboard/basket"?main:null);const ok=x=>!x.closest(".st,.apr,[hidden],details");main.querySelectorAll(".sc-prom").forEach(x=>x.classList.remove("dx-primary","sc-prom"));
 let pb=flow&&[...flow.querySelectorAll(".dx-primary")].find(ok);
 // legacy steps (app.js) use plain buttons: promote the step's main action so every screen has one consistent primary
 if(flow&&!pb){pb=[...flow.querySelectorAll("a.btn")].find(ok)||[...flow.querySelectorAll("form button:not([type=button]),button#oa")].find(ok);pb&&pb.classList.add("dx-primary","sc-prom")}
 if(pb)pb.classList.add("sc-dock");document.body.classList.toggle("sc-has-dock",!!pb);
 main.querySelectorAll(".dx-big").forEach((el,i)=>tick(el,r+"#"+i));
 if(changed){prevRoute=r;prevStep=idx}else if(idx>=0)prevStep=idx}
if(typeof window.render==="function"){const R0=window.render;window.render=function(){const v=R0.apply(this,arguments);try{after()}catch(e){console.warn("polish",e)}return v};}
// ---- copy check ----
document.addEventListener("click",ev=>{const c=ev.target.closest&&ev.target.closest("[data-copy]");if(!c)return;c.classList.add("sc-copied");clearTimeout(c._t);c._t=setTimeout(()=>c.classList.remove("sc-copied"),1400)},{capture:true,passive:true});
// ---- success moments ----
const WINS={"Agent key created":"Agent key created","Passkey saved":"Passkey set","Sell approved":"Sell approved","Limits saved, new key active":"Limits saved"};
function toast(msg){document.querySelectorAll(".sc-toast").forEach(x=>x.remove());const t=document.createElement("div");t.className="sc-toast";t.setAttribute("aria-hidden","true");
 t.innerHTML=`<span class="tb"><img src="logo3d/claw-mark.svg" width="28" height="28" alt=""></span><span><span class="tk">✓</span> ${msg}</span>`;
 document.body.appendChild(t);if(!RM.matches){setTimeout(()=>t.classList.add("smile"),380);setTimeout(()=>t.classList.remove("smile"),700)}
 setTimeout(()=>{t.classList.add("out");setTimeout(()=>t.remove(),260)},2200)}
window.SCToast=toast;
// ---- display names: plain token names in visible text (data and API symbols stay as the server sends them) ----
const hx=(s)=>{let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;const a=h.toString(16).padStart(8,"0");return "0x"+a.slice(0,4)+"…"+a.slice(4)};
const NAMES=[[/\bmUSDG\b/g,"USDG"],[/\bMockAggregatorV3\b/g,"Oracle"],[/0xMOCK[\w…]*/g,(m)=>hx(m)],[/\bsk_mock\b/g,"sk_dip1"]];
const tidy=(root)=>{if(!root)return;const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())){const v=n.nodeValue;if(!/mUSDG|MockAggregatorV3|0xMOCK|sk_mock/.test(v))continue;let o=v;for(const [r,t] of NAMES)o=o.replace(r,t);if(o!==v)n.nodeValue=o}};
tidy(document.body);new MutationObserver((ms)=>{for(const m of ms){if(m.type==="characterData")tidy(m.target.parentNode);else m.addedNodes.forEach(x=>x.nodeType===3?tidy(x.parentNode):x.nodeType===1&&tidy(x))}}).observe(document.body,{childList:true,subtree:true,characterData:true});
const live=document.getElementById("live");live&&new MutationObserver(()=>{const m=WINS[live.textContent.trim()];m&&toast(m)}).observe(live,{childList:true,characterData:true,subtree:true});
let doneFor=null;const main=document.getElementById("main");
main&&new MutationObserver(()=>{const b=main.querySelector(".bf-c b");if(!b||b.textContent.trim()!=="Done"){if(b&&b.textContent.trim()!=="Done")doneFor=null;return}
 const ring=b.closest(".bf-ring");if(doneFor===ring)return;doneFor=ring;if(!RM.matches)ring.classList.add("sc-done");toast("Basket filled")}).observe(main,{childList:true,subtree:true,characterData:true});
addEventListener("hashchange",()=>{try{after()}catch(e){}}); // app.js binds hashchange to the original render
setTimeout(after,0);
})();
