#!/usr/bin/env node
/* Frame-by-frame capture of motion.html (time is driven manually via setT, 30fps) -> ffmpeg MP4 (H.264 yuv420p) + GIF preview.
   node render-motion.js [filter]   e.g. node render-motion.js teaser */
const fs=require("fs"),path=require("path"),{execSync}=require("child_process");
const pp=require("/workspace/proto-tools/node_modules/puppeteer-core");
const SRC=__dirname,X=path.resolve(SRC,".."),FPS=30;
const JOBS=[
 ["motion/claw-loop-1600x900",{scene:"loop"},1600,900],["motion/claw-loop-1080x1080",{scene:"loop"},1080,1080],
 ["motion/logo-reveal-1600x900",{scene:"reveal"},1600,900],
 ["motion/teaser-1600x900",{scene:"teaser"},1600,900],["motion/teaser-1080x1350",{scene:"teaser"},1080,1350],
 ["diagram/mcp-diagram-pulse-1600x900",{scene:"diagram"},1600,900],["diagram/mcp-diagram-pulse-1080x1350",{scene:"diagram"},1080,1350]];
const STILLS=[["diagram/mcp-diagram-1600x900.png",1600,900],["diagram/mcp-diagram-1080x1350.png",1080,1350]];
(async()=>{const f=process.argv[2];fs.mkdirSync(path.join(X,"motion"),{recursive:true});fs.mkdirSync(path.join(X,"diagram"),{recursive:true});
 const br=await pp.launch({executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--allow-file-access-from-files"]});
 const open=async(p,w,h)=>{const pg=await br.newPage();await pg.setViewport({width:w,height:h});await pg.evaluateOnNewDocument(p=>{window.CARD=p},Object.assign({w,h},p));
  await pg.goto("file://"+path.join(SRC,"motion.html"));await pg.waitForSelector("body[data-ready]");return pg};
 for(const [o,w,h] of STILLS){if(f&&!o.includes(f))continue;const pg=await open({scene:"diagram",still:true},w,h);await pg.screenshot({path:path.join(X,o)});await pg.close();console.log(o)}
 for(const [o,p,w,h] of JOBS){if(f&&!o.includes(f))continue;const pg=await open(p,w,h);const dur=await pg.evaluate(()=>window.DUR),n=Math.round(dur*FPS);
  const tmp=fs.mkdtempSync("/tmp/scm-");
  for(let i=0;i<n;i++){await pg.evaluate(t=>window.setT(t),i/FPS);await pg.screenshot({path:`${tmp}/f${String(i).padStart(4,"0")}.png`})}
  await pg.close();const out=path.join(X,o);
  execSync(`ffmpeg -y -loglevel error -framerate ${FPS} -i ${tmp}/f%04d.png -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -profile:v high -movflags +faststart ${out}.mp4`);
  execSync(`ffmpeg -y -loglevel error -framerate ${FPS} -i ${tmp}/f%04d.png -vf "fps=15,scale=600:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" -loop 0 ${out}.gif`);
  fs.rmSync(tmp,{recursive:true});console.log(o,dur+"s",n+" frames")}
 await br.close()})();
