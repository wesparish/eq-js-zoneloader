import { readPFS } from './pfs.js';
import { buildZone, buildNPCs } from './zone.js';
import { CollisionWorld } from './collision.js';
import { Renderer } from './renderer.js';

const EYE_HEIGHT = 5.0;
const PLAYER_RADIUS = 2.0;
const PLAYER_HEIGHT = 6.0;
const RUN_MULT = 2.2;
const GRAVITY = 90;
const JUMP_SPEED = 34;

const $ = (id) => document.getElementById(id);

const state = {
  pos: [0, 0, 0],          // feet, GL space
  vel: [0, 0, 0],
  yaw: 0, pitch: 0,
  grounded: false,
  noclip: false,
  keys: new Set(),
  opts: {
    brightness: 1.0,
    ambient: 0.70,
    headlamp: 0.22,
    vertexColor: true,
    showObjects: true,
    showNpcs: true,
    showNames: true,
    nameDistance: 250,
    cull: false,
    fogColor: [0.03, 0.04, 0.05],
    fogStart: 400,
    fogEnd: 900,
    fov: 60,
    moveSpeed: 45,
    sensitivity: 1,
    invertY: false,
  },
};

let renderer = null, collision = null, zoneData = null, zoneSpawn = null;

// --- matrix helpers ----------------------------------------------------------

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
}

function lookDir(eye, yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const f = [Math.sin(yaw) * cp, sp, -Math.cos(yaw) * cp];
  const s = [Math.cos(yaw), 0, Math.sin(yaw)];
  const u = [
    s[1] * f[2] - s[2] * f[1],
    s[2] * f[0] - s[0] * f[2],
    s[0] * f[1] - s[1] * f[0],
  ];
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -(s[0] * eye[0] + s[1] * eye[1] + s[2] * eye[2]),
    -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
    f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2], 1,
  ]);
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

// --- loading -----------------------------------------------------------------

const ZONE_FILES = (zone) => [`${zone}.s3d`, `${zone}_obj.s3d`, `${zone}_2_obj.s3d`];

async function fetchArchives(zone, parts) {
  // `parts` comes from zones.json when present, which avoids probing for optional
  // archives that don't exist and littering the console with 404s.
  const names = parts || ZONE_FILES(zone);
  const out = [];
  for (const name of names) {
    const res = await fetch(`data/${name}`).catch(() => null);
    if (!res || !res.ok) { out.push(null); continue; }
    out.push(new Uint8Array(await res.arrayBuffer()));
  }
  return out;
}

