#!/usr/bin/env node
/* StockClaw X graphics renderer.
   node render.js                      -> rebuild data.js, render every card + contact-sheet.png
   node render.js agent                -> only outputs whose filename contains "agent"
   node render.js --tpl quote my.json [out.png]   -> render a template (quote|ann) from JSON */
const fs=require("fs"),path=require("path");
const pp=require("/workspace/proto-tools/node_modules/puppeteer-core");
const SRC=__dirname,OUT=path.resolve(SRC,".."),PROTO="/workspace/stockclaw/prototype";
// ---- data.js: content.json + baskets.json + ticker colors (same algorithm as prototype/landing.js) + eye positions (prototype/eyes.js)
function buildData(){
 const C=JSON.parse(fs.readFileSync(path.join(SRC,"content.json")));
 const B=JSON.parse(fs.readFileSync(path.join(PROTO,"data/baskets.json"))).baskets;
 const PAL=["#C6FF3D","#3DE0FF","#FF5FA2","#FFE14D","#A78BFA","#5AA9FF","#5EF2B8","#FF7AF5","#9DFF8A","#7DF9FF","#F5F5F5","#D4D4D4"];
 const nb={},ord=[];B.forEach(b=>{const s=b.tickers.map(t=>t.ticker);s.forEach(x=>{if(!nb[x]){nb[x]=new Set();ord.push(x)}s.forEach(y=>y!=x&&nb[x].add(y))})});
 ord.sort((a,b)=>(b=="NVDA")-(a=="NVDA")||nb[b].size-nb[a].size);const col={};
 for(const x of ord){const used=new Set([...nb[x]].map(y=>col[y]));col[x]=PAL.find(c=>!used.has(c))||PAL[ord.indexOf(x)%PAL.length]}
 const ej=fs.readFileSync(path.join(PROTO,"eyes.js"),"utf8");const eyes=Object.assign(eval("("+ej.match(/const EYES=(\{.*?\});/)[1]+")"),eval("("+ej.match(/Object\.assign\(EYES,(\{.*?\})\);/)[1]+")"));
 const D=Object.assign({},C,{baskets:B,colors:col,eyes});
 fs.writeFileSync(path.join(SRC,"data.js"),"window.SC_DATA="+JSON.stringify(D)+";\n");return D}
function jobs(D){const J=[],L=[1600,900],P=[1080,1350];
 D.agents.forEach((a,i)=>{J.push([`agent-${i+1}-${a.id}-1600x900.png`,{type:"agent",id:a.id},L]);J.push([`agent-${i+1}-${a.id}-1080x1350.png`,{type:"agent",id:a.id},P])});
 J.push(["agents-group-1600x900.png",{type:"group"},L],["agents-group-1080x1350.png",{type:"group"},P]);
 D.baskets.forEach(b=>{J.push([`basket-${b.id}-1600x900.png`,{type:"basket",id:b.id},L],[`basket-${b.id}-1080x1350.png`,{type:"basket",id:b.id},P])});
 J.push(["steps-1600x900.png",{type:"steps"},L],["steps-1080x1350.png",{type:"steps"},P]);
 D.countdown.forEach(k=>J.push([`countdown-${k.id}-1600x900.png`,{type:"count",id:k.id},L]));
 D.showcase.forEach(s=>J.push([`showcase-${s.id}-1600x900.png`,{type:"show",id:s.id},L]));
 J.push(["template-quote-example-1600x900.png",{type:"quote",json:JSON.parse(fs.readFileSync(path.join(SRC,"templates/quote.example.json")))},L]);
 J.push(["template-announcement-example-1600x900.png",{type:"ann",json:JSON.parse(fs.readFileSync(path.join(SRC,"templates/announcement.example.json")))},L]);
 return J}
async function shoot(br,P,w,h,out){const pg=await br.newPage();await pg.setViewport({width:w,height:h,deviceScaleFactor:1});
 await pg.evaluateOnNewDocument(p=>{window.CARD=p},Object.assign({w,h},P));
 const errs=[];pg.on("pageerror",e=>errs.push(e.message));
 await pg.goto("file://"+path.join(SRC,"card.html"));await pg.waitForSelector("body[data-ready]",{timeout:15000});
 await pg.screenshot({path:out,clip:{x:0,y:0,width:w,height:h}});await pg.close();if(errs.length)console.error(out,errs)}
async function sheet(br,files){const cells=files.map(f=>`<figure><img src="file://${path.join(OUT,f)}"><figcaption>${f}</figcaption></figure>`).join("");
 const pg=await br.newPage();await pg.setViewport({width:2400,height:1000});
 const html=`<style>@font-face{font-family:I;src:url(file://${SRC}/assets/fonts/inter-tight-latin.woff2)}body{margin:0;background:#141414;font:15px I;color:#bbb;padding:30px}h1{color:#C6FF3D;font-size:30px;margin:0 0 20px}div{display:grid;grid-template-columns:repeat(6,1fr);gap:22px;align-items:end}figure{margin:0}img{width:100%;display:block;border:1px solid #2a2a2a}figcaption{margin-top:6px;word-break:break-all}</style><h1>StockClaw · X graphics · ${files.length} files</h1><div>${cells}</div>`;fs.writeFileSync(path.join(SRC,"_sheet.html"),html);await pg.goto("file://"+path.join(SRC,"_sheet.html"),{waitUntil:"networkidle0"});
 await pg.screenshot({path:path.join(OUT,"contact-sheet.png"),fullPage:true});await pg.close()}
(async()=>{const D=buildData();const a=process.argv.slice(2);
 const br=await pp.launch({executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--allow-file-access-from-files"]});
 if(a[0]=="--tpl"){const j=JSON.parse(fs.readFileSync(a[2]));const [w,h]=(j.size||"1600x900").split("x").map(Number);const out=path.resolve(a[3]||path.join(OUT,`template-${a[1]}-custom.png`));await shoot(br,{type:a[1]=="announcement"?"ann":a[1],json:j},w,h,out);console.log(out);return br.close()}
 const J=a[0]=="--sheet"?[]:jobs(D).filter(j=>!a[0]||j[0].includes(a[0]));
 for(const [f,P,[w,h]] of J){await shoot(br,P,w,h,path.join(OUT,f));console.log(f)}
 if(!a[0]||a[0]=="--sheet"){const ex=["diagram","motion"].flatMap(d=>fs.existsSync(path.join(OUT,d))?fs.readdirSync(path.join(OUT,d)).filter(f=>/\.(png|gif)$/.test(f)&&f!="preview.png").map(f=>d+"/"+f):[]);await sheet(br,jobs(D).map(j=>j[0]).concat(ex))}await br.close()})();
