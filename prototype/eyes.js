/* Shared agent avatar markup. Larvas ship with eyes painted in; no overlay.
   SCEyes.html(id,name,size,cls) -> markup; SCEyes.init(root) -> gentle bob (no eye tracking). */
(function(){
const ALIAS={"momentum-rider":"trend-flip","ema-vwap-flip":"trend-flip","monday-planner":"weekend-edge"};
const LARVA=new Set(["steady-stacker","dip-hunter","trend-flip","ai-thematic","weekend-edge"]);
const TINT={"steady-stacker":"#CFE6C8","dip-hunter":"#FFD3C2","trend-flip":"#CFE4F5","ai-thematic":"#E3D9F5","weekend-edge":"#F8D3DF"};
const src=(id)=>LARVA.has(id)?`avatars/${id}-512-transparent.webp`:`avatars/eyeless-${id}-transparent.png`;
const html=(id,name,size,cls="")=>{
 id=ALIAS[id]||id;
 if(!LARVA.has(id)&&!String(id).startsWith("basket-"))id="steady-stacker";
 const tint=TINT[id];
 const arch=tint?` style="--arch:${tint};width:${size}px;height:${size}px"`:` style="width:${size}px;height:${size}px"`;
 return `<div class="lp-bot ${cls}${tint?" has-arch":""}" data-bot${arch}><picture><source type="image/webp" srcset="${LARVA.has(id)?`avatars/${id}-512-transparent.webp`:""}"><img src="${LARVA.has(id)?`avatars/${id}-512-transparent.png`:`avatars/eyeless-${id}-transparent.png`}" width="${size}" height="${size}" alt="${name?name+" mascot":""}" loading="lazy" decoding="async"></picture></div>`;
};
const RM=matchMedia("(prefers-reduced-motion: reduce)");
function init(root){if(!root)return;root.classList.toggle("lp-off",RM.matches)}
window.SCEyes={html,init,TINT,LARVA};
})();
