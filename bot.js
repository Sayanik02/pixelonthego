// ============================================================
//   MINECRAFT PIXEL ART BOT - MAIN FILE
//   Control via Aternos console:
//   say pixel prepare   - Prep terrain at world spawn
//   say pixel start     - Start building
//   say pixel stop      - Pause build
//   say pixel status    - Show progress
//   say pixel resume    - Resume after restart
//   say pixel center    - Show screenshot coordinates
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
let isReconnecting = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Global error catch — never crash ─────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[Bot] Uncaught error (ignored):', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[Bot] Unhandled rejection (ignored):', err.message || err);
});

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

  console.log('[Bot] All usernames banned! Resetting ban list...');
  progress.bannedUsernames = [];
  currentUsernameIndex = 0;
  progress.currentUsernameIndex = 0;
  return usernames[0];
}

// ── Create bot ────────────────────────────────────────────────
function createBot() {
  if (isReconnecting) return;

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

  // ── Chat handler — catches ALL message formats ──
  bot.on('message', (jsonMsg) => {
    try {
      let text = '';
      if (typeof jsonMsg === 'string') {
        text = jsonMsg;
      } else if (jsonMsg && typeof jsonMsg.toString === 'function') {
        text = jsonMsg.toString();
      }
      if (text) handleCommand(text);
    } catch (e) {
      // silently ignore any chat parse errors
    }
  });

  bot.on('kicked', onKicked);
  bot.on('error', (err) => {
    console.error('[Bot] Connection error:', err.message);
    isBuilding = false;
    isPreparing = false;
    scheduleReconnect();
  });
  bot.on('end', () => {
    console.log('[Bot] Disconnected.');
    isBuilding = false;
    isPreparing = false;
    scheduleReconnect();
  });
}

// ── On spawn ──────────────────────────────────────────────────
async function onSpawn() {
  console.log(`[Bot] ✅ Spawned as "${currentUsername}"!`);
  reconnectAttempts = 0;
  isReconnecting = false;
  await sleep(2000);

  if (progress.originX !== null && progress.totalPlaced > 0 && !isBuilding) {
    console.log('[Bot] Auto-resuming previous build...');
    await resumeBuild();
  } else {
    console.log('[Bot] Ready! Use: say pixel prepare');
  }
}

// ── Command handler ───────────────────────────────────────────
async function handleCommand(text) {
  // Strip all color codes and bracket sections, lowercase
  const clean = text.replace(/§./g, '').replace(/\[.*?\]/g, '').trim().toLowerCase();

  if (!clean.includes('pixel ')) return;

  // Extract just the pixel command part
  const match = clean.match(/pixel\s+(\w+)/);
  if (!match) return;

  const command = match[1];
  console.log(`[Console] Command received: pixel ${command}`);

  if (command === 'prepare') {
    if (isPreparing || isBuilding) {
      console.log('[Console] Bot is busy. Use: say pixel stop');
      return;
    }
    isPreparing = true;
    progress.prepDone = false;
    saveProgress(progress);
    console.log('[Bot] Starting terrain prep at world spawn...');

    try {
      const result = await prepareTerrain(bot);
      progress.originX = result.originX;
      progress.originY = result.originY;
      progress.originZ = result.originZ;
      progress.centerX = result.centerX;
      progress.centerZ = result.centerZ;
      progress.prepDone = true;
      saveProgress(progress);
      console.log('[Bot] ✅ Terrain prep complete!');
      console.log(`[Bot] 📍 Origin: (${result.originX}, ${result.originY}, ${result.originZ})`);
      console.log(`[Bot] 📍 Center gold block: (${result.centerX}, ${result.originY}, ${result.centerZ})`);
      console.log(`[Bot] 📸 Screenshot: fly to Y${result.originY + 400} above center`);
      console.log('[Bot] ➡️  Drop image as images/input.png then: say pixel start');
    } catch (e) {
      console.error('[Bot] Prep error:', e.message);
    }
    isPreparing = false;
    return;
  }

  if (command === 'start') {
    if (isBuilding) { console.log('[Console] Already building!'); return; }
    if (!progress.originX && !progress.prepDone) { console.log('[Console] Run: say pixel prepare first!'); return; }
    if (!isImageReady()) { console.log('[Console] Drop input.png in images/ folder first!'); return; }
    clearBuildProgress(progress);
    console.log('[Bot] Starting pixel art build!');
    await startBuilding();
    return;
  }

  if (command === 'resume') {
    if (isBuilding) { console.log('[Console] Already building!'); return; }
    await resumeBuild();
    return;
  }

  if (command === 'stop') {
    isBuilding = false;
    isPreparing = false;
    console.log('[Bot] Build stopped.');
    return;
  }

  if (command === 'status') {
    const total = config.image.width * config.image.height;
    const pct = ((progress.totalPlaced / total) * 100).toFixed(1);
    console.log(`[Status] ${progress.totalPlaced}/${total} blocks (${pct}%) | Row ${progress.lastRow}/${config.image.height}`);
    console.log(`[Status] Building: ${isBuilding} | Origin: (${progress.originX}, ${progress.originY}, ${progress.originZ})`);
    return;
  }

  if (command === 'center') {
    if (!progress.originX) { console.log('[Console] No origin set yet.'); return; }
    const cx = progress.centerX || Math.floor(progress.originX + config.image.width / 2);
    const cz = progress.centerZ || Math.floor(progress.originZ + config.image.height / 2);
    console.log(`[Bot] 📍 Center: ${cx}, ${progress.originY}, ${cz}`);
    console.log(`[Bot] 📸 Fly to: /tp @s ${cx} ${progress.originY + 400} ${cz} then look straight down`);
    return;
  }

  console.log(`[Console] Unknown: pixel ${command} | Try: prepare / start / stop / resume / status / center`);
}