function progress(msg) {
  $('loadText').textContent = msg;
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/** Fetches a zone by id and swaps it in, releasing the previous zone's GPU memory. */
async function switchZone(id) {
  const select = $('zoneSelect');
  select.disabled = true;
  $('loader').style.display = 'grid';
  $('loadText').textContent = `Fetching ${id}…`;
  try {
    const meta = zoneList.find((z) => z.id === id) || {};
    zoneSpawn = meta.spawn || null;
    await loadZone(await fetchArchives(id, meta.parts), id, meta.name);
    const url = new URL(location.href);
    url.searchParams.set('zone', id);
    history.replaceState(null, '', url);
  } catch (e) {
    $('loadText').textContent = `Could not load ${id}: ${e.message}`;
  }
  select.disabled = false;
  select.value = id;
}

/** Populates the zone dropdown from data/zones.json, if it exists. */
let zoneList = [];

async function loadZoneList(current) {
  const select = $('zoneSelect');
  let zones = [];
  try {
    const res = await fetch('data/zones.json');
    if (res.ok) zones = await res.json();
  } catch { /* no manifest — the dropdown just stays hidden */ }
  if (!zones.some((z) => z.id === current)) zones.unshift({ id: current, name: current });
  zoneList = zones;
  if (zones.length < 2) { select.style.display = 'none'; return; }
  select.innerHTML = zones
    .map((z) => `<option value="${z.id}">${z.name}${z.note ? ` — ${z.note}` : ''}</option>`)
    .join('');
  select.value = current;
  select.addEventListener('change', () => switchZone(select.value));
}

async function loadZone(buffers, zoneName, displayName) {
  setNameplates([]);
  await progress('Decompressing archives…');
  const [zoneBuf, objBuf, obj2Buf] = buffers;
  if (!zoneBuf) throw new Error(`missing ${zoneName}.s3d`);
  const zoneArc = await readPFS(zoneBuf);
  const objArcs = [];
  if (objBuf) objArcs.push(await readPFS(objBuf));
  if (obj2Buf) objArcs.push(await readPFS(obj2Buf));

  await progress('Parsing WLD geometry…');
  const t0 = performance.now();
  zoneData = buildZone(zoneArc, objArcs);
  const buildMs = performance.now() - t0;

  // NPC spawns (optional): character models from <zone>_chr.s3d posed at the
  // coordinates in <zone>_npcs.json. Purely decorative — no collision.
  let npcStats = null;
  const meta = zoneList.find((z) => z.id === zoneName) || {};
  if (meta.chr && meta.npcs) {
    await progress('Placing NPCs…');
    try {
      const [chrBuf, spawnRes] = await Promise.all([
        fetch(`data/${meta.chr}`).then((r) => (r.ok ? r.arrayBuffer() : null)),
        fetch(`data/${meta.npcs}`).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (chrBuf && spawnRes) {
        const npc = buildNPCs(readPFS(new Uint8Array(chrBuf)), spawnRes.spawns, zoneData.textures);
        zoneData.batches.push(...npc.batches);
        npcStats = npc.stats;
        setNameplates(npc.labels);
      }
    } catch (e) {
      console.warn('NPC load failed:', e);
    }
  }

  await progress('Uploading textures…');
  const batchCount = renderer.load(zoneData);

  await progress('Building collision…');
  collision = new CollisionWorld(zoneData.batches);

  spawn();

  const s = zoneData.stats;
  $('statsBody').innerHTML = [
    `${s.zoneMeshes} meshes → ${batchCount} batches`,
    `${(s.zoneTris + s.objectTris).toLocaleString()} triangles`,
    `${s.objectInstances} placed objects`,
    ...(npcStats ? [`${npcStats.placed} NPC spawns`] : []),
    `${zoneData.textures.size} textures`,
    `${collision.tris.length.toLocaleString()} collision tris`,
    `built in ${buildMs.toFixed(0)} ms`,
  ].join('<br>');
  $('loader').style.display = 'none';

  // Console/debug handle: eq.tp(x, y, z) takes EQ coordinates.
  window.eq = {
    state, spawn, zone: zoneData, collision,
    tp(x, y, z, yaw = 0, pitch = 0) {
      state.pos = [x, z, -y];
      state.vel = [0, 0, 0];
      state.yaw = yaw; state.pitch = pitch;
      state.noclip = true;
      updateHud();
    },
  };
}

/**
 * Picks somewhere worth standing: a floor with headroom and open space around it.
 * Sampling the zone beats using its centre, which lands you inside a wall in any
 * zone that isn't a single open cavern. Faces the most open direction.
 */
function spawn() {
  if (zoneSpawn) {
    // Explicit spawn from zones.json, in EQ coordinates.
    const [x, y, z, yaw] = zoneSpawn;
    state.pos = [x, z, -y];
    state.vel = [0, 0, 0];
    state.yaw = yaw ?? 0;
    state.pitch = 0;
    return;
  }

  const b = zoneData.bounds;
  const objs = zoneData.objectPositions;
  const DIRS = 8;
  let best = null;

  // Candidates are the placed objects themselves. Pure "most open space" scoring
  // picks the *outside* of an enclosed city, which is exactly wrong; torches,
  // crates and furniture instead mark where a zone is meant to be walked.
  const candidates = [];
  const stride = Math.max(1, Math.floor(objs.length / 3 / 400));
  for (let i = 0; i < objs.length / 3; i += stride) {
    candidates.push([objs[i * 3], objs[i * 3 + 1], objs[i * 3 + 2]]);
  }
  // Fall back to a coarse grid for zones that place no objects at all.
  if (!candidates.length) {
    for (let ix = 1; ix < 16; ix++) {
      for (let iz = 1; iz < 16; iz++) {
        candidates.push([
          b.min[0] + ((b.max[0] - b.min[0]) * ix) / 16, b.max[1],
          b.min[2] + ((b.max[2] - b.min[2]) * iz) / 16]);
      }
    }
  }

  for (const [cx, cy, cz] of candidates) {
    const floor = collision.floorAt(cx, cy + 30, cz);
    if (floor === null) continue;
    const eye = floor + EYE_HEIGHT;
    const headroom = Math.min(collision.raycast(cx, eye, cz, 0, 1, 0, 120), 120);
    if (headroom < PLAYER_HEIGHT) continue;

    let minClear = Infinity, bestDir = 0, bestClear = 0;
    for (let d = 0; d < DIRS; d++) {
      const a = (d / DIRS) * Math.PI * 2;
      const clear = collision.raycast(cx, eye, cz, Math.sin(a), 0, -Math.cos(a), 250);
      minClear = Math.min(minClear, clear);
      if (clear > bestClear) { bestClear = clear; bestDir = a; }
    }
    if (minClear < PLAYER_RADIUS * 2) continue; // wedged against something

    // Reward busy areas: the more placements nearby, the more there is to look at.
    let density = 0;
    for (let i = 0; i < objs.length / 3; i++) {
      const dx = objs[i * 3] - cx, dz = objs[i * 3 + 2] - cz;
      if (dx * dx + dz * dz < 150 * 150) density++;
    }
    const score = Math.min(minClear, 70) + density * 2.5;
    if (!best || score > best.score) best = { score, pos: [cx, floor + 2, cz], yaw: bestDir };
  }

  state.pos = best ? best.pos : [(b.min[0] + b.max[0]) / 2, b.max[1], (b.min[2] + b.max[2]) / 2];
  state.yaw = best ? best.yaw : 0;
  state.vel = [0, 0, 0];
  state.pitch = 0;
}

// --- input -------------------------------------------------------------------

function setupInput(canvas) {
  addEventListener('keydown', (e) => {
    if (e.code === 'Tab') e.preventDefault();
    state.keys.add(e.code);
    const bump = (key, delta) => {
      const s = SETTINGS.find((x) => x.key === key);
      writeSetting(s, Math.max(s.min, Math.min(s.max, readSetting(s) + delta)));
    };
    const flip = (key) => {
      const s = SETTINGS.find((x) => x.key === key);
      writeSetting(s, !readSetting(s));
    };
    if (e.code === 'KeyF') flip('noclip');
    if (e.code === 'KeyR') spawn();
    if (e.code === 'KeyO') flip('showObjects');
    if (e.code === 'KeyN') flip('showNpcs');
    if (e.code === 'KeyM') flip('showNames');
    if (e.code === 'KeyC') flip('cull');
    if (e.code === 'KeyL') flip('vertexColor');
    if (e.code === 'BracketLeft') bump('brightness', -0.1);
    if (e.code === 'BracketRight') bump('brightness', 0.1);
    if (e.code === 'Minus') bump('ambient', -0.05);
    if (e.code === 'Equal') bump('ambient', 0.05);
    if (e.code === 'KeyH') $('help').classList.toggle('hidden');
    if (e.code === 'Tab') $('settingsHead').click();
  });
  addEventListener('keyup', (e) => state.keys.delete(e.code));
  addEventListener('blur', () => state.keys.clear());

  canvas.addEventListener('click', () => canvas.requestPointerLock());
  document.addEventListener('pointerlockchange', () => {
    $('crosshair').style.display = document.pointerLockElement === canvas ? 'block' : 'none';
    $('clickHint').style.display = document.pointerLockElement === canvas ? 'none' : 'block';
  });
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    const sens = 0.0022 * state.opts.sensitivity;
    const invert = state.opts.invertY ? -1 : 1;
    state.yaw += e.movementX * sens;
    state.pitch = Math.max(-1.55, Math.min(1.55, state.pitch - e.movementY * sens * invert));
  });
}

// --- simulation --------------------------------------------------------------

function step(dt) {
  const k = state.keys;
  const forward = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
  const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
  const speed = state.opts.moveSpeed * (k.has('ShiftLeft') || k.has('ShiftRight') ? RUN_MULT : 1);

  const sinY = Math.sin(state.yaw), cosY = Math.cos(state.yaw);
  let wishX = strafe * cosY + forward * sinY;
  let wishZ = strafe * sinY - forward * cosY;
  const len = Math.hypot(wishX, wishZ);
  if (len > 0) { wishX /= len; wishZ /= len; }

  if (state.noclip) {
    const cp = Math.cos(state.pitch);
    const fly = speed * 1.6;
    let dx = wishX * fly, dz = wishZ * fly;
    let dy = 0;
    if (forward !== 0) {
      // In noclip, W/S follow the look direction including pitch.
      dy += Math.sin(state.pitch) * forward * fly;
      dx *= cp || 1; dz *= cp || 1;
    }
    if (k.has('Space')) dy += fly;
    if (k.has('ControlLeft')) dy -= fly;
    state.pos[0] += dx * dt;
    state.pos[1] += dy * dt;
    state.pos[2] += dz * dt;
    state.grounded = false;
    return;
  }

  state.vel[0] = wishX * speed;
  state.vel[2] = wishZ * speed;
  state.vel[1] -= GRAVITY * dt;
  if (k.has('Space') && state.grounded) { state.vel[1] = JUMP_SPEED; state.grounded = false; }

  // Integrate then push out of the world. Sub-stepping keeps fast movement from
  // tunnelling through the thin cave walls.
  const steps = Math.max(1, Math.ceil((Math.hypot(state.vel[0], state.vel[1], state.vel[2]) * dt) / 2));
  const sub = dt / steps;
  for (let i = 0; i < steps; i++) {
    state.pos[0] += state.vel[0] * sub;
    state.pos[1] += state.vel[1] * sub;
    state.pos[2] += state.vel[2] * sub;
    const r = collision.resolve(state.pos, PLAYER_RADIUS, PLAYER_HEIGHT);
    if (r.grounded && state.vel[1] < 0) state.vel[1] = 0;
    state.grounded = r.grounded;
    state.pos = r.pos;
  }

  // Safety net: if we somehow end up under the map, put the player back.
  if (state.pos[1] < zoneData.bounds.min[1] - 200) spawn();
}

// --- settings panel ----------------------------------------------------------

// Every tunable lives here once; the panel, the keyboard shortcuts and the reset
// button all read from this list so they can never drift apart.
const SETTINGS = [
  { group: 'Lighting' },
  { key: 'ambient', label: 'Zone ambient', min: 0, max: 1, step: 0.01, keys: '- =' },
  { key: 'brightness', label: 'Brightness', min: 0.2, max: 3, step: 0.05, keys: '[ ]' },
  { key: 'headlamp', label: 'Headlamp', min: 0, max: 1, step: 0.01 },
  { key: 'vertexColor', label: 'Baked vertex lighting', toggle: true, keys: 'L' },

  { group: 'View' },
  { key: 'fov', label: 'Field of view', min: 50, max: 120, step: 1, unit: '°' },
  { key: 'fogStart', label: 'Fog start', min: 0, max: 3000, step: 25 },
  { key: 'fogEnd', label: 'Fog end', min: 100, max: 4000, step: 25 },
  { key: 'showObjects', label: 'Placed objects', toggle: true, keys: 'O' },
  { key: 'showNpcs', label: 'NPC spawns', toggle: true, keys: 'N' },
  { key: 'showNames', label: 'NPC nameplates', toggle: true, keys: 'M' },
  { key: 'nameDistance', label: 'Nameplate range', min: 50, max: 800, step: 10 },
  { key: 'cull', label: 'Backface culling', toggle: true, keys: 'C' },

  { group: 'Movement' },
  { key: 'moveSpeed', label: 'Move speed', min: 10, max: 250, step: 5 },
  { key: 'sensitivity', label: 'Mouse sensitivity', min: 0.2, max: 4, step: 0.05, unit: '×' },
  { key: 'invertY', label: 'Invert mouse Y', toggle: true },
  { key: 'noclip', label: 'Noclip (fly through walls)', toggle: true, keys: 'F', onState: true },
];

const DEFAULTS = { ...state.opts };
const controls = new Map();

function readSetting(s) {
  return s.onState ? state[s.key] : state.opts[s.key];
}

function writeSetting(s, value) {
  if (s.onState) state[s.key] = value;
  else state.opts[s.key] = value;
  if (s.key === 'noclip') state.vel = [0, 0, 0];
  // Keep the two fog handles from crossing over.
  if (s.key === 'fogStart') state.opts.fogEnd = Math.max(state.opts.fogEnd, value + 50);
  if (s.key === 'fogEnd') state.opts.fogStart = Math.min(state.opts.fogStart, value - 50);
  updateHud();
}

function buildSettings() {
  const body = document.querySelector('#settings .setting-body');
  let group = null;
  for (const s of SETTINGS) {
    if (s.group) {
      group = document.createElement('div');
      group.className = 'setting-group';
      group.innerHTML = `<h4>${s.group}</h4>`;
      body.appendChild(group);
      continue;
    }
    if (s.toggle) {
      const row = document.createElement('label');
      row.className = 'toggle';
      row.innerHTML = `<input type="checkbox"><span>${s.label}</span>` +
        (s.keys ? `<span class="key">${s.keys}</span>` : '');
      const input = row.querySelector('input');
      input.checked = readSetting(s);
      input.addEventListener('change', () => writeSetting(s, input.checked));
      group.appendChild(row);
      controls.set(s.key, { s, input });
    } else {
      const row = document.createElement('div');
      row.className = 'slider';
      row.innerHTML =
        `<label>${s.label}${s.keys ? ` <span class="key">${s.keys}</span>` : ''}</label><output></output>` +
        `<input type="range" min="${s.min}" max="${s.max}" step="${s.step}">`;
      const input = row.querySelector('input');
      const out = row.querySelector('output');
      input.value = readSetting(s);
      input.addEventListener('input', () => writeSetting(s, parseFloat(input.value)));
      group.appendChild(row);
      controls.set(s.key, { s, input, out });
    }
  }
  const reset = document.createElement('button');
  reset.id = 'resetBtn';
  reset.textContent = 'reset to defaults';
  reset.addEventListener('click', () => { Object.assign(state.opts, DEFAULTS); updateHud(); });
  body.appendChild(reset);

  const panel = $('settings');
  $('settingsHead').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    $('settingsHead').querySelector('.chev').textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
  });
}

