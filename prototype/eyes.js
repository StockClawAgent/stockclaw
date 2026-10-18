/* Shared bot avatar with animated eyes (landing lineup + dashboard). No libraries.
   SCEyes.html(id,name,size) -> markup; SCEyes.init(root) -> starts tracking/idle loop for [data-bot] inside root.
   Fine pointer: eyes follow the cursor anywhere (eased, clamped); after ~2.5s still, or on touch, idle glance + blink.
   Pauses when hidden/off-screen; prefers-reduced-motion = static. */
(function(){
const EYES={"steady-stacker":[[37.89,51.95,6.64,9.38],[61.52,51.95,6.64,8.98]],"dip-hunter":[[37.79,58.69,9.96,8.4,"l"],[62.4,58.69,9.96,8.4,"r"]],"trend-flip":[[46.88,63.48,5.47,7.03],[63.38,59.86,5.27,6.84]],"ai-thematic":[[40.92,53.52,5.27,7.03],[58.59,53.52,5.08,7.03]],"weekend-edge":[[38.67,55.18,8.59,9.18],[63.48,55.08,8.98,8.98]]};
Object.assign(EYES,{"basket-ai": [[42.4, 51.6, 7.6, 6.4], [62.0, 50.0, 6.8, 6.0]], "basket-chips": [[37.79, 46.78, 7.2, 10.0], [57.52, 46.88, 7.2, 10.2]], "basket-power": [[37.7, 46.39, 6.3, 7.7], [56.84, 46.58, 6.3, 7.7]], "basket-defense": [[40.82, 45.7, 5.6, 8.3], [60.6, 45.61, 5.0, 8.1]], "basket-space": [[42.58, 50.1, 5.1, 8.0], [57.42, 50.1, 5.1, 8.0]], "basket-quantum": [[37.7, 51.86, 9.4, 13.8], [59.38, 51.66, 9.4, 12.8]], "basket-cyber": [[35.06, 46.88, 6.9, 8.2], [59.28, 47.27, 7.2, 7.9]]});
const ALIAS={"momentum-rider":"trend-flip","ema-vwap-flip":"trend-flip","monday-planner":"weekend-edge"};
const html=(id,name,size,cls="")=>{id=ALIAS[id]||id;if(!EYES[id])id="steady-stacker";return `<div class="lp-bot ${cls}" data-bot style="width:${size}px;height:${size}px"><img src="avatars/eyeless-${id}-transparent.png" width="${size}" height="${size}" alt="${name} mascot">${EYES[id].map(([x,y,w,h,a])=>`<span class="lp-eye ${a?"ang-"+a:""}" aria-hidden="true" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"></span>`).join("")}</div>`};
const RM=matchMedia("(prefers-reduced-motion: reduce)"),FINE=matchMedia("(hover: hover) and (pointer: fine)");
let mx=0,my=0,lastMove=-1e9,raf=0,vis=true,bots=[],io=null;const rnd=(a,b)=>a+Math.random()*(b-a);
addEventListener("pointermove",e=>{if(e.pointerType==="mouse"||FINE.matches){mx=e.clientX;my=e.clientY;lastMove=performance.now();wake()}},{passive:true});
function init(root){cancelAnimationFrame(raf);raf=0;io&&io.disconnect();if(!root)return;const now=performance.now();
 bots=[...root.querySelectorAll("[data-bot]")].map((el,i)=>({el,cx:0,cy:0,tx:0,ty:0,nextGlance:now+rnd(400,2500)+i*300,nextBlink:now+rnd(1500,5000)}));
 if(RM.matches||!bots.length)return;io=new IntersectionObserver(es=>{vis=es.some(e=>e.isIntersecting);root.classList.toggle("lp-off",!vis);wake()});io.observe(root);wake()}
function wake(){if(!raf&&vis&&!document.hidden&&!RM.matches&&bots.length&&bots[0].el.isConnected)raf=requestAnimationFrame(tick)}
document.addEventListener("visibilitychange",wake);
function tick(t){raf=0;if(!vis||document.hidden||!bots[0]?.el.isConnected)return;const track=FINE.matches&&t-lastMove<2500;
 for(const b of bots){const r=b.el.getBoundingClientRect(),mX=r.width*.045,mY=r.height*.03;
  if(track){const dx=mx-(r.left+r.width/2),dy=my-(r.top+r.height*.55),d=Math.hypot(dx,dy)||1,k=Math.min(1,d/220);b.tx=dx/d*k*mX;b.ty=dy/d*k*mY}
  else if(t>b.nextGlance){const look=Math.random();b.tx=look<.35?0:(Math.random()<.5?-1:1)*rnd(.5,1)*mX;b.ty=rnd(-.4,.6)*mY;b.nextGlance=t+rnd(1400,4800)}
  b.cx+=(b.tx-b.cx)*(track?.16:.09);b.cy+=(b.ty-b.cy)*(track?.16:.09);
  if(t>b.nextBlink){b.el.classList.add("blink");setTimeout(()=>b.el.classList.remove("blink"),130);b.nextBlink=t+(Math.random()<.15?180:rnd(2500,7000))}
  b.el.style.setProperty("--ex",b.cx.toFixed(2)+"px");b.el.style.setProperty("--ey",b.cy.toFixed(2)+"px")}
 raf=requestAnimationFrame(tick)}
window.SCEyes={html,init};
})();
