// ============================================================
//   MINECRAFT PIXEL ART BOT - MAIN FILE
//   Control via Aternos console commands:
//
//   pixel prepare          - Prep terrain at world spawn
//   pixel start                  - Start building (after image dropped)
//   pixel stop                   - Pause build
//   pixel status                 - Show progress
//   pixel resume                 - Resume after restart
//   pixel center                 - Show screenshot coordinates
// ============================================================

const mineflayer = require('mineflayer');
const config = require('./config');
const { loadProgress, saveProgress, clearBuildProgress, logSkipped, markBanned } = require('./progressManager');
const { watchForImage, processImage, isImageReady } = require('./imageProcessor');
const { prepareTerrain } = require('./terrain');

// ── State ─────────────────────────────────────────────────────
let bot = null;
let progress = loadProgress();
let blockGrid = null;
let isBuilding = false;
let isPreparing = false;
let reconnectAttempts = 0;
let currentUsername = null;
let currentUsernameIndex = progress.currentUsernameIndex || 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Username rotation ─────────────────────────────────────────
function getNextUsername() {
  const usernames = config.bot.usernames;
  const banned = new Set(progress.bannedUsernames || []);

  for (let i = 0; i < usernames.length; i++) {
    const idx = (currentUsernameIndex + i) % usernames.length;
    if (!banned.has(usernames[idx])) {
      currentUsernameIndex = (idx + 1) % usernames.length;
      progress.currentUsernameIndex = currentUsernameIndex;
      return usernames[idx];
    }
  }

  // All banned — reset banned list and start over
  console.log('[Bot] All usernames banned! Resetting ban list...');
  progress.bannedUsernames = [];
  currentUsernameIndex = 0;
  progress.currentUsernameIndex = 0;
  return usernames[0];
}

// ── Create bot ────────────────────────────────────────────────
function createBot() {
  currentUsername = getNextUsername();
  console.log(`\n[Bot] Connecting as "${currentUsername}" to ${config.server.host}:${config.server.port}`);

  bot = mineflayer.createBot({
    host: config.server.host,
    port: config.server.port,
    username: currentUsername,
    version: config.server.version,
    auth: 'offline',
  });

  bot.once('spawn', onSpawn);
  bot.on('message', (jsonMsg) => {
  try {
    const text = jsonMsg.toString();
    onMessage(text);
  } catch(e) {
    console.log('[Bot] Chat parse error (ignored):', e.message);
  }
});
  bot.on('kicked', onKicked);
  bot.on('error', onError);
process.on('uncaughtException', (err) => {
  console.error('[Bot] Uncaught error (continuing):', err.message);
});
  bot.on('end', onEnd);
}

// ── On spawn ──────────────────────────────────────────────────
async function onSpawn() {
  console.log(`[Bot] ✅ Spawned as "${currentUsername}"!`);
  reconnectAttempts = 0;
  await sleep(2000);

  // Auto-resume build if we were building before disconnect
  if (progress.originX !== null && progress.totalPlaced > 0 && !isBuilding) {
    console.log('[Bot] Auto-resuming previous build...');
    bot.chat(`[PixelBot] Reconnected! Resuming build from row ${progress.lastRow}...`);
    await resumeBuild();
  } else {
    console.log('[Bot] Ready! Use Aternos console: "pixel prepare <x> <y> <z>"');
  }
}