/** Pushes current values back into the panel; called after any change. */
function updateHud() {
  for (const { s, input, out } of controls.values()) {
    const v = readSetting(s);
    if (s.toggle) input.checked = v;
    else {
      input.value = v;
      const digits = s.step < 0.1 ? 2 : s.step < 1 ? 1 : 0;
      out.textContent = v.toFixed(digits) + (s.unit || '');
    }
  }
}

// --- nameplates ---------------------------------------------------------------
//
// Drawn as DOM nodes rather than textured quads: crisp at any resolution and
// free of the depth-sorting problems billboards bring. Each frame the anchor is
// projected to screen space; occlusion uses the collision mesh so names don't
// bleed through terrain, with the raycasts staggered across frames.

let nameplates = [];

function setNameplates(labels) {
  const host = $('nameplates');
  host.textContent = '';
  nameplates = (labels || []).map((label) => {
    const el = document.createElement('div');
    el.className = label.named ? 'np named' : 'np';
    el.textContent = label.name;
    const lvl = document.createElement('small');
    lvl.textContent = `level ${label.level}`;
    el.appendChild(lvl);
    el.style.display = 'none';
    host.appendChild(el);
    return { label, el, shown: false, occluded: false, size: 0 };
  });
}

const OCCLUSION_STRIDE = 6; // each plate re-tests every N frames

