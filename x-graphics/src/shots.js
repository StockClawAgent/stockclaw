#!/usr/bin/env node
/* Fresh prototype screenshots for the showcase cards (capture-only CSS/text tweaks, app untouched).
   Needs the prototype server on :8787. Uses ?mock=1 (no tokens are ever shown or stored here). Output: assets/shots/*.png (780x1688, 390x844 @2x) */
const pp=require("/workspace/proto-tools/node_modules/puppeteer-core"),path=require("path");
const OUT=path.join(__dirname,"assets/shots"),w=ms=>new Promise(r=>setTimeout(r,ms));
const CSS=`.tnbar,.lp-chips,.lp-tickers{display:none!important}`;
const clean=()=>{const tw=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=tw.nextNode()){const v=n.nodeValue;const r=v.replace(/,\s*testnet\)/gi,")").replace(/\s*\(testnet\)/gi,"").replace(/testnet demo/gi,m=>m[0]=="T"?"DEMO":"demo");if(r!=v)n.nodeValue=r}
 const tw2=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let m;while(m=tw2.nextNode()){if(/TSLA/.test(m.nodeValue)){const r=m.parentElement.getBoundingClientRect();if(r.bottom>0&&r.top<innerHeight&&r.width)console.log("WARN TSLA in viewport")}}};
(async()=>{const b=await pp.launch({executablePath:"/usr/bin/google-chrome",args:["--no-sandbox"]});const pg=await b.newPage();
 pg.on("console",m=>/WARN/.test(m.text())&&console.log(m.text()));
 await pg.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
 const shot=async f=>{await pg.addStyleTag({content:CSS});await pg.evaluate(clean);await w(300);await pg.screenshot({path:path.join(OUT,f)});console.log(f)};
 const tap=async s=>{await pg.evaluate(s=>document.querySelector(s)?.scrollIntoView({block:"center"}),s);await w(400);const r=await pg.evaluate(s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return[b.x+b.width/2,b.y+b.height/2]},s);if(!r)return false;await pg.touchscreen.tap(r[0],r[1]);return true};
 const dock=async()=>{await w(250);await tap(".sc-dock:not([disabled])")};
 await pg.goto("http://localhost:8787/?mock=1#/");await pg.evaluate(()=>localStorage.clear());await pg.reload();await w(3500);await shot("x-landing.png");await pg.setViewport({width:1440,height:900,deviceScaleFactor:1});await w(1500);await shot("x-landing-1440.png");await pg.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});await w(1200);
 await pg.evaluate(()=>location.hash="#/onboarding/eligibility");await w(900);
 await pg.evaluate(()=>{const s=document.getElementById("cty");s.value=s.options[2].value;document.getElementById("np").checked=true});await w(300);await dock();await w(1100);await dock();await w(1100);
 await dock();await w(1500);await dock();await w(1100);await dock();await w(1900);await dock();await w(1100);await dock();await w(1700);await dock();await w(1100);
 await tap("#oa");await w(1600);
 await pg.evaluate(()=>location.hash="#/dashboard/overview");await w(2500);
 await pg.evaluate(()=>{const a=document.getElementById("bkAmt");a.value=250;a.dispatchEvent(new Event("input",{bubbles:true}))});await w(200);
 await tap("#bkGo");await w(6500);await pg.evaluate(()=>scrollTo(0,0));await shot("x-basket.png");await w(6000);
 await dock();await w(2500);await pg.screenshot({path:"/tmp/homefull.png",fullPage:true});await pg.evaluate(()=>{const h=[...document.querySelectorAll("h2,h3")].find(e=>e.textContent.trim()=="Limits");scrollTo(0,h.getBoundingClientRect().top+scrollY-40)});await w(500);await shot("x-home.png");
 await pg.evaluate(()=>document.querySelector("[data-ap]")?.scrollIntoView({block:"center"}));await w(600);await shot("x-approve.png");
 await b.close()})();