// ── Console command handler ───────────────────────────────────
async function onMessage(msg) {
  if (typeof msg !== 'string') return;
  msg = msg.trim();

  // Detect console commands — Aternos console messages appear as server messages
  // Format: "[Console] pixel prepare 100 64 200"  OR just "pixel prepare 100 64 200"
  const raw = msg.replace(/\[.*?\]/g, '').trim().toLowerCase();

  if (!raw.startsWith('pixel ')) return;

  const parts = raw.split(/\s+/);
  const command = parts[1];

  console.log(`[Console] Received command: ${raw}`);

  // ── pixel prepare ──
  if (command === 'prepare') {
    if (isPreparing || isBuilding) {
      console.log('[Console] Bot is busy. Use pixel stop first.');
      return;
    }

    isPreparing = true;
    progress.prepDone = false;
    saveProgress(progress);

    console.log(`[Bot] Starting terrain prep centered on world spawn...`);
    bot.chat(`[PixelBot] Starting terrain prep at world spawn...`);

    try {
      const result = await prepareTerrain(bot);

      // Save origin from auto-detected spawn
      progress.originX = result.originX;
      progress.originY = result.originY;
      progress.originZ = result.originZ;
      progress.centerX = result.centerX;
      progress.centerZ = result.centerZ;
      progress.prepDone = true;
      saveProgress(progress);

      console.log(`[Bot] ✅ Terrain prep complete!`);
      console.log(`[Bot] 📍 Build origin: (${result.originX}, ${result.originY}, ${result.originZ})`);
      console.log(`[Bot] 📍 Gold block center at: (${result.centerX}, ${result.originY}, ${result.centerZ})`);
      console.log(`[Bot] 📸 Screenshot from: Y${result.originY + 400} above center`);
      console.log(`[Bot] ➡️  Drop your image in images/input.png then type: pixel start`);
      bot.chat(`[PixelBot] Prep done! Drop image as input.png then: pixel start`);
    } catch (e) {
      console.error(`[Bot] Prep error: ${e.message}`);
      bot.chat(`[PixelBot] Prep failed: ${e.message}`);
    }

    isPreparing = false;
    return;
  }

  // ── pixel start ──
  if (command === 'start') {
    if (isBuilding) {
      console.log('[Console] Already building! Use pixel stop first.');
      return;
    }
    if (!progress.prepDone && progress.originX === null) {
      console.log('[Console] Run pixel prepare first!');
      return;
    }
    if (!isImageReady()) {
      console.log('[Console] No image found! Drop input.png in the images/ folder first.');
      return;
    }

    clearBuildProgress(progress);
    console.log('[Bot] Starting pixel art build!');
    bot.chat(`[PixelBot] Starting pixel art build! ${config.image.width}x${config.image.height} blocks`);
    await startBuilding();
    return;
  }

  // ── pixel resume ──
  if (command === 'resume') {
    if (isBuilding) {
      console.log('[Console] Already building!');
      return;
    }
    await resumeBuild();
    return;
  }

  // ── pixel stop ──
  if (command === 'stop') {
    isBuilding = false;
    isPreparing = false;
    console.log('[Bot] Build stopped.');
    bot.chat('[PixelBot] Build paused. Use pixel resume to continue.');
    return;
  }

  // ── pixel status ──
  if (command === 'status') {
    const total = config.image.width * config.image.height;
    const pct = progress.totalPlaced > 0 ? ((progress.totalPlaced / total) * 100).toFixed(1) : '0.0';
    console.log(`[Status] Blocks placed: ${progress.totalPlaced}/${total} (${pct}%)`);
    console.log(`[Status] Current position: row ${progress.lastRow}/${config.image.height}, col ${progress.lastCol}`);
    console.log(`[Status] Origin: (${progress.originX}, ${progress.originY}, ${progress.originZ})`);
    console.log(`[Status] Building: ${isBuilding}`);
    bot.chat(`[PixelBot] ${progress.totalPlaced}/${total} blocks (${pct}%) | Row ${progress.lastRow}/${config.image.height}`);
    return;
  }

  // ── pixel center ──
  if (command === 'center') {
    if (!progress.originX) {
      console.log('[Console] No build origin set yet.');
      return;
    }
    const cx = progress.centerX || Math.floor(progress.originX + config.image.width / 2);
    const cz = progress.centerZ || Math.floor(progress.originZ + config.image.height / 2);
    const cy = progress.originY;
    console.log(`[Bot] 📍 Build center: ${cx}, ${cy}, ${cz}`);
    console.log(`[Bot] 📸 Screenshot position: fly to ${cx}, ${cy + 400}, ${cz} and look straight down`);
    console.log(`[Bot] 📸 Or use: /tp @s ${cx} ${cy + 400} ${cz}`);
    bot.chat(`[PixelBot] Center: ${cx},${cy},${cz} | Screenshot from Y:${cy + 400} above`);
    return;
  }

  console.log(`[Console] Unknown command: ${command}`);
  console.log('[Console] Available: pixel prepare <x> <y> <z> | pixel start | pixel stop | pixel resume | pixel status | pixel center');
}

// ── Resume build after reconnect ──────────────────────────────
async function resumeBuild() {
  if (!isImageReady()) {
    console.log('[Bot] Cannot resume - no image found. Drop input.png in images/ folder.');
    return;
  }
  console.log(`[Bot] Resuming from row ${progress.lastRow}, col ${progress.lastCol}...`);

  // Fly back to last position
  if (progress.originX !== null) {
    const targetX = progress.originX + progress.lastCol;
    const targetY = progress.originY + config.build.flyHeight;
    const targetZ = progress.originZ + progress.lastRow;

    try {
      bot.creative.startFlying();
      await bot.creative.flyTo({ x: targetX, y: targetY, z: targetZ });
      console.log(`[Bot] Flew back to build position`);
    } catch (e) {
      console.log(`[Bot] Fly error: ${e.message}`);
    }
  }

  await startBuilding();
}

