import { drive } from '/home/wes/workspace/eq-js-zoneloader/test/cdp.mjs';
// Drive the actual DOM controls (not the JS state) to prove the panel is wired up.
const setSlider = (key, val) => `(()=>{
  const rows=[...document.querySelectorAll('#settings .slider')];
  const row=rows.find(r=>r.querySelector('label').textContent.trim().startsWith(${JSON.stringify(key)}));
  const inp=row.querySelector('input');
  inp.value=${val}; inp.dispatchEvent(new Event('input',{bubbles:true}));
  return {label:row.querySelector('label').textContent.trim(), out:row.querySelector('output').textContent};
})()`;
const probe = `JSON.stringify({b:eq.state.opts.brightness,a:eq.state.opts.ambient,fov:eq.state.opts.fov,spd:eq.state.opts.moveSpeed,objs:eq.state.opts.showObjects})`;
const r = await drive({
  url: 'http://localhost:8731/index.html',
  readyExpr: 'document.getElementById("loader").style.display === "none"',
  before: `eq.tp(-155,-30,60,1.6,-0.08); ${setSlider('Zone ambient',0.9)}; ${setSlider('Brightness',1.8)}; ${setSlider('Field of view',95)}; ${setSlider('Move speed',120)};
    document.querySelector('#settings .setting-group:nth-of-type(2)'); 
    [...document.querySelectorAll('#settings .toggle')].find(t=>t.textContent.includes('Placed objects')).querySelector('input').click();
    true`,
  screenshot: '/tmp/eq_bright.png',
  shots: [
    { expr: `document.getElementById('resetBtn').click(); true`, path: '/tmp/eq_reset.png' },
  ],
  timeoutMs: 150000,
});
console.log('ready', r.ready, 'errors', r.errors.filter(e=>!e.includes('favicon')));
