# EQ Zone Walker

A dependency-free, first-person WebGL2 viewer for original EverQuest zone data. It reads
the shipped `.s3d` archives directly in the browser — no conversion step, no build step,
no libraries — and lets you walk around the zone with WASD and mouselook.

Four zones ship in `data/`, switchable from a dropdown without a page reload:
**Blackburrow** (gnoll warren), **South Qeynos** (human capital),
**Neriak Foreign Quarter** (dark elf city) and **Rivervale** (halfling village).
Blackburrow is also populated with its **117 NPC spawns** — gnolls, snakes and a
bear standing at their real database coordinates, with nameplates.

**[Live demo](https://wesparish.github.io/eq-js-zoneloader/)** — loads in a few seconds, no install.

## Vibe-coded in 3 prompts

This started as "what's in this directory?" and was a working, textured, walkable engine
25 minutes later — three prompts, no prior knowledge of the file formats on either side.
Everything here (PFS archive reader, DEFLATE decoder, WLD parser, BMP/DDS decoders, WebGL2
renderer, collision) was written from scratch by [Claude Code](https://claude.com/claude-code)
by reverse-engineering the actual bytes of the game files.

| # | Duration | Prompt | API calls | Output tok | Cost |
|---|---|---|---|---|---|
| 1 | 0m23s | look in this directory for files about blackburrow | 6 | 1,719 | $0.26 |
| 2 | 1m35s | inspect them and see if you can read their formatting | 12 | 14,019 | $0.70 |
| 3 | 22m55s | build a static html file with a JS first-person engine | 151 | 239,081 | $16.24 |
| | **24m53s** | **3 prompts** | **169** | **254,819** | **$17.20** |

Timings and token counts are from the session transcript; cost is the API list-price
equivalent at Claude Opus 5 rates. Later prompts added the extra zones, a settings panel,
and a texture-orientation fix — but the engine in row 3 already loaded and rendered
Blackburrow with working collision.

## Running

```bash
./serve.sh          # http://localhost:8731/
```

A local HTTP server is required: browsers block ES module imports and `fetch()` over
`file://`. If you open `index.html` directly it falls back to a file picker where you can
select the `.s3d` files by hand.

Deep-link a zone with `?zone=rivervale`.

## Adding zones

Drop the archives into `data/` and add an entry to `data/zones.json`:

```json
{ "id": "rivervale", "name": "Rivervale", "note": "halfling village",
  "parts": ["rivervale.s3d", "rivervale_obj.s3d"],
  "spawn": [2.6, -330.2, 9.5, 2.09] }
```

`parts` is optional (it defaults to probing `<zone>.s3d`, `<zone>_obj.s3d` and
`<zone>_2_obj.s3d`, but listing it avoids 404s for archives a zone doesn't have).
`spawn` is `[x, y, z, yaw]` in EQ coordinates and is also optional — without it the
loader picks a spot automatically. `node test/find-spawns.mjs <zone>` computes a good
one, printing a ready-to-paste entry.

Only old-format WLD (version `0x00015500`) is supported, which covers Trilogy-era zones —
the ones Quarm/TAKP ship. Later expansions (Luclin and after) use version `0x1000C800`
and won't load.

## Controls

| | |
|---|---|
| `W` `A` `S` `D` | move |
| mouse | look (click to capture, `esc` to release) |
| `shift` | run |
| `space` | jump, or ascend in noclip |
| `ctrl` | descend in noclip |
| `F` | toggle noclip |
| `R` | respawn |
| `O` / `C` / `L` | toggle objects / backface culling / baked lighting |
| `N` / `M` | toggle NPC spawns / nameplates |
| `[` `]` and `-` `=` | brightness and zone ambient |
| `tab` | show/hide the settings panel |
| `H` | hide the help panel |

The settings panel exposes lighting, fog, FOV, move speed and mouse sensitivity as
sliders, plus toggles for placed objects, backface culling, baked lighting, inverted
mouse Y and noclip, with a reset button. `window.eq` is available in the console — `eq.tp(x, y, z)`
teleports using EQ coordinates.

## NPC spawns

`data/blackburrow_npcs.json` is generated from the [Project Quarm
DB](https://www.pqdi.cc/zone/17) by `test/build-npcs.mjs`, which pairs each spawn point
with the NPC's race, texture, size and level. Where a spawn point rolls between several
NPCs, the **rarest** candidate is kept — so Master Brewer (5%) and Mannan of the
Sabertooth (5%) are standing there rather than the common filler.

Two things about that data are worth knowing, because both produce plausible-looking but
wrong results:

- **The coordinate column is headed `(Y, X, Z)`** — EQ's `/loc` order — but the first
  value is this engine's X, because the WLD vertex order runs opposite to `/loc`.
  Verified against the collision mesh: reading column 1 as X leaves all 122 spawns over a
  floor, while the labelled reading strands 65 of them over nothing.
- **The Z is the model origin, not the feet.** The median gap from spawn Z to the local
  floor is 3.8 units, which is exactly a gnoll's origin-to-foot distance. Offsetting by
  the foot position on top of that lifts every NPC a full body-height into the air.

## How it works

```
src/inflate.js     DEFLATE decoder
src/pfs.js         .s3d archive reader
src/wld.js         WLD fragment parser
src/textures.js    BMP and DDS (DXT1/3/5) decoders
src/zone.js        fragments -> merged, material-batched geometry
src/skeleton.js    character bind-pose skinning (bone tree + tracks)
src/collision.js   capsule-vs-triangle collision with a uniform grid
src/renderer.js    WebGL2 renderer
src/main.js        loading, camera, input, physics, UI
```

Things worth knowing about the data, all verified against the Blackburrow files:

- **`.s3d` is a PFS archive**: a directory of CRC/offset/size triples, with each file
  stored as a run of independently zlib-compressed ~8 KB chunks. The entry with CRC
  `0x61580AC9` is not a file — it's the filename table, matched to real entries by
  ascending data offset.
- **Inflate is hand-rolled** rather than using `DecompressionStream`. A zone holds
  thousands of tiny compressed chunks, and one async stream per chunk turns a 200 ms load
  into tens of seconds. `test/verify-inflate.mjs` checks the decoder byte-for-byte against
  Node's zlib across every file in all four archives (512 files, 9.7 MiB, 0 mismatches).
- **Textures lie about their format.** The Quarm repack stores DDS payloads under `.bmp`
  filenames, so the decoder dispatches on the magic bytes, not the extension. DXT1's
  1-bit alpha already carries the foliage cutouts, so alpha-testing the tree and fire
  textures needs no special-casing.
- **Vertex colours are not a lighting solution.** They hold the contribution of *placed
  lights only* — they average 0.12 across the zone and fall to zero in open terrain. The
  original client added them to a zone-wide ambient level, so the shader does
  `clamp(ambient + vertexColor)` rather than multiplying. Multiplying is what makes
  naive EQ viewers render outdoor terrain pitch black.
- **Placed objects carry their own baked lighting**, per instance, in `0x32` vertex colour
  lists reached via `0x15 -> 0x33 -> 0x32`. All 283 Blackburrow placements have one.
- **Character meshes are stored in bone-local space** — every bone group's centroid sits
  at the origin, so a character rendered as authored collapses into a ball. `skeleton.js`
  walks the `0x10` bone tree, resolves each bone's `0x13 -> 0x12` track and accumulates
  frame 0 into a bind pose. That's static posing only; no animation is played back.
- **Track frames are eight `int16`s and the *trailing* value is the shift denominator.**
  Both readings look plausible on most tracks, but `ALL_TRACKDEF` has a zero in that slot
  — under the other reading it's a divide-by-zero, which settles it.
- **An NPC's `texture` field selects a whole material *set*, not a piece.** Materials are
  `<RACE><PART><SET><PIECE>`; the gnoll ships four complete sets (`gnnch0001-3`,
  `gnnch0101-3`, `gnnch0201-3`, `gnnch0301-3`). Substituting the piece index instead
  leaves every NPC in set 00 — Blackburrow's gnolls (texture 2, the dark blue set) come
  out in the pale Splitpaw colours.
- **EQ is Z-up**; the renderer maps `(x, y, z)eq -> (x, z, -y)gl`, a rotation about X that
  preserves winding. The HUD reports EQ coordinates so they match `/loc` and map data.
- **Texture V coordinates are used as-is.** Going from D3D to OpenGL usually means
  flipping V, but these textures decode with row 0 as the image's top row and GL maps
  data row 0 to `t=0`, so the two conventions already agree. Flipping renders every
  sign, banner and shield upside down — subtle enough on rock and grass to miss, obvious
  the moment you read a tavern sign.
- **Spawn points come from object placements.** Scoring purely by open space picks the
  *outside* of an enclosed city like Neriak, and the highest-scoring interior spots are
  rooftops — so candidates are drawn from where objects cluster, and the lowest of the
  top scorers wins, which lands you in the street.

The 2282 zone meshes (one per BSP region) are merged into ~110 draw calls batched by
material. Collision uses zone geometry only — decorative objects would otherwise snag you
constantly — and skips blended materials so you can wade into water.

## Tests

```bash
node test/verify-inflate.mjs   # decoder vs. node zlib, byte-for-byte
node test/inspect.mjs          # what the parsers extract from a zone
node test/tour.mjs             # screenshots at five zone locations
node test/verify-ui.mjs        # drives the settings sliders and captures the result
node test/verify-zones.mjs     # switches through every zone in the dropdown
node test/find-spawns.mjs <z>  # computes a validated spawn point for a zone
node test/build-npcs.mjs 17 blackburrow   # rebuild NPC spawns from the Quarm DB
node test/survey.mjs <dir>     # runs the pipeline over a whole EQ client directory
```

The screenshot tests need a server running and drive headless Chrome over a hand-rolled
CDP client (`test/cdp.mjs`) — Node 20 has no global `WebSocket`, so the WebSocket framing
is implemented there directly.

## Not implemented

Audio (the `.emt`/`.eff`/`.xmi` files are in `data/` but unused), NPC and player character
models, skeletal animation, BSP-based visibility culling, zone line triggers, and
day/night cycling, and NPC behaviour of any kind — spawns are static props.

NPCs are posed but not animated: `skeleton.js` applies frame 0 of each bone's track and
stops there. Five of Blackburrow's 122 spawn points are skipped — four razorgills need a
fish model that isn't in either `blackburrow_chr.s3d` or `global_chr.s3d`, and Scout
Malityn is a human, which would mean shipping 7.1 MB of `global_chr.s3d` for one NPC.
Spawn headings are also invented: the database exposes coordinates but not `heading`, so
each NPC's facing is derived from a hash of its position.

## Assets

`data/` contains EverQuest zone data, which is the property of Daybreak Game Company /
Darkpaw Games. It's included here so the demo runs without setup. The engine code is the
original work; the game assets are not, and are used for interoperability and
preservation purposes. If you'd rather use your own client's files, the loader falls back
to a file picker when `data/` is absent.
