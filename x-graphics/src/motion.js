/* Deterministic motion scenes. Params (window.CARD or query): scene=loop|reveal|teaser|diagram, w, h, still=1 (diagram without pulses).
   window.DUR = seconds; window.setT(t) draws the frame for time t. render-motion.js steps t at 30fps and screenshots. */
(function(){
const D=window.SC_DATA,q=new URLSearchParams(location.search);
const P=Object.assign({scene:q.get("scene")||"loop",w:+(q.get("w")||1600),h:+(q.get("h")||900),still:q.get("still")=="1"},window.CARD||{});
const W=P.w,H=P.h,port=H>W,sq=H==W,k=(port||sq)?W/1080:H/900,c=document.getElementById("c");
c.style.setProperty("--w",W+"px");c.style.setProperty("--h",H+"px");c.style.setProperty("--pad",(port?80:96)+"px");c.style.setProperty("--gx","50%");c.style.setProperty("--gy","55%");
const cl=(x,a=0,b=1)=>Math.max(a,Math.min(b,x)),seg=(t,a,b)=>cl((t-a)/(b-a)),oc=x=>1-Math.pow(1-x,3),io=x=>x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2,
 back=x=>{const s=1.25;return 1+(s+1)*Math.pow(x-1,3)+s*Math.pow(x-1,2)},bump=(t,a,b)=>{const p=seg(t,a,b);return p>0&&p<1?Math.pow(Math.sin(Math.PI*p),2):0},
 blinkAt=(t,ts)=>Math.max(0,...ts.map(b=>1-Math.abs(t-b)/.09));
const h=(s)=>{const d=document.createElement("div");d.innerHTML=s.trim();return d.firstChild};
const bot=(id,size)=>{const e=D.eyes[id]||[];return `<div class="bot" style="width:${size}px;height:${size}px"><img src="assets/avatars/eyeless-${id}-transparent.png">${e.map(([x,y,w,hh,a])=>`<span class="eye ${a?"ang-"+a:""}" style="left:${x}%;top:${y}%;width:${w}%;height:${hh}%"></span>`).join("")}</div>`};
// hero blob: eyeless 3D render + white pill eyes (positions from prototype hero)
function blob(wd){const el=h(`<div class="hb" style="width:${wd}px"><img src="assets/logo/blob-3d-eyeless-1024.png"><span class="eye" style="left:34.46%"></span><span class="eye" style="left:59.15%"></span></div>`);
 const eyes=[...el.querySelectorAll(".eye")];
 el.set=({y=0,sx=1,sy=1,skew=0,ex=0,ey=0,bl=0,s=1,op=1}={})=>{el.style.transformOrigin="30% 100%";el.style.opacity=op;
  el.style.transform=`translateY(${y}px) scale(${s}) skewX(${skew}deg) scale(${sx},${sy})`;
  eyes.forEach(e=>e.style.transform=`translate(-50%,-50%) translate(${ex*wd*.0868}px,${ey*wd*.1378*.7}px) scaleY(${1-.9*bl})`)};
 return el}
const wm=(wd)=>`<img class="wm" src="assets/logo/blob-wordmark.svg" style="width:${wd}px">`;
const GL=[[0,0,0],[1.0,0,0],[1.35,-.32,0],[2.9,-.32,0],[3.25,.32,-.12],[4.7,.32,-.12],[5.05,0,.18],[6.7,0,.18],[7.05,0,0],[99,0,0]];
const glance=t=>{for(let i=0;i<GL.length-1;i++){const[a,x0,y0]=GL[i],[b,x1,y1]=GL[i+1];if(t<=b){const p=io(cl((t-a)/(b-a)));return[x0+(x1-x0)*p,y0+(y1-y0)*p]}}return[0,0]};
const S={
loop(){window.DUR=10;const bw=(sq?600:560)*k;const L=h(`<div class="lay"><div class="shadow" style="bottom:${sq?250*k:205*k}px;width:${bw*.8}px;height:${60*k}px"></div></div>`);const b=blob(bw);L.appendChild(b);
 L.appendChild(h(`<div style="margin-top:${50*k}px">${wm(sq?520*k:460*k)}</div>`));L.appendChild(h(`<div class="handle" style="margin-top:${22*k}px">${D.handle}</div>`));c.appendChild(L);
 const sh=L.querySelector(".shadow");
 return t=>{const ph=2*Math.PI*t/2.5,f=bump(t,3.6,4.5)+bump(t,7.9,8.8);const[ex,ey]=glance(t);
  b.set({y:-8*k*(1+Math.sin(ph))/2*2,sx:1+.012*Math.sin(ph),sy:1-.012*Math.sin(ph)+.035*f,skew:-3.2*f,ex,ey,bl:blinkAt(t,[1.8,5.6,5.85,9.2])});
  sh.style.opacity=.75+.25*(1-(1+Math.sin(ph))/2)}},
reveal(){window.DUR=6;const bw=440*k;const L=h(`<div class="lay"></div>`);const sl=h(`<div class="slash"></div>`);c.appendChild(sl);
 const b=blob(bw);L.appendChild(b);const w=h(`<div style="margin-top:${40*k}px">${wm(560*k)}</div>`),hd=h(`<div class="handle" style="margin-top:${24*k}px">${D.handle}</div>`);L.appendChild(w);L.appendChild(hd);c.appendChild(L);
 const len=760*k;Object.assign(sl.style,{left:(W/2-len/2)+"px",top:(H*.42)+"px",width:len+"px"});
 return t0=>{const t=t0<1/60?6:t0; // frame 0 = final lockup (thumbnail), then the reveal plays
  const d=oc(seg(t,.35,.95)),o=1-seg(t,1.05,1.4);sl.style.opacity=t<.35?0:o;sl.style.transform=`rotate(-18deg) scaleX(${d})`;
  const p=seg(t,1.0,1.55),s=p<=0?0:back(p),sq2=Math.sin(seg(t,1.25,1.9)*Math.PI*2)*Math.exp(-3*seg(t,1.25,1.9))*.09;
  const op=Math.min(1,(1-Math.pow(1-seg(t,2.0,2.15),2))) ;
  b.set({s,sx:1+sq2,sy:1-sq2,bl:t<1.95?1:1-op+blinkAt(t,[4.7]),op:p>0?1:0,ex:t>3.5?.15*io(seg(t,3.5,3.9)):0});
  const wp=oc(seg(t,2.4,3.1));w.style.opacity=wp;w.style.transform=`translateY(${(1-wp)*30*k}px)`;
  const hp=oc(seg(t,3.3,3.8));hd.style.opacity=hp;hd.style.transform=`translateY(${(1-hp)*14*k}px)`}},
teaser(){window.DUR=14;const fs=(port?96:112)*k;const X=[];
 const add=(html,a,b)=>{const L=h(`<div class="lay">${html}</div>`);c.appendChild(L);X.push([L,a,b]);return L};
 const s1=add(`<h1 class="h" style="font-size:${fs}px">pick an agent.</h1><div style="display:flex;gap:${(port?6:20)*k}px;margin-top:${50*k}px;${port?"flex-wrap:wrap;justify-content:center;max-width:"+900*k+"px":""}">${D.agents.map(a=>`<div class="tb">${bot(a.id,(port?280:250)*k)}</div>`).join("")}</div>`,0,3);
 const s2=add(`<h1 class="h" style="font-size:${fs}px">bring your AI.</h1><div style="display:flex;${port?"flex-direction:column;gap:"+18*k+"px":"gap:"+60*k+"px"};margin-top:${60*k}px">${["Claude","ChatGPT","Grok","Cursor"].map(n=>`<span class="ai tw" style="font-size:${64*k}px">${n}</span>`).join("")}</div>`,3,5.5);
 const b=D.baskets.find(x=>x.id=="ai"),t=[...b.tickers].sort((x,y)=>y.weightPct-x.weightPct),R=200,C=2*Math.PI*R,G=6;let acc=0;
 const segs=t.map(x=>{const len=x.weightPct/100*C-G,rot=acc/C*360-90;acc+=x.weightPct/100*C;return `<circle r="${R}" cx="250" cy="250" fill="none" stroke="${D.colors[x.ticker]}" stroke-width="78" stroke-dasharray="0 ${C}" data-len="${len}" transform="rotate(${rot} 250 250)"/>`}).join("");
 const DS=(port?560:480)*k;
 const s3=add(`<div style="position:relative;width:${DS}px;height:${DS}px"><svg viewBox="0 0 500 500" style="width:100%;height:100%"><circle r="${R}" cx="250" cy="250" fill="none" stroke="#151515" stroke-width="94"/>${segs}</svg><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${bot("basket-ai",DS*.42)}</div></div><h1 class="h" style="font-size:${fs*.8}px;margin-top:${40*k}px">watch it trade.</h1><div class="tag" style="margin-top:${24*k}px">AI basket</div>`,5.5,9.5);
 const s4=add(`<h1 class="h" style="font-size:${fs*.75}px;color:var(--mute)">within your limits.</h1><div style="margin-top:${36*k}px">${["$100 a trade.","$500 of buys a day.","revoke anytime."].map(x=>`<div class="h tl" style="font-size:${fs}px;color:var(--lime);margin-top:${10*k}px">${x}</div>`).join("")}</div>`,9.5,11.6);
 const bl=blob(300*k);const s5=add(``,11.6,14.01);s5.appendChild(bl);s5.appendChild(h(`<div class="big" style="color:var(--lime);font-size:${(port?190:200)*k}px;margin-top:${30*k}px">Fri 10/23</div>`));s5.appendChild(h(`<div class="p" style="font-size:${44*k}px;margin-top:${20*k}px">11 AM ET</div>`));s5.appendChild(h(`<div style="margin-top:${36*k}px;opacity:.9">${wm(300*k)}</div>`));
 const tbs=[...s1.querySelectorAll(".tb")],tws=[...s2.querySelectorAll(".tw")],cs=[...s3.querySelectorAll("circle[data-len]")],tls=[...s4.querySelectorAll(".tl")];
 return T=>{X.forEach(([L,a,b])=>{const vin=a==0?1:oc(seg(T,a,a+.22)),vout=b>14?1:1-seg(T,b-.12,b);const v=Math.min(vin,vout);L.style.opacity=v;L.style.transform=`scale(${.985+.015*vin})`;L.style.visibility=v>0?"visible":"hidden"});
  tbs.forEach((e,i)=>{const p=bump(T,.25+i*.18,.85+i*.18);e.style.transform=`translateY(${-24*k*p}px)`});
  tws.forEach((e,i)=>{const p=oc(seg(T,3.25+i*.22,3.6+i*.22));e.style.opacity=p;e.style.transform=`translateY(${(1-p)*20*k}px)`;e.style.color=p>=1&&T>4.6?"var(--ink)":"var(--ink)"});
  cs.forEach((e,i)=>{const p=io(seg(T,5.9+i*.38,6.35+i*.38));e.setAttribute("stroke-dasharray",`${(+e.dataset.len*p).toFixed(2)} ${C}`)});
  tls.forEach((e,i)=>{const p=oc(seg(T,9.85+i*.35,10.25+i*.35));e.style.opacity=p;e.style.transform=`translateX(${(1-p)*-30*k}px)`});
  const p5=seg(T,11.6,12.2);bl.set({s:p5<=0?0:back(p5),bl:blinkAt(T,[13.2]),ex:0})}},
diagram(){window.DUR=4;const L=[];const ais=["Claude","ChatGPT","Grok","Cursor"];
 // layout boxes in px
 let A,B,Cc,headY;
 if(!port){headY=165;A=ais.map((n,i)=>({x:170,y:400+i*105}));B={x:800,y:560,w:280};Cc={x:1290,y:560}}else{headY=165;A=ais.map((n,i)=>({x:150+i*260,y:470}));B={x:540,y:770,w:300};Cc={x:540,y:1110}}
 const hd=`<h1 class="h" style="position:absolute;left:var(--pad);top:${headY}px;font-size:${port?88:76}px;text-align:left">Every AI speaks MCP.<br><em>We gave it a claw.</em></h1>`;
 let paths=[];
 if(!port){A.forEach(a=>paths.push(`M${a.x+150} ${a.y} C ${a.x+330} ${a.y}, ${B.x-280} ${B.y}, ${B.x-170} ${B.y}`));paths.push(`M${B.x+170} ${B.y} L ${Cc.x-150} ${Cc.y}`)}
 else{A.forEach(a=>paths.push(`M${a.x} ${a.y+40} C ${a.x} ${a.y+150}, ${B.x} ${B.y-250}, ${B.x} ${B.y-120}`));paths.push(`M${B.x} ${B.y+235} L ${Cc.x} ${Cc.y-70}`)}
 const svg=`<svg width="${W}" height="${H}" style="position:absolute;inset:0">${paths.map((d,i)=>`<path d="${d}" fill="none" stroke="${i<4?"#3a3a3a":"#C6FF3D"}" stroke-width="3" ${i<4?"":'stroke-dasharray="2 12" stroke-linecap="round"'}/>`).join("")}${paths.map(()=>`<circle r="7" fill="#C6FF3D" style="filter:drop-shadow(0 0 10px #C6FF3D)" opacity="0"/>`).join("")}</svg>`;
 const lab=(x,y,html,al="center")=>`<div style="position:absolute;left:${x}px;top:${y}px;transform:translate(${al=="left"?"0":"-50%"},-50%)">${html}</div>`;
 const aiH=A.map((a,i)=>lab(port?a.x:a.x,a.y,`<span class="ai" style="font-size:${port?48:56}px">${ais[i]}</span>`,port?"center":"center")).join("");
 const shield=`<svg width="26" height="30" viewBox="0 0 26 30"><path d="M13 2 L23 6 V14 C23 21 18 26 13 28 C8 26 3 21 3 14 V6 Z" fill="none" stroke="#C6FF3D" stroke-width="2.5"/></svg>`;
 const blobH=lab(B.x,B.y-10,`<div class="hb" style="width:${B.w}px"><img src="assets/logo/blob-3d-1024.png"></div>`)+lab(B.x,B.y+(port?150:140),`<div class="dlabel">MCP connector</div>`)+lab(B.x,B.y+(port?200:190),`<div class="leash">${shield}<span>$100 a trade · $500 of buys a day · revoke anytime</span></div>`);
 const ch=lab(Cc.x,Cc.y,`<div class="chain"><b>Robinhood Chain</b></div>`);
 c.innerHTML=`<div class="top"><img class="m" src="assets/logo/blob-3d-512.png"><img class="w" src="assets/logo/blob-wordmark.svg"></div>${hd}${svg}${aiH}${blobH}${ch}<div class="foot"><span>${D.handle}</span><span></span></div>`;
 const P_=[...c.querySelectorAll("path")],dots=[...c.querySelectorAll("circle")];
 return t=>{if(P.still)return;dots.forEach((d,i)=>{const per=2,off=i<4?i*.12:1.0,p=(((t-off)/per)%1+1)%1,L=P_[i].getTotalLength(),pt=P_[i].getPointAtLength(L*io(p));
  d.setAttribute("cx",pt.x);d.setAttribute("cy",pt.y);d.setAttribute("opacity",Math.sin(Math.PI*p).toFixed(3))})}}
};
const draw=S[P.scene]();window.setT=t=>draw(t);
document.fonts.ready.then(()=>Promise.all([...document.images].map(i=>i.complete?1:new Promise(r=>{i.onload=i.onerror=r})))).then(()=>{draw(0);document.body.dataset.ready=1});
})();
