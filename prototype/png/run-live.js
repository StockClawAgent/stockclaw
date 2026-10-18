const p=require('puppeteer-core');const OUT='/workspace/stockclaw/prototype/png/';const U='http://localhost:8787/';
const errs=[];const net=[];const w=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const b=await p.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});const pg=await b.newPage();await pg.setCacheEnabled(false);
await pg.setViewport({width:1200,height:900});pg.on('response',r=>{if(r.url().includes('/api/')&&!r.ok())net.push(r.status()+' '+r.request().method()+' '+r.url().replace(U,''))});pg.on('pageerror',e=>errs.push(e.message));pg.on('console',m=>m.type()=='error'&&errs.push(m.text()));
const shot=async(n)=>{await w(250);await pg.screenshot({path:OUT+n+'.png',fullPage:true});console.log('shot',n)};
const go=async(h)=>{await pg.evaluate(h=>location.hash=h,h);await w(150);await pg.waitForNetworkIdle({idleTime:400,timeout:30000}).catch(()=>{});await w(150)};
const click=async(s)=>{await pg.click(s);await w(150);await pg.waitForNetworkIdle({idleTime:400,timeout:30000}).catch(()=>{});await w(150)};
await pg.goto(U);await pg.evaluate(()=>localStorage.clear());await pg.goto(U+'#/');await w(300);await shot('01-landing');
await click('a.btn[href="#/onboarding/eligibility"]');await shot('02-O1-empty');
// dev states
for(const v of ['blocked','geo','pending']){await pg.click(`[name=dev][value=${v}]`);await pg.select('#cty','Germany');await pg.evaluate(()=>{const c=document.querySelector('#np');c.checked=true});await click('#ef > button');await shot('03-O1-'+v);}
await pg.click('[name=dev][value=auto]');await pg.select('#cty','United States');await pg.evaluate(()=>{const c=document.querySelector('#np');c.checked=true});await click('#ef > button');await shot('03-O1-auto-US-blocked');
await pg.select('#cty','Germany');await pg.evaluate(()=>{const c=document.querySelector('#np');c.checked=true});await click('#ef > button');await shot('03-O1-eligible');
await click('a.btn[href="#/onboarding/wallet"]');await shot('04-O2-start');
await click('#cw');await click('#sg');await click('#cs');await shot('05-O2-done');
await click('a.btn[href="#/onboarding/key"]');await shot('06-O3-form');
await pg.click('#pt',{clickCount:3});await pg.type('#pt','900');await click('#kf > button');await shot('07-O3-validation');
await pg.click('#pt',{clickCount:3});await pg.type('#pt','100');await click('#kf > button');await shot('08-O3-created');
await click('a.btn[href="#/onboarding/faucet"]');await shot('09-O4-start');
await click('#cl');await shot('10-O4-waiting');await w(1400);await shot('11-O4-funded');
await click('a.btn[href="#/onboarding/client"]');await shot('12-O5-claude');
await click('[data-cl=Cursor]');await shot('13-O5-cursor');await click('#oa');await w(1200);await shot('14-O5-connected');
console.log('SEED',JSON.stringify(await pg.evaluate(async()=>{const o=[];for(const [n,a] of [['create_dca',{tokenIn:'mUSDG',tokenOut:'TSLA',amountPerExec:10,interval:'daily',maxExecs:5}],['create_limit_order',{tokenIn:'mUSDG',tokenOut:'AMD',amountIn:25,limitPrice:1}],['execute_swap',{tokenIn:'mUSDG',tokenOut:'TSLA',amountIn:10}]]){try{o.push([n,await api[n](a)])}catch(e){o.push([n,'FAIL '+e.status+' '+e.message])}}return o})));
await click('a.btn[href="#/dashboard/overview"]');await w(2100);await shot('15-D1-overview');
await click('#rf');await shot('16-D1-refreshed');
await go('#/dashboard/orders');await shot('17-D2-orders');
await click('[data-cancel]:last-of-type');await shot('18-D2-cancel-confirm');await click('#dy');await shot('19-D2-cancelling');await w(1000);await shot('20-D2-cancelled');
await go('#/dashboard/history');await shot('21-D3-history');
await go('#/dashboard/fees');await shot('22-D4-fees');
await go('#/dashboard/key');await shot('23-D5-key');
await pg.click('#pt',{clickCount:3});await pg.type('#pt','80');await pg.click('#dc',{clickCount:3});await pg.type('#dc','400');await click('#lf > button');await shot('24-D5-stage1');await w(900);await shot('25-D5-stage2');await w(2000);await shot('26-D5-done');
await pg.click('#pz');await w(300);await shot('27-D5-pause-confirm');
const f=await pg.evaluate(()=>document.activeElement.id);console.log('focus in dialog:',f);
await pg.keyboard.press('Escape');await w(200);await click('#pz');await click('#dy');await w(200);await shot('28-D5-paused');
await click('#pz');await shot('29-D5-resume-confirm');await click('#dy');await w(200);await shot('30-D5-resumed');
await click('#rv');await shot('31-D5-revoke-confirm');await click('#dy');await w(200);await shot('32-D5-revoked');
await go('#/dashboard/overview');await shot('33-D1-revoked-banner');
// keyboard focus check
await go('#/');await pg.keyboard.press('Tab');await pg.keyboard.press('Tab');await pg.keyboard.press('Tab');await shot('34-focus-visible');
// deep-link reload persistence
await pg.goto(U+'#/dashboard/key');await w(400);await shot('35-deeplink-reload-key');

