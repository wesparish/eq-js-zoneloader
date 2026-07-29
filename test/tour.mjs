import { drive } from '/home/wes/workspace/eq-js-zoneloader/test/cdp.mjs';
// Place the camera on the ground at an EQ (x,y) and look along `yaw`.
const at = (x,y,yaw,pitch=-0.08) => `(()=>{const c=eq.collision;const gx=${x},gz=${-y};
  let best=null; for(let s=0;s<600;s+=4){const h=c.floorAt(gx,700-s,gz); if(h!==null){best=h;break;}}
  eq.state.pos=[gx,(best??20)+3,gz]; eq.state.vel=[0,0,0];
  eq.state.yaw=${yaw}; eq.state.pitch=${pitch}; eq.state.noclip=false;
  document.getElementById('help').classList.add('hidden'); return true;})()`;
const r = await drive({
  url: 'http://localhost:8731/index.html',
  readyExpr: 'document.getElementById("loader").style.display === "none"',
  before: 'document.getElementById("help").classList.add("hidden"); true',
  screenshot: '/tmp/tour0.png',
  shots: [
    { expr: at(-155, -30, 1.6), path: '/tmp/tour1.png' },
    { expr: at(0, 0, 0.0), path: '/tmp/tour2.png' },
    { expr: at(-160, 327, 2.4), path: '/tmp/tour3.png' },
    { expr: at(208, -104, 3.6), path: '/tmp/tour4.png' },
    { expr: at(42, -39, 5.0), path: '/tmp/tour5.png' },
  ],
  timeoutMs: 150000,
});
console.log('ready', r.ready, '| errors', r.errors.length);
