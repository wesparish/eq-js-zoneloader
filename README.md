# EQ Zone Walker

A dependency-free, first-person WebGL2 viewer for original EverQuest zone data. It reads
the shipped `.s3d` archives directly in the browser — no conversion step, no build step,
no libraries — and lets you walk around the zone with WASD and mouselook.

Three zones ship in `data/`, switchable from a dropdown without a page reload:
**Blackburrow** (gnoll warren), **Neriak Foreign Quarter** (dark elf city) and
**Rivervale** (halfling village).

**[Live demo](https://wesparish.github.io/eq-js-zoneloader/)** — loads in a few seconds, no install.

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
| `[` `]` and `-` `=` | brightness and zone ambient |
| `tab` | show/hide the settings panel |
| `H` | hide the help panel |

The settings panel exposes lighting, fog, FOV, move speed and mouse sensitivity as
sliders, with a reset button. `window.eq` is available in the console — `eq.tp(x, y, z)`
teleports using EQ coordinates.

## How it works

```
src/inflate.js     DEFLATE decoder
src/pfs.js         .s3d archive reader
src/wld.js         WLD fragment parser
src/textures.js    BMP and DDS (DXT1/3/5) decoders
src/zone.js        fragments -> merged, material-batched geometry
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
- **EQ is Z-up**; the renderer maps `(x, y, z)eq -> (x, z, -y)gl`, a rotation about X that
  preserves winding. The HUD reports EQ coordinates so they match `/loc` and map data.
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
node test/survey.mjs <dir>     # runs the pipeline over a whole EQ client directory
```

The screenshot tests need a server running and drive headless Chrome over a hand-rolled
CDP client (`test/cdp.mjs`) — Node 20 has no global `WebSocket`, so the WebSocket framing
is implemented there directly.

## Not implemented

Audio (the `.emt`/`.eff`/`.xmi` files are in `data/` but unused), NPC and player character
models, skeletal animation, BSP-based visibility culling, zone line triggers, and
day/night cycling. `*_chr.s3d` archives hold the NPC models but are gitignored — the
engine can't use them without skeletal animation, so they're dead weight.

## Assets

`data/` contains EverQuest zone data, which is the property of Daybreak Game Company /
Darkpaw Games. It's included here so the demo runs without setup. The engine code is the
original work; the game assets are not, and are used for interoperability and
preservation purposes. If you'd rather use your own client's files, the loader falls back
to a file picker when `data/` is absent.