// ── Main build loop ───────────────────────────────────────────
async function startBuilding() {
  if (isBuilding) return;
  isBuilding = true;

  // Process image if not done yet
  if (!blockGrid) {
    console.log('[Bot] Processing image...');
    try {
      blockGrid = await processImage();
    } catch (e) {
      console.error(`[Bot] Image error: ${e.message}`);
      isBuilding = false;
      return;
    }
  }

  const W = config.image.width;
  const H = config.image.height;
  let blocksSinceSave = 0;

  bot.creative.startFlying();

  outer:
  for (let row = progress.lastRow; row < H; row++) {
    for (let col = (row === progress.lastRow ? progress.lastCol : 0); col < W; col++) {
      if (!isBuilding) {
        console.log('[Bot] Build paused.');
        break outer;
      }

      const blockName = blockGrid[row][col];
      if (!blockName) continue;

      const x = progress.originX + col;
      const y = progress.originY;
      const z = progress.originZ + row;

      // Fly above target
      try {
        await bot.creative.flyTo({ x, y: y + config.build.flyHeight, z });
      } catch (e) { /* continue even if fly fails */ }

      const placed = await placeWithRetry(x, y, z, blockName);

      if (placed) {
        progress.totalPlaced++;
        blocksSinceSave++;

        if (blocksSinceSave >= config.build.saveEvery) {
          progress.lastRow = row;
          progress.lastCol = col;
          saveProgress(progress);
          blocksSinceSave = 0;
          console.log(`[Bot] Saved: ${progress.totalPlaced} blocks | Row ${row}/${H}`);
        }
      }

      await sleep(config.build.placeDelay);
    }

    // Save at end of each row
    progress.lastRow = row + 1;
    progress.lastCol = 0;
    saveProgress(progress);

    if ((row + 1) % 10 === 0) {
      const pct = (((row + 1) / H) * 100).toFixed(1);
      console.log(`[Bot] Row ${row + 1}/${H} complete (${pct}%) | ${progress.totalPlaced} blocks placed`);
    }
  }

  if (isBuilding) {
    isBuilding = false;
    console.log(`[Bot] 🎉 BUILD COMPLETE! ${progress.totalPlaced} blocks placed.`);
    console.log(`[Bot] Check skipped.log for any skipped blocks.`);
    bot.chat(`[PixelBot] Build complete! ${progress.totalPlaced} blocks placed!`);
  }
}

// ── Place block with retry ────────────────────────────────────
async function placeWithRetry(x, y, z, blockName) {
  for (let attempt = 1; attempt <= config.build.retryAttempts; attempt++) {
    try {
      const existing = bot.blockAt({ x, y, z });

      if (existing && existing.name !== 'air' && existing.name !== blockName) {
        if (attempt < config.build.retryAttempts) {
          console.log(`[Bot] Obstacle at (${x},${y},${z}): ${existing.name} | Retry ${attempt}/${config.build.retryAttempts} in ${config.build.retryDelay / 1000}s`);
          await sleep(config.build.retryDelay);
          continue;
        } else {
          logSkipped(x, y, z, blockName, `Blocked by ${existing.name}`);
          return false;
        }
      }

      const blockId = bot.registry.blocksByName[blockName]?.id;
      if (blockId === undefined) {
        logSkipped(x, y, z, blockName, `Unknown block: ${blockName}`);
        return false;
      }

      await bot.creative.setBlock({ x, y, z }, blockId);
      return true;

    } catch (e) {
      if (attempt < config.build.retryAttempts) {
        await sleep(config.build.retryDelay);
      } else {
        logSkipped(x, y, z, blockName, `Error: ${e.message}`);
        return false;
      }
    }
  }
  return false;
}

// ── Disconnect handlers ───────────────────────────────────────
async function onKicked(reason) {
  const r = reason.toString().toLowerCase();
  console.log(`[Bot] Kicked: ${reason}`);
  isBuilding = false;
  isPreparing = false;

  if (r.includes('ban') || r.includes('permanent')) {
    console.log(`[Bot] "${currentUsername}" is BANNED. Switching username...`);
    markBanned(progress, currentUsername);
  }

  await scheduleReconnect();
}

async function onError(err) {
  console.error(`[Bot] Error: ${err.message}`);
  isBuilding = false;
  isPreparing = false;
  await scheduleReconnect();
}

async function onEnd() {
  console.log('[Bot] Disconnected.');
  isBuilding = false;
  isPreparing = false;
  await scheduleReconnect();
}

async function scheduleReconnect() {
  if (reconnectAttempts >= config.bot.maxReconnectAttempts) {
    console.error('[Bot] Max reconnect attempts reached.');
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(config.bot.reconnectDelay * reconnectAttempts, 30000);
  console.log(`[Bot] Reconnecting in ${delay / 1000}s... (attempt ${reconnectAttempts})`);
  await sleep(delay);
  createBot();
}

// ── Watch for image drop ──────────────────────────────────────
watchForImage(() => {
  console.log('\n[Bot] 🖼️  Image detected in images/ folder!');
  console.log('[Bot] ➡️  Use Aternos console: pixel start');
});

// ── Start ─────────────────────────────────────────────────────
console.log('================================================');
console.log('  MINECRAFT PIXEL ART BOT');
console.log('================================================');
console.log(`  Server : ${config.server.host}:${config.server.port}`);
console.log(`  Size   : ${config.image.width}x${config.image.height} blocks`);
console.log(`  Image  : ${config.image.path}`);
console.log('------------------------------------------------');
console.log('  CONSOLE COMMANDS:');
console.log('  pixel prepare   - Prep terrain at world spawn');
console.log('  pixel start                 - Start building');
console.log('  pixel stop                  - Pause');
console.log('  pixel resume                - Resume');
console.log('  pixel status                - Show progress');
console.log('  pixel center                - Screenshot coords');
console.log('================================================\n');

createBot();