const dev=async(k,on)=>{await pg.evaluate((k,on)=>{const c=document.querySelector(`[data-dev="${k}"]`);if(c.checked!==on)c.click()},k,on);await w(250)};
// ---- error states ----
await pg.evaluate(()=>localStorage.clear());await pg.goto(U+'#/onboarding/eligibility');await pg.reload();await w(400);
await pg.select('#cty','Germany');await pg.click('#np');await click('#ef > button');await go('#/onboarding/wallet');
await dev('wrongnet',true);await dev('walletfail',true);await click('#cw');await shot('40-ERR-O2-wrong-network');
await click('#sw');await click('#sg');await click('#cs');await w(600);await shot('41-ERR-O2-wallet-fail');
await dev('walletfail',false);await click('#cs');await go('#/onboarding/key');await click('#kf > button');await go('#/onboarding/faucet');
await dev('ratelimit',true);await click('#cl');await w(1400);await shot('42-ERR-O4-rate-limit');await dev('ratelimit',false);await click('#cl');await w(1400);
await go('#/onboarding/client');await dev('oauthdeny',true);await click('#oa');await w(1200);await shot('43-ERR-O5-oauth-denied');await dev('oauthdeny',false);await click('#oa');await w(1200);
await go('#/dashboard/key');await dev('limitsfail',true);await pg.click('#pt',{clickCount:3});await pg.type('#pt','90');await click('#lf > button');await w(1000);await shot('44-ERR-D5-limits-tx-failed');
await dev('limitsfail',false);await dev('service',true);await go('#/dashboard/overview');await shot('45-ERR-D1-service-issue');await dev('service',false);
// FAQ open
await go('#/');await pg.evaluate(()=>document.querySelectorAll('details').forEach(d=>d.open=true));await shot('46-landing-faq-open');
// ---- 390px pass: every route ----
await pg.setViewport({width:390,height:844,deviceScaleFactor:1});
for(const [n,h] of [['m01-landing','#/'],['m02-O1','#/onboarding/eligibility'],['m03-O2','#/onboarding/wallet'],['m04-O3','#/onboarding/key'],['m05-O4','#/onboarding/faucet'],['m06-O5','#/onboarding/client'],['m07-D1','#/dashboard/overview'],['m08-D2','#/dashboard/orders'],['m09-D3','#/dashboard/history'],['m10-D4','#/dashboard/fees'],['m11-D5','#/dashboard/key']]){await go(h);
 const ov=await pg.evaluate(()=>document.documentElement.scrollWidth);if(ov>390)console.log('OVERFLOW',n,ov);await shot(n)}
await go('#/dashboard/key');await click('#rv');await shot('m12-D5-dialog');await pg.keyboard.press('Escape');
console.log('APIFAILS',JSON.stringify(await pg.evaluate(()=>window.__apiFails)));console.log('HTTPFAILS',JSON.stringify(net,null,1));console.log('ERRORS',JSON.stringify(errs));await b.close()})().catch(e=>{console.error('FAIL',e);process.exit(1)});
