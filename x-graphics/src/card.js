/* Renders one card from params. Params: window.CARD (set by render.js) or URL query:
   ?type=agent|group|basket|steps|count|show|quote|ann&id=...&w=1600&h=900&json=<urlencoded JSON for quote/ann> */
(function(){
const D=window.SC_DATA, q=new URLSearchParams(location.search);
const P=Object.assign({type:q.get("type")||"group",id:q.get("id"),w:+(q.get("w")||1600),h:+(q.get("h")||900),json:q.get("json")?JSON.parse(q.get("json")):null},window.CARD||{});
const W=P.w,H=P.h,port=H>W,c=document.getElementById("c");
c.style.setProperty("--w",W+"px");c.style.setProperty("--h",H+"px");c.style.setProperty("--pad",(port?80:96)+"px");
c.classList.add(P.type, port?"portrait":"landscape");
const esc=s=>String(s).replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[m]);
const bot=(id,size)=>{const e=D.eyes[id]||[];return `<div class="bot" style="width:${size}px;height:${size}px"><img src="assets/avatars/eyeless-${id}-transparent.png">${e.map(([x,y,w,h,a])=>`<span class="eye ${a?"ang-"+a:""}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"></span>`).join("")}</div>`};
const logo=(s)=>`<img src="assets/logo/blob-3d-512.png" style="height:${s}px">`;
const top=`<div class="top"><img class="m" src="assets/logo/blob-3d-512.png"><img class="w" src="assets/logo/blob-wordmark.svg"></div>`;
const foot=(t)=>`<div class="foot"><span>${D.handle}</span>${t?"":""}</div>`;
const glow=(x,y)=>{c.style.setProperty("--gx",x);c.style.setProperty("--gy",y)};
const pct=v=>(+v).toFixed(2).replace(/\.?0+$/,"")+"%";
let html="";
const T={
agent(){const i=D.agents.findIndex(a=>a.id==P.id),a=D.agents[i];glow(port?"50%":"74%",port?"68%":"50%");
 const S=port?560:620;
 return top+`<div class="body" style="${port?"padding-top:150px":""}"><div class="wrap"><div class="txt"><div class="idx">AGENT 0${i+1} / 05 · <span style="color:${a.status.startsWith("In")?"var(--lime)":"var(--mute)"}">${esc(a.status.toUpperCase())}</span></div><h1 class="h">${esc(a.name).replace(" ","<br>")}</h1><p class="p">${esc(a.role)}</p></div>${port?`<div style="align-self:flex-end;margin:-60px -40px 30px 0">${bot(a.id,S)}</div>`:bot(a.id,S)}</div></div>`+foot(false)},
group(){glow("50%","62%");const s=port?300:270;
 const items=D.agents.map(a=>`<div class="it ${a.status.startsWith("In")?"live":"soon"}">${bot(a.id,s)}<div class="nm">${esc(a.name)}</div><div class="st">${a.status.startsWith("In")?"Demo Friday":"Soon"}</div></div>`);
 if(port) return top+`<div class="body"><h1 class="h" style="font-size:112px;margin-top:120px">Meet the<br><em>agents.</em></h1></div><div class="row" style="top:560px;gap:10px">${items.slice(0,3).join("")}</div><div class="row" style="top:930px;gap:60px">${items.slice(3).join("")}</div>`+foot(false);
 return top+`<div class="body"><h1 class="h" style="font-size:112px;margin-top:92px">Meet the <em>agents.</em></h1></div><div class="row" style="bottom:110px;gap:18px">${items.join("")}</div>`+foot(false)},
basket(){const b=D.baskets.find(x=>x.id==P.id),t=[...b.tickers].sort((x,y)=>y.weightPct-x.weightPct);const sum=t.reduce((a,x)=>a+x.weightPct,0);
 const S=port?560:600,R=200,sw=78,C=2*Math.PI*R,G=6;let acc=0;
 const segs=t.map(x=>{const len=x.weightPct/sum*C-G,rot=acc/C*360-90;acc+=x.weightPct/sum*C;return `<circle r="${R}" cx="250" cy="250" fill="none" stroke="${D.colors[x.ticker]}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" transform="rotate(${rot.toFixed(2)} 250 250)"/>`}).join("");
 const av=D.basketAvatar[b.id]||b.id;
 const donut=`<div class="dwrap" style="width:${S}px;height:${S}px"><svg viewBox="0 0 500 500"><circle r="${R}" cx="250" cy="250" fill="none" stroke="#151515" stroke-width="${sw+16}"/>${segs}</svg><div class="dc">${bot("basket-"+av,S*.42)}</div></div>`;
 const cols=port?2:(t.length>5?2:1);
 const leg=`<ul class="legend" style="grid-template-columns:repeat(${cols},auto);justify-content:start">${t.map(x=>`<li><span class="sw" style="background:${D.colors[x.ticker]}"></span><span class="t" style="color:${D.colors[x.ticker]}">${x.ticker}</span><span class="w">${pct(x.weightPct)}</span></li>`).join("")}</ul>`;
 glow(port?"50%":"75%",port?"40%":"50%");
 const tag=`<span class="tag" style="color:#CFCFC8;border-color:#333">Market-cap weighted</span>`;
 if(port) return top+`<div class="body" style="display:flex;flex-direction:column;align-items:center;padding-top:150px">${donut}<div style="align-self:stretch;margin-top:30px"><div class="kick">BASKET</div><h1 class="h" style="font-size:112px;margin:10px 0 16px">${esc(b.theme)}</h1><p class="p" style="max-width:none">${esc(D.basketLines[b.id])}</p>${leg}</div></div><div class="foot"><span>${D.handle}</span>${tag}</div>`;
 return top+`<div class="body"><div class="wrap"><div class="l" style="padding-top:20px"><div class="kick">BASKET</div><h1 class="h">${esc(b.theme)}</h1><p class="p">${esc(D.basketLines[b.id])}</p>${leg}</div>${donut}</div></div><div class="foot"><span>${D.handle}</span>${tag}</div>`},
steps(){glow("85%","20%");const st=D.steps.map(s=>`<div class="s"><div class="n">0${s.n}</div><div class="sh">${esc(s.h)}</div><p class="p">${esc(s.p)}</p></div>`).join("");
 if(port) return top+`<div class="body" style="padding-top:160px"><h1 class="h h1" style="font-size:100px">Three moves.<br><em>Then it trades.</em></h1><div class="grid" style="margin-top:56px;gap:36px">${st}</div></div>`+foot(true);
 return top+`<div class="body" style="padding-top:150px"><h1 class="h h1">Three moves. <em>Then it trades.</em></h1><div class="grid" style="grid-template-columns:repeat(3,1fr);gap:48px;margin-top:80px">${st}</div></div>`+foot(true)},
count(){const k=D.countdown.find(x=>x.id==P.id);glow("78%","55%");
 return top+`<div class="body" style="display:flex;align-items:center"><div style="flex:1;margin-top:30px"><div class="kick">${esc(k.kicker)}</div><div class="big" style="margin:26px 0 34px;font-size:${k.big.length>7?220:300}px">${esc(k.big)}</div><div class="p" style="font-size:40px">Pick an agent. Bring your AI. <span style="color:var(--lime)">Watch it trade.</span></div><div class="p mute" style="margin-top:14px">${esc(k.sub)}</div></div></div><img src="assets/logo/blob-3d-1024.png" style="position:absolute;right:40px;top:${k.big.length>7?330:250}px;width:${k.big.length>7?420:520}px;transform:rotate(-8deg);filter:drop-shadow(0 40px 60px rgba(0,0,0,.7))">`+foot(false)},
show(){const s=D.showcase.find(x=>x.id==P.id);
 const phone=(img,wd,extra="")=>{const r=wd*.14,b=wd*.03;return `<div class="phone" style="width:${wd}px;height:${wd*844/390+2*b}px;--r:${r}px;--b:${b}px;${extra}"><div class="isl"></div><div class="scr"><img src="assets/shots/${img}"></div></div>`};
 if(s.id=="browser"){glow("70%","60%");return top+`<div class="body"><h1 class="h" style="font-size:80px;margin-top:100px">${s.h}</h1></div><div class="browser" style="left:96px;top:290px;width:820px"><div class="bar"><i></i><i></i><i></i><div class="url">stockclaw · demo</div></div><img src="assets/shots/x-landing-1440.png"></div>${phone("x-home.png",270,"position:absolute;right:230px;top:150px")}`+foot(true)}
 if(s.id=="flow"){glow("50%","80%");const sh=[["x-landing.png","Pick an agent"],["x-home.png","Your dashboard"],["x-basket.png","Basket fills"],["x-approve.png","Approve a sell"]];
  return top+`<div class="body"><h1 class="h" style="font-size:72px;margin-top:96px;text-align:center">${s.h}</h1></div><div style="position:absolute;left:0;right:0;top:255px;display:flex;justify-content:center;gap:64px">${sh.map(([f,t])=>`<div>${phone(f,212)}<div class="cap">${t}</div></div>`).join("")}</div>`+foot(true)}
 glow("72%","50%");
 return top+`<div class="body" style="display:flex;align-items:center"><div style="flex:1"><h1 class="h" style="font-size:118px">${s.h}</h1><p class="p" style="margin-top:34px;max-width:17ch;font-size:38px">${esc(s.p)}</p></div></div>${phone(s.shot,320,"position:absolute;right:220px;top:60px")}`+foot(true)},
quote(){const j=P.json;glow("80%","80%");const n=j.quote.length,fs=n<60?100:n<110?82:n<170?66:56;
 const av=j.avatar=="logo"||!j.avatar?logo(120):bot(j.avatar,140);
 return top+`<div class="body" style="display:flex;flex-direction:column;justify-content:center"><div class="mark" style="font-size:200px;height:90px">“</div><p class="q" style="font-size:${fs}px;max-width:${port?"none":"20ch"}">${esc(j.quote)}</p><div style="display:flex;align-items:center;gap:24px;margin-top:50px">${av}<div><div style="font-family:'Bricolage Grotesque';font-weight:700;font-size:40px">${esc(j.name||"")}</div><div class="p mute" style="font-size:30px">${esc(j.role||"")}</div></div></div></div>`+foot(!!j.testnet)},
ann(){const j=P.json;glow("82%","40%");const fs=j.headline.length<26?120:j.headline.length<44?96:76;
 const art=j.avatar?(j.avatar=="logo"?`<img src="assets/logo/blob-3d-1024.png" style="position:absolute;right:40px;top:200px;width:520px">`:`<div style="position:absolute;right:60px;top:170px">${bot(j.avatar,560)}</div>`):"";
 return top+`<div class="body" style="display:flex;flex-direction:column;justify-content:center"><div style="max-width:${art&&!port?"58%":"100%"}"><div class="kick">${esc((j.kicker||"").toUpperCase())}</div><h1 class="h" style="font-size:${fs}px;margin:20px 0 24px">${esc(j.headline)}</h1>${j.body?`<p class="p" style="font-size:36px">${esc(j.body)}</p>`:""}${(j.bullets||[]).length?`<ul class="bl">${j.bullets.map(b=>`<li>${esc(b)}</li>`).join("")}</ul>`:""}</div></div>${art}`+foot(!!j.testnet)}
};
c.innerHTML=T[P.type]();
document.fonts.ready.then(()=>Promise.all([...document.images].map(i=>i.complete?1:new Promise(r=>{i.onload=i.onerror=r})))).then(()=>{document.body.dataset.ready=1});
})();