// ── Resume build ──────────────────────────────────────────────
async function resumeBuild() {
  if (!isImageReady()) {
    console.log('[Bot] No image found. Drop input.png in images/ first.');
    return;
  }
  console.log(`[Bot] Resuming from row ${progress.lastRow}, col ${progress.lastCol}...`);

  if (progress.originX !== null) {
    try {
      bot.creative.startFlying();
      await bot.creative.flyTo({
        x: progress.originX + progress.lastCol,
        y: progress.originY + config.build.flyHeight,
        z: progress.originZ + progress.lastRow,
      });
    } catch (e) {
      console.log('[Bot] Fly error (continuing):', e.message);
    }
  }
  await startBuilding();
}

// ── Main build loop ───────────────────────────────────────────
async function startBuilding() {
  if (isBuilding) return;
  isBuilding = true;

  if (!blockGrid) {
    console.log('[Bot] Processing image...');
    try {
      blockGrid = await processImage();
      console.log('[Bot] Image processed! Starting build...');
    } catch (e) {
      console.error('[Bot] Image error:', e.message);
      isBuilding = false;
      return;
    }
  }

  const W = config.image.width;
  const H = config.image.height;
  let blocksSinceSave = 0;

  try { bot.creative.startFlying(); } catch (e) {}

  outer:
  for (let row = progress.lastRow; row < H; row++) {
    for (let col = (row === progress.lastRow ? progress.lastCol : 0); col < W; col++) {
      if (!isBuilding) { console.log('[Bot] Build paused.'); break outer; }

      const blockName = blockGrid[row][col];
      if (!blockName) continue;

      const x = progress.originX + col;
      const y = progress.originY;
      const z = progress.originZ + row;

      try {
        await bot.creative.flyTo({ x, y: y + config.build.flyHeight, z });
      } catch (e) {}

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

    progress.lastRow = row + 1;
    progress.lastCol = 0;
    saveProgress(progress);
    if ((row + 1) % 10 === 0) {
      const pct = (((row + 1) / H) * 100).toFixed(1);
      console.log(`[Bot] Row ${row + 1}/${H} (${pct}%) | ${progress.totalPlaced} blocks`);
    }
  }

  if (isBuilding) {
    isBuilding = false;
    console.log(`[Bot] 🎉 BUILD COMPLETE! ${progress.totalPlaced} blocks placed.`);
  }
}

// ── Place block with retry ────────────────────────────────────
async function placeWithRetry(x, y, z, blockName) {
  for (let attempt = 1; attempt <= config.build.retryAttempts; attempt++) {
    try {
      const existing = bot.blockAt({ x, y, z });
      if (existing && existing.name !== 'air' && existing.name !== blockName) {
        if (attempt < config.build.retryAttempts) {
          console.log(`[Bot] Obstacle at (${x},${y},${z}): ${existing.name} | Retry ${attempt}/${config.build.retryAttempts}`);
          await sleep(config.build.retryDelay);
          continue;
        } else {
          logSkipped(x, y, z, blockName, `Blocked by ${existing.name}`);
          return false;
        }
      }
      const blockId = bot.registry.blocksByName[blockName]?.id;
      if (blockId === undefined) { logSkipped(x, y, z, blockName, 'Unknown block'); return false; }
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

// ── Kicked handler ────────────────────────────────────────────
async function onKicked(reason) {
  console.log(`[Bot] Kicked: ${reason}`);
  isBuilding = false;
  isPreparing = false;
  const r = reason.toString().toLowerCase();
  if (r.includes('ban') || r.includes('permanent')) {
    console.log(`[Bot] "${currentUsername}" is BANNED. Switching...`);
    markBanned(progress, currentUsername);
  }
  scheduleReconnect();
}

// ── Reconnect ─────────────────────────────────────────────────
function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;

  if (bot) {
    try { bot.quit(); } catch (e) {}
    bot = null;
  }

  if (reconnectAttempts >= config.bot.maxReconnectAttempts) {
    console.error('[Bot] Max reconnect attempts reached.');
    isReconnecting = false;
    return;
  }

  reconnectAttempts++;
  const delay = Math.min(config.bot.reconnectDelay * reconnectAttempts, 30000);
  console.log(`[Bot] Reconnecting in ${delay / 1000}s... (attempt ${reconnectAttempts})`);

  setTimeout(() => {
    isReconnecting = false;
    createBot();
  }, delay);
}

// ── Watch for image ───────────────────────────────────────────
watchForImage(() => {
  console.log('\n[Bot] 🖼️  Image detected! Use: say pixel start');
});

// ── Start ─────────────────────────────────────────────────────
console.log('================================================');
console.log('  MINECRAFT PIXEL ART BOT');
console.log('================================================');
console.log(`  Server : ${config.server.host}:${config.server.port}`);
console.log(`  Size   : ${config.image.width}x${config.image.height} blocks`);
console.log('------------------------------------------------');
console.log('  say pixel prepare  - Prep terrain at spawn');
console.log('  say pixel start    - Start building');
console.log('  say pixel stop     - Pause');
console.log('  say pixel resume   - Resume');
console.log('  say pixel status   - Progress');
console.log('  say pixel center   - Screenshot coords');
console.log('================================================\n');

createBot();
