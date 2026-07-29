// Turns the pqdi.cc (Project Quarm DB) zone page into data/<zone>_npcs.json.
//
//   node test/build-npcs.mjs 17 blackburrow
//
// Spawn points that roll between several NPCs list each with a percentage; we
// keep the *rarest* candidate so named/rare mobs show up instead of the common
// filler.
//
// Coordinates: the page heads the column "(Y, X, Z)" (EQ's /loc order), but the
// first value is this engine's X — the WLD vertex order is the opposite way
// round from /loc. Verified against the collision mesh: reading column 1 as X
// leaves every one of the 122 spawns sitting over a floor, while the labelled
// reading strands 65 of them over nothing.

import { writeFileSync } from 'fs';

const RACE_MODEL = {
  36: 'RAT',   // giant rat
  37: 'SNA',   // snake
  39: 'GNN',   // gnoll
  43: 'BEA',   // bear
  1: 'HUM',    // human — lives in global_chr.s3d, not the zone archive
  74: 'FIS',   // fish  — ditto
};
// Invisible controller NPCs that should never be drawn.
const SKIP_RACES = new Set([127]);

const zoneId = process.argv[2] || '17';
const zoneName = process.argv[3] || 'blackburrow';
const UA = { 'User-Agent': 'Mozilla/5.0 (eq-js-zoneloader)' };

const zoneHtml = await (await fetch(`https://www.pqdi.cc/zone/${zoneId}`, { headers: UA })).text();
const table = /id="spawns-tab-pane"[^>]*>([\s\S]*?)<\/table>/.exec(zoneHtml)[1];

const points = [];
for (const row of table.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
  const coord = /\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)/.exec(row);
  const npcs = [...row.matchAll(/href="\/npc\/(\d+)">([^<]+)<\/a>\s*\((\d+)%\)/g)];
  if (!coord || !npcs.length) continue;
  // Rarest candidate wins.
  const pick = npcs.reduce((a, b) => (Number(b[3]) < Number(a[3]) ? b : a));
  points.push({
    id: pick[1], label: pick[2], chance: Number(pick[3]),
    x: Number(coord[1]), y: Number(coord[2]), z: Number(coord[3]),
  });
}

const ids = [...new Set(points.map((p) => p.id))];
const npcs = {};
for (const id of ids) {
  const html = await (await fetch(`https://www.pqdi.cc/npc/${id}`, { headers: UA })).text();
  const f = Object.fromEntries(
    [...html.matchAll(/<dd><strong>([^<:]+):\s*<\/strong><span[^>]*>([^<]*)<\/span><\/dd>/g)]
      .map((m) => [m[1], m[2]]));
  npcs[id] = {
    name: (f.name || '').replace(/_/g, ' ').replace(/^#/, ''),
    race: Number(f.race || 0), gender: Number(f.gender || 0),
    texture: Number(f.texture || 0), helm: Number(f.helmtexture || 0),
    size: Number(f.size || 6), level: Number(f.level || 1),
  };
  await new Promise((r) => setTimeout(r, 200));
}

const missing = new Set();
const spawns = [];
for (const p of points) {
  const npc = npcs[p.id];
  if (!npc || SKIP_RACES.has(npc.race)) continue;
  const model = RACE_MODEL[npc.race];
  if (!model) { missing.add(npc.race); continue; }
  spawns.push({
    name: npc.name, model, race: npc.race, texture: npc.texture,
    size: npc.size, level: npc.level, chance: p.chance,
    // EQ coordinates; the loader maps them to GL space.
    x: p.x, y: p.y, z: p.z,
  });
}

const out = { zone: zoneName, source: `https://www.pqdi.cc/zone/${zoneId}`, spawns };
writeFileSync(`data/${zoneName}_npcs.json`, JSON.stringify(out, null, 1));

const byModel = {};
for (const s of spawns) byModel[s.model] = (byModel[s.model] || 0) + 1;
console.log(`${spawns.length} spawns from ${points.length} points ->`, byModel);
console.log('rare picks:', spawns.filter((s) => s.chance < 100).map((s) => `${s.name} (${s.chance}%)`).join(', ') || 'none');
if (missing.size) console.log('unmapped races (skipped):', [...missing].join(', '));
