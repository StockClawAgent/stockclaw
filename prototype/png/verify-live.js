// Read-only live check of dashboard routes (no key issuance; agent key pool is limited).
const p=require('puppeteer-core');const OUT='/workspace/stockclaw/prototype/png/';const U='http://localhost:8787/';const errs=[],net=[];
const w=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const b=await p.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});const pg=await b.newPage();await pg.setCacheEnabled(false);
pg.on('response',r=>{if(r.url().includes('/api/')&&!r.ok())net.push(r.status()+' '+r.url())});pg.on('pageerror',e=>errs.push(e.message));
await pg.goto(U);const wal=await pg.evaluate(()=>fetch('/api/get_wallet').then(r=>r.json()));
await pg.evaluate(w=>localStorage.setItem('stockclaw-proto-v1',JSON.stringify({elig:'eligible',country:'Germany',np:true,attest:true,owner:w.owner,sa:w.address,key:w.sessionKey,funded:true,client:'Claude',connected:'Claude',dev:{}})),wal);
const go=async(h)=>{await pg.evaluate(h=>location.hash=h,h);await w(200);await pg.waitForNetworkIdle({idleTime:400,timeout:20000}).catch(()=>{});await w(200)};
for(const vp of [[1200,'L'],[390,'Lm']]){await pg.setViewport({width:vp[0],height:900});await pg.reload();
 for(const r of ['overview','orders','history','fees','key']){await go('#/dashboard/'+r);await pg.screenshot({path:`${OUT}${vp[1]}-D-${r}.png`,fullPage:true})}
 await go('#/onboarding/key');await pg.screenshot({path:`${OUT}${vp[1]}-O3.png`,fullPage:true})}
console.log('HTTP',net,'ERR',errs);await b.close()})();