// Plates keep a constant pixel size past FAR_DIST, so they appear to grow
// relative to the model as you back away — deliberate, and what makes distant
// NPCs readable. Up close that same fixed size reads as too small, so scale up
// over the near range only and taper back to the baseline.
const NAME_NEAR_DIST = 25, NAME_FAR_DIST = 90;
const NAME_NEAR_PX = 17, NAME_FAR_PX = 12;

function nameplateSize(dist) {
  const t = Math.min(1, Math.max(0, (dist - NAME_NEAR_DIST) / (NAME_FAR_DIST - NAME_NEAR_DIST)));
  return NAME_NEAR_PX + (NAME_FAR_PX - NAME_NEAR_PX) * t;
}

function updateNameplates(vp, eye, w, h, frame) {
  const host = $('nameplates');
  const on = state.opts.showNames && state.opts.showNpcs && nameplates.length;
  if (!on) {
    if (host.style.visibility !== 'hidden') host.style.visibility = 'hidden';
    return;
  }
  host.style.visibility = '';
  const maxDist = state.opts.nameDistance;
  const fadeFrom = maxDist * 0.7;

  for (let i = 0; i < nameplates.length; i++) {
    const np = nameplates[i];
    const p = np.label.pos;
    const dx = p[0] - eye[0], dy = p[1] - eye[1], dz = p[2] - eye[2];
    const dist = Math.hypot(dx, dy, dz);
    let show = dist < maxDist && dist > 0.01;
    let sx = 0, sy = 0;

    if (show) {
      const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
      if (cw <= 0.001) {
        show = false; // behind the camera
      } else {
        const nx = (vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / cw;
        const ny = (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / cw;
        if (nx < -1.15 || nx > 1.15 || ny < -1.15 || ny > 1.15) show = false;
        sx = (nx * 0.5 + 0.5) * w;
        sy = (1 - (ny * 0.5 + 0.5)) * h;
      }
    }

    if (show && collision && i % OCCLUSION_STRIDE === frame % OCCLUSION_STRIDE) {
      const hit = collision.raycast(eye[0], eye[1], eye[2], dx / dist, dy / dist, dz / dist, dist);
      np.occluded = hit < dist - 1.5;
    }
    if (np.occluded) show = false;

    if (!show) {
      if (np.shown) { np.el.style.display = 'none'; np.shown = false; }
      continue;
    }
    if (!np.shown) { np.el.style.display = ''; np.shown = true; }
    const size = nameplateSize(dist);
    if (Math.abs(size - np.size) > 0.25) { // avoid restyling every frame
      np.el.style.fontSize = `${size.toFixed(1)}px`;
      np.size = size;
    }
    np.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
    np.el.style.opacity = dist > fadeFrom ? String(Math.max(0, 1 - (dist - fadeFrom) / (maxDist - fadeFrom)).toFixed(2)) : '1';
  }
}

// --- main loop ---------------------------------------------------------------

function start(canvas) {
  let last = performance.now();
  let fpsAccum = 0, fpsFrames = 0, fps = 0, frameNo = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    fpsAccum += dt; fpsFrames++;
    if (fpsAccum > 0.5) { fps = fpsFrames / fpsAccum; fpsAccum = 0; fpsFrames = 0; }

    if (collision) step(dt);

    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

    const eye = [state.pos[0], state.pos[1] + EYE_HEIGHT, state.pos[2]];
    const proj = perspective((state.opts.fov * Math.PI) / 180, canvas.width / Math.max(canvas.height, 1), 0.5, 4000);
    const view = lookDir(eye, state.yaw, state.pitch);
    const vp = multiply(proj, view);

    frameNo++;
    updateNameplates(vp, eye, canvas.clientWidth, canvas.clientHeight, frameNo);

    let info = { calls: 0, tris: 0 };
    if (renderer.drawables.length) {
      info = renderer.render(vp, new Float32Array(eye), { ...state.opts, timeMs: now });
    }

    // Report EQ coordinates, since that is what /loc and map data use.
    const eqX = state.pos[0], eqY = -state.pos[2], eqZ = state.pos[1];
    $('readout').innerHTML =
      `${fps.toFixed(0)} fps &nbsp;|&nbsp; ${info.calls} draws / ${info.tris.toLocaleString()} tris` +
      `<br>loc &nbsp;x <b>${eqX.toFixed(1)}</b> &nbsp;y <b>${eqY.toFixed(1)}</b> &nbsp;z <b>${eqZ.toFixed(1)}</b>` +
      `<br>${state.grounded ? 'grounded' : 'airborne'}`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// --- bootstrap ---------------------------------------------------------------

async function boot() {
  const canvas = $('gl');
  try {
    renderer = new Renderer(canvas);
  } catch (e) {
    $('loadText').textContent = e.message;
    return;
  }
  setupInput(canvas);
  buildSettings();
  updateHud();
  start(canvas);

  const zoneName = new URLSearchParams(location.search).get('zone') || 'blackburrow';
  $('loadText').textContent = `Fetching ${zoneName}…`;
  try {
    // The manifest has to be read first: it carries the archive list and the
    // spawn point for the very first zone, not just for later switches.
    await loadZoneList(zoneName);
    const meta = zoneList.find((z) => z.id === zoneName) || {};
    zoneSpawn = meta.spawn || null;
    const buffers = await fetchArchives(zoneName, meta.parts);
    if (!buffers[0]) throw new Error('fetch failed');
    await loadZone(buffers, zoneName, meta.name);
  } catch (e) {
    // file:// or a missing data/ directory — fall back to a manual picker.
    $('loadText').innerHTML =
      `Could not fetch <code>data/${zoneName}.s3d</code>.<br>` +
      `Serve this folder over HTTP, or pick the .s3d files below.`;
    $('picker').style.display = 'block';
  }

  $('files').addEventListener('change', async (ev) => {
    const picked = [...ev.target.files];
    const find = (suffix) => picked.find((f) => f.name.toLowerCase().endsWith(suffix));
    const base = picked.map((f) => f.name.toLowerCase()).find((n) => n.endsWith('.s3d') && !n.includes('_obj') && !n.includes('_chr'));
    const zone = base ? base.replace('.s3d', '') : 'zone';
    const read = async (f) => (f ? new Uint8Array(await f.arrayBuffer()) : null);
    $('picker').style.display = 'none';
    try {
      await loadZone([
        await read(picked.find((f) => f.name.toLowerCase() === `${zone}.s3d`)),
        await read(find('_obj.s3d')),
        await read(find('_2_obj.s3d')),
      ], zone);
    } catch (e) {
      $('loadText').textContent = `Load failed: ${e.message}`;
      $('picker').style.display = 'block';
    }
  });
}

boot();
