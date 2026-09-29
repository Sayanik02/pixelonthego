// ============================================================
//   WORLD SCANNER — reads the REAL blocks from the server
//   and makes a top-down map of the build area showing:
//     - what is actually placed (colors)
//     - wrong / missing blocks
//     - trees, water, lava and other obstacles above the layer
//   Needs the bot to be OP (uses /tp to hop between tiles).
// ============================================================

const Jimp = require('jimp');
const { Vec3 } = require('vec3');
const config = require('./config');
const { BLOCK_PALETTE } = require('./blockPalette');
const { checkOp } = require('./opBuilder');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const WORLD_PATH = `${VOLUME}/world.png`;

const TILE   = 80;   // blocks per scan tile (bot stands in the middle)
const SCAN_H = 40;   // how many blocks above the build layer to check

// categories
const OK = 0, TREE = 1, WATER = 2, LAVA = 3, OTHER = 4, PLANT = 5, WRONG = 6, UNKNOWN = 7;
const CAT_COLOR = {
  [TREE]:    [20, 100, 30],
  [WATER]:   [40, 90, 230],
  [LAVA]:    [255, 110, 0],
  [OTHER]:   [235, 60, 210],
  [WRONG]:   [255, 0, 0],
  [UNKNOWN]: [45, 45, 45],
};

function categorize(name) {
  if (/(_log|_wood|_stem|_hyphae|_leaves|mangrove_roots)$/.test(name)) return TREE;
  if (/^(water|kelp|kelp_plant|seagrass|tall_seagrass|bubble_column)$/.test(name)) return WATER;
  if (name === 'lava') return LAVA;
  if (/(grass|fern|dead_bush|^snow$|vine|flower|dandelion|poppy|orchid|allium|azure_bluet|tulip|oxeye|cornflower|lily|rose_bush|peony|lilac|sunflower|mushroom|sapling|bush|roots|moss_carpet)/.test(name)) return PLANT;
  return OTHER;
}

const state = {
  status: 'idle',       // idle | running | done | error
  message: '',
  tilesDone: 0,
  tilesTotal: 0,
  finishedAt: null,
  counts: null,
  samples: [],
};
function getScanState() { return state; }

