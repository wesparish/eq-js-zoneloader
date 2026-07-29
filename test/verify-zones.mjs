import { drive } from '/home/wes/workspace/eq-js-zoneloader/test/cdp.mjs';
// Switch zones through the dropdown and confirm each one actually rebuilds.
const pick = (id) => `(()=>{const s=document.getElementById('zoneSelect');
  s.value=${JSON.stringify(id)}; s.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`;
const wait = `document.getElementById("loader").style.display === "none"`;
const r = await drive({
  url: process.argv[2] || 'http://localhost:8731/index.html',
  readyExpr: wait,
  before: `document.getElementById('help').classList.add('hidden');
           document.getElementById('settings').classList.add('collapsed'); true`,
  screenshot: '/tmp/z_blackburrow.png',
  shots: [
    { expr: pick('neriaka'), path: '/tmp/z_neriaka.png', settleMs: 9000 },
    { expr: pick('rivervale'), path: '/tmp/z_rivervale.png', settleMs: 9000 },
    { expr: pick('blackburrow'), path: '/tmp/z_back.png', settleMs: 9000 },
  ],
  timeoutMs: 180000,
});
console.log('ready', r.ready);
console.log('final stats:', r.stats?.stats?.replace(/\n/g,' | '));
console.log('errors:', r.errors.filter(e=>!e.includes('favicon')));
