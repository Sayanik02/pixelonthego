// ============================================================
//   OP FAST BUILDER — uses /fill with greedy rectangle merging
//   Needs the bot to be OP (permission level 2+).
// ============================================================

const config = require('./config');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MAX_FILL = 32768;
const MAX_Y = 319;   // 1.20.4 build limit

// /fill a box, split so no single command goes over the 32768-block limit
async function fillBox(bot, x1, y1, z1, x2, y2, z2, block, delay) {
  const dx = x2 - x1 + 1, dy = y2 - y1 + 1, dz = z2 - z1 + 1;
  if (dx <= 0 || dy <= 0 || dz <= 0) return 0;
  const xStep = Math.max(1, Math.min(dx, Math.floor(MAX_FILL / dy)));
  const zStep = Math.max(1, Math.floor(MAX_FILL / (xStep * dy)));
  let n = 0;
  for (let z = z1; z <= z2; z += zStep) {
    for (let x = x1; x <= x2; x += xStep) {
      bot.chat(`/fill ${x} ${y1} ${z} ${Math.min(x + xStep - 1, x2)} ${y2} ${Math.min(z + zStep - 1, z2)} minecraft:${block}`);
      n++;
      if (delay > 0) await sleep(delay);
    }
  }
  return n;
}

// Get a band of rows ready for art:
//   1. lay a solid stone layer one block DOWN first (so sand can never fall, not even for a tick)
//   2. wipe EVERYTHING above the art layer, all the way up (trees, hills, grass, water, lava...)
async function clearAndSupport(bot, originX, originY, originZ, W, r0, r1, delay) {
  const cfgH = config.build.clearHeight;
  const top = (cfgH === 'max' || cfgH == null) ? MAX_Y : Math.min(originY + cfgH, MAX_Y);
  const x1 = originX, x2 = originX + W - 1;
  const z1 = originZ + r0, z2 = originZ + r1 - 1;
  await fillBox(bot, x1, originY - 1, z1, x2, originY - 1, z2, 'stone', delay);
  await fillBox(bot, x1, originY + 1, z1, x2, top, z2, 'air', delay);
}

// Merge a band of rows [r0, r1) into as few rectangles as possible
function bandRects(grid, r0, r1) {
  const W = grid[0].length;
  const used = [];
  for (let r = r0; r < r1; r++) used.push(new Uint8Array(W));
  const rects = [];

  for (let r = r0; r < r1; r++) {
    for (let c = 0; c < W; c++) {
      const name = grid[r][c];
      if (!name || used[r - r0][c]) continue;

      let w = 1;
      while (c + w < W && grid[r][c + w] === name && !used[r - r0][c + w]) w++;

      let h = 1;
      outer:
      while (r + h < r1 && (h + 1) * w <= MAX_FILL) {
        for (let cc = c; cc < c + w; cc++) {
          if (grid[r + h][cc] !== name || used[r + h - r0][cc]) break outer;
        }
        h++;
      }

      for (let rr = r; rr < r + h; rr++)
        for (let cc = c; cc < c + w; cc++) used[rr - r0][cc] = 1;

      rects.push({ c, r, w, h, name });
    }
  }
  return rects;
}

function countRects(grid, bandRows) {
  let n = 0;
  for (let r0 = 0; r0 < grid.length; r0 += bandRows)
    n += bandRects(grid, r0, Math.min(r0 + bandRows, grid.length)).length;
  return n;
}

// Small, harmless movement so the bot never looks idle. Stays within ~4 blocks of anchor.
function startAntiAfk(bot, anchor) {
  let stopped = false;
  const keys = ['forward', 'back', 'left', 'right'];
  (async () => {
    while (!stopped) {
      try {
        const p = bot.entity && bot.entity.position;
        if (p) {
          const far = Math.hypot(p.x - anchor.x, p.z - anchor.z) > 4 || Math.abs(p.y - anchor.y) > 4;
          if (far) {
            bot.chat(`/tp @s ${anchor.x} ${anchor.y} ${anchor.z}`);
            await sleep(600);
            continue;
          }
          await bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.8, true);
          const k = keys[Math.floor(Math.random() * keys.length)];
          bot.setControlState(k, true);
          await sleep(120 + Math.random() * 200);
          bot.setControlState(k, false);
          if (Math.random() < 0.5) bot.swingArm('right');
        }
      } catch (e) {}
      await sleep(1500 + Math.random() * 2500);
    }
    keys.forEach(k => { try { bot.setControlState(k, false); } catch (e) {} });
  })();
  return () => { stopped = true; };
}

// Check that the bot really is OP. Returns true/false.
function checkOp(bot) {
  return new Promise((resolve) => {
    const onMsg = (msg) => {
      if (/currently set to/i.test(msg)) { done(true); }
      else if (/unknown or incomplete|permission|not allowed/i.test(msg)) { done(false); }
    };
    const timer = setTimeout(() => done(false), 4000);
    function done(v) {
      clearTimeout(timer);
      bot.removeListener('messagestr', onMsg);
      resolve(v);
    }
    bot.on('messagestr', onMsg);
    bot.chat('/gamerule doDaylightCycle');
  });
}

