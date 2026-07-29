import { drive } from '/home/wes/workspace/eq-js-zoneloader/test/cdp.mjs';
const before = process.argv[3] || null;
const r = await drive({
  url: process.argv[2] || 'http://localhost:8731/index.html',
  readyExpr: 'document.getElementById("loader").style.display === "none"',
  screenshot: process.argv[4] || '/tmp/eqshot.png',
  before,
  timeoutMs: 150000,
});
console.log('ready:', r.ready);
console.log('stats:', r.stats);
if (r.logs.length) console.log('console:', r.logs.slice(0,20));
if (r.errors.length) console.log('ERRORS:', r.errors.slice(0,10));