async function scanWorld(bot, grid, progress) {
  if (state.status === 'running') return;
  const W = grid[0].length, H = grid.length;
  const { originX, originY, originZ } = progress;

  state.status = 'running';
  state.message = 'Checking OP...';
  state.tilesDone = 0;
  state.counts = null;
  state.samples = [];

  try {
    if (!(await checkOp(bot))) throw new Error('Bot is not OP - scanning needs /tp');

    const airIds = new Set();
    for (const n of ['air', 'cave_air', 'void_air']) {
      const b = bot.registry.blocksByName[n];
      if (b) for (let s = b.minStateId; s <= b.maxStateId; s++) airIds.add(s);
    }
    const nameOf = (id) => (bot.registry.blocksByStateId[id] || {}).name || 'unknown';
    const paletteRGB = new Map(BLOCK_PALETTE.map(p => [p.block, [p.r, p.g, p.b]]));

    const cat = new Uint8Array(W * H);
    const mismatch = new Uint8Array(W * H); // 1 = layer block differs from the image (fixable by repair)
    const rgb = new Uint8Array(W * H * 3);
    const counts = { ok: 0, tree: 0, water: 0, lava: 0, other: 0, plant: 0, wrong: 0, unknown: 0 };
    const byName = {};

    const tilesX = Math.ceil(W / TILE), tilesZ = Math.ceil(H / TILE);
    state.tilesTotal = tilesX * tilesZ;
    const pos = new Vec3(0, 0, 0);

    try { bot.creative.startFlying(); } catch (e) {}

    for (let tz = 0; tz < tilesZ; tz++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const c0 = tx * TILE, c1 = Math.min(c0 + TILE, W);
        const r0 = tz * TILE, r1 = Math.min(r0 + TILE, H);
        const cxw = originX + Math.floor((c0 + c1) / 2);
        const czw = originZ + Math.floor((r0 + r1) / 2);

        state.message = `Scanning tile ${state.tilesDone + 1}/${state.tilesTotal}`;
        bot.chat(`/tp @s ${cxw} ${originY + SCAN_H + 5} ${czw}`);

        // wait until every chunk of this tile is loaded (max 10s)
        const t0 = Date.now();
        while (Date.now() - t0 < 10000) {
          let all = true;
          for (let x = originX + c0; x < originX + c1 && all; x += 16)
            for (let z = originZ + r0; z < originZ + r1; z += 16) {
              pos.x = x; pos.y = originY; pos.z = z;
              if (!bot.world.getColumnAt(pos)) { all = false; break; }
            }
          if (all) break;
          await sleep(200);
        }
        await sleep(400);

        let sampleTaken = false;
        for (let r = r0; r < r1; r++) {
          for (let c = c0; c < c1; c++) {
            const wx = originX + c, wz = originZ + r;
            const idx = r * W + c;
            pos.x = wx; pos.y = originY; pos.z = wz;
            const column = bot.world.getColumnAt(pos);
            if (!column) { cat[idx] = UNKNOWN; counts.unknown++; continue; }

            const local = new Vec3(wx & 15, originY, wz & 15);
            const layerId = column.getBlockStateId(local);
            const layerName = nameOf(layerId);
            let obstacle = null;
            for (let dy = 1; dy <= SCAN_H; dy++) {
              local.y = originY + dy;
              const id = column.getBlockStateId(local);
              if (!airIds.has(id)) { obstacle = nameOf(id); break; }
            }

            const expected = grid[r][c];
            if (expected && layerName !== expected) mismatch[idx] = 1;
            const col = paletteRGB.get(layerName) || [120, 120, 120];
            rgb[idx * 3] = col[0]; rgb[idx * 3 + 1] = col[1]; rgb[idx * 3 + 2] = col[2];

            if (obstacle) {
              const k = categorize(obstacle);
              cat[idx] = k;
              if (k === TREE)  counts.tree++;
              else if (k === WATER) counts.water++;
              else if (k === LAVA)  counts.lava++;
              else if (k === PLANT) counts.plant++;
              else counts.other++;
              if (k !== PLANT) {
                byName[obstacle] = (byName[obstacle] || 0) + 1;
                if (!sampleTaken && state.samples.length < 12) {
                  state.samples.push(`${obstacle} at (${wx}, ${originY + 1}, ${wz})`);
                  sampleTaken = true;
                }
              }
            } else if (expected && layerName !== expected) {
              cat[idx] = WRONG; counts.wrong++;
            } else {
              cat[idx] = OK; counts.ok++;
            }
          }
        }
        state.tilesDone++;
      }
    }

    // go back to the start area
    bot.chat(`/tp @s ${originX + 2} ${originY + 3} ${originZ + 2}`);

    // ---- render the map ----
    state.message = 'Rendering map...';
    const S = 2, LEG = 90;
    const img = new Jimp(W * S, H * S + LEG, 0x14142aff);
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const idx = r * W + c;
        let col;
        const k = cat[idx];
        if (CAT_COLOR[k]) col = CAT_COLOR[k];
        else col = [rgb[idx * 3], rgb[idx * 3 + 1], rgb[idx * 3 + 2]];
        const v = Jimp.rgbaToInt(col[0], col[1], col[2], 255);
        for (let dy = 0; dy < S; dy++)
          for (let dx = 0; dx < S; dx++) img.setPixelColor(v, c * S + dx, r * S + dy);
      }
    }

    // legend
    const legend = [
      ['OK',          [200, 200, 200], counts.ok + counts.plant],
      ['Trees',       CAT_COLOR[TREE],    counts.tree],
      ['Water',       CAT_COLOR[WATER],   counts.water],
      ['Lava',        CAT_COLOR[LAVA],    counts.lava],
      ['Other block', CAT_COLOR[OTHER],   counts.other],
      ['Wrong block', CAT_COLOR[WRONG],   counts.wrong],
      ['Not loaded',  CAT_COLOR[UNKNOWN], counts.unknown],
    ];
    let font = null;
    try { font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE); } catch (e) {}
    legend.forEach(([label, col, n], i) => {
      const lx = 12 + (i % 4) * 245, ly = H * S + 12 + Math.floor(i / 4) * 34;
      const v = Jimp.rgbaToInt(col[0], col[1], col[2], 255);
      for (let y = 0; y < 18; y++) for (let x = 0; x < 18; x++) img.setPixelColor(v, lx + x, ly + y);
      if (font) img.print(font, lx + 26, ly, `${label}: ${n}`);
    });
    await img.writeAsync(WORLD_PATH);

    state.counts = counts;
    state.mismatch = mismatch;
    state.W = W; state.H = H;
    state.byName = byName;
    state.finishedAt = new Date();
    state.status = 'done';
    state.message = 'Scan complete';
    console.log('[Scan] Done:', JSON.stringify(counts));
    if (state.samples.length) console.log('[Scan] Obstacles: ' + state.samples.join(' | '));
  } catch (e) {
    state.status = 'error';
    state.message = e.message;
    console.log('[Scan] Failed: ' + e.message);
  }
}

module.exports = { scanWorld, getScanState, WORLD_PATH };