// Returns 'done' | 'paused' | 'fallback'
async function buildWithOp(bot, grid, progress, ctl, opts = {}) {
  const prep = opts.prep !== false;   // clear above + support below (default on)
  const W = grid[0].length;
  const H = grid.length;
  const { originX, originY, originZ } = progress;
  const bandRows = config.build.opBandRows || 80;
  const delay    = config.build.opDelay ?? 20;

  console.log('[OP] Checking OP permission...');
  if (!(await checkOp(bot))) {
    console.log('[OP] ❌ Bot is NOT op (or server did not answer). Run "op ' + bot.username + '" in the server console. Falling back to slow mode.');
    return 'fallback';
  }
  console.log('[OP] ✅ OP confirmed. Using /fill mode.');

  // Go to the start of the build area and stay around there
  const anchor = { x: originX + 2, y: originY + 3, z: originZ + 2 };
  bot.chat('/gamemode creative');
  bot.chat(`/tp @s ${anchor.x} ${anchor.y} ${anchor.z}`);
  await sleep(2000);
  try { bot.creative.startFlying(); } catch (e) {}
  console.log(`[OP] Teleported to build start (${anchor.x}, ${anchor.y}, ${anchor.z}).`);
  const stopAfk = startAntiAfk(bot, anchor);

  let failures = 0;
  const onMsg = (m) => { if (/not loaded|cannot|unknown or incomplete|too big|out of the world/i.test(m)) failures++; };
  bot.on('messagestr', onMsg);

  try {
    // Saved progress can lie (e.g. from an old slow run that failed). If far fewer
    // blocks are recorded than the rows claimed done, start again from row 0.
    let startRow = progress.lastRow;
    if (startRow > 0 && progress.totalPlaced < startRow * W * 0.9) {
      console.log(`[OP] Saved progress looks wrong (row ${startRow} but only ${progress.totalPlaced} blocks) - restarting from row 0.`);
      startRow = 0;
      progress.totalPlaced = 0;
    }

    for (let r0 = startRow; r0 < H; r0 += bandRows) {
      if (!ctl.isBuilding()) { console.log('[OP] Paused.'); return 'paused'; }
      const r1 = Math.min(r0 + bandRows, H);

      const fx1 = originX, fx2 = originX + W - 1;
      const fz1 = originZ + r0, fz2 = originZ + r1 - 1;

      const rects = bandRects(grid, r0, r1);
      if (rects.length === 0 && !prep) { progress.lastRow = r1; continue; }

      // Force-load this band's chunks (bot stays at the start area)
      bot.chat(`/forceload add ${fx1} ${fz1} ${fx2} ${fz2}`);
      await sleep(3500); // let chunks load

      let area = 0;
      for (const q of rects) area += q.w * q.h;

      // Fills are idempotent, so a failed band can safely be re-run once
      for (let attempt = 0; attempt < 2; attempt++) {
        failures = 0;
        if (prep) {
          await clearAndSupport(bot, originX, originY, originZ, W, r0, r1, delay);
          // keep the gold screenshot marker (clearing removes it)
          if (progress.centerX != null && progress.centerZ != null && progress.centerZ >= fz1 && progress.centerZ <= fz2)
            bot.chat(`/setblock ${progress.centerX} ${originY + 1} ${progress.centerZ} minecraft:gold_block`);
        }
        for (const q of rects) {
          if (!ctl.isBuilding()) { console.log('[OP] Paused.'); return 'paused'; }
          const x1 = originX + q.c,           z1 = originZ + q.r;
          const x2 = originX + q.c + q.w - 1, z2 = originZ + q.r + q.h - 1;
          bot.chat(`/fill ${x1} ${originY} ${z1} ${x2} ${originY} ${z2} minecraft:${q.name}`);
          if (delay > 0) await sleep(delay);
        }
        await sleep(1000);
        if (failures === 0) break;
        console.log(`[OP] ⚠️ ${failures} error message(s) in rows ${r0}-${r1}` + (attempt === 0 ? ', retrying band...' : ', moving on.'));
        await sleep(2000);
      }
      progress.totalPlaced += area;
      bot.chat(`/forceload remove ${fx1} ${fz1} ${fx2} ${fz2}`);

      progress.lastRow = r1;
      progress.lastCol = 0;
      ctl.save();
      console.log(`[OP] Rows ${r1}/${H} done (${rects.length} fills)`);
    }
  } finally {
    bot.removeListener('messagestr', onMsg);
    stopAfk();
  }
  return 'done';
}

// OP terrain prep: clear everything above, support layer below, stone art layer
async function prepWithOp(bot, originX, originY, originZ, W, H) {
  const bandRows = 80;
  const delay = Math.max(config.build.opDelay ?? 20, 20);
  bot.chat(`/tp @s ${originX + 2} ${originY + 3} ${originZ + 2}`);
  await sleep(1500);
  for (let r0 = 0; r0 < H; r0 += bandRows) {
    const r1 = Math.min(r0 + bandRows, H);
    const z1 = originZ + r0, z2 = originZ + r1 - 1, x2 = originX + W - 1;
    bot.chat(`/forceload add ${originX} ${z1} ${x2} ${z2}`);
    await sleep(3500);
    await clearAndSupport(bot, originX, originY, originZ, W, r0, r1, delay);
    await fillBox(bot, originX, originY, z1, x2, originY, z2, 'stone', delay);
    await sleep(500);
    bot.chat(`/forceload remove ${originX} ${z1} ${x2} ${z2}`);
    console.log(`[OP] Prep rows ${r1}/${H}`);
  }
}

module.exports = { buildWithOp, prepWithOp, bandRects, countRects, checkOp };
