// ============================================================
//   MINECRAFT PIXEL ART BOT v2.1
//   - Creative mode block placement (no OP needed)
//   - Live POV viewer at http://localhost:3000
//   - Railway volume support for persistent progress + image
//   - Auto-resume on reconnect
//   - Single reconnect guard
//
//   Aternos console commands (prefix with "say "):
//   say pixel prepare   - Flatten terrain
//   say pixel start     - Start building
//   say pixel stop      - Pause
//   say pixel resume    - Resume
//   say pixel status    - Progress
//   say pixel center    - Screenshot coords
//   say pixel reset     - Wipe progress
// ============================================================

process.on('uncaughtException',  (err) => console.error('[UNCAUGHT]', err.message, err.stack));
process.on('unhandledRejection', (err) => console.error('[REJECTION]', err?.message ?? err));

const mineflayer      = require('mineflayer');
const { Vec3 }        = require('vec3');
const express         = require('express');
const { mineflayer: viewer } = require('prismarine-viewer');
const config          = require('./config');
const { loadProgress, saveProgress, clearBuildProgress, logSkipped, markBanned } = require('./progressManager');
const { watchForImage, processImage, isImageReady } = require('./imageProcessor');
const { prepareTerrain, creativePlace } = require('./terrain');

// ── State ─────────────────────────────────────────────────────
let bot               = null;
let progress          = loadProgress();
let blockGrid         = null;
let isBuilding        = false;
let isPreparing       = false;
let isReconnecting    = false;
let reconnectAttempts = 0;
let currentUsername   = null;
let currentUsernameIndex = progress.currentUsernameIndex || 0;
let viewerStarted     = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── POV Status web server ─────────────────────────────────────
// Shows live status page + links to prismarine-viewer
const app = express();
app.get('/', (req, res) => {
  const total = config.image.width * config.image.height;
  const pct   = progress.totalPlaced ? ((progress.totalPlaced / total) * 100).toFixed(1) : '0.0';
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>PixelBot Status</title>
  <meta http-equiv="refresh" content="10">
  <style>
    body { font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 30px; }
    h1   { color: #00d4ff; }
    .stat { background: #16213e; padding: 15px; border-radius: 8px; margin: 10px 0; }
    .bar  { background: #0f3460; border-radius: 4px; height: 20px; }
    .fill { background: #00d4ff; border-radius: 4px; height: 20px; width: ${pct}%; transition: width 1s; }
    a    { color: #00d4ff; }
    .online { color: #00ff88; } .offline { color: #ff4444; }
  </style>
</head>
<body>
  <h1>🎨 Minecraft Pixel Art Bot</h1>
  <div class="stat">
    <b>Bot:</b> <span class="${bot ? 'online'>🟢 Online' : 'offline">🔴 Offline'} — ${currentUsername ?? 'none'}</span><br>
    <b>Building:</b> ${isBuilding ? '✅ Yes' : '❌ No'} &nbsp;|&nbsp;
    <b>Preparing:</b> ${isPreparing ? '✅ Yes' : '❌ No'}
  </div>
  <div class="stat">
    <b>Progress:</b> ${progress.totalPlaced.toLocaleString()} / ${total.toLocaleString()} blocks (${pct}%)<br>
    <div class="bar"><div class="fill"></div></div><br>
    <b>Row:</b> ${progress.lastRow} / ${config.image.height} &nbsp;|&nbsp;
    <b>Col:</b> ${progress.lastCol} / ${config.image.width}
  </div>
  <div class="stat">
    <b>Origin:</b> (${progress.originX ?? '?'}, ${progress.originY ?? '?'}, ${progress.originZ ?? '?'})<br>
    <b>Prep done:</b> ${progress.prepDone ? '✅' : '❌'} &nbsp;|&nbsp;
    <b>Image ready:</b> ${isImageReady() ? '✅' : '❌'}
  </div>
  <div class="stat">
    <b>🎮 Live POV Viewer:</b><br>
    <a href="/viewer" target="_blank">Open Bot POV (3D view) →</a><br>
    <small>Auto-refreshes every 10s</small>
  </div>
</body>
</html>`);
});

// Proxy the prismarine viewer (it runs on port 3007 internally)
app.get('/viewer', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>Bot POV</title></head>
<body style="margin:0;background:#000">
  <iframe src="http://localhost:3007" width="100%" height="100%" style="border:none;position:fixed;top:0;left:0"></iframe>
</body>
</html>`);
});

app.listen(3000, () => console.log('[Web] Status page: http://localhost:3000'));

// ── Start prismarine viewer for bot POV ───────────────────────
function startViewer(bot) {
  if (viewerStarted) return;
  try {
    viewer(bot, { port: 3007, firstPerson: true });
    viewerStarted = true;
    console.log('[Viewer] 🎮 Bot POV live at http://localhost:3007 (or /viewer on status page)');
  } catch (e) {
    console.log('[Viewer] Could not start viewer:', e.message);
  }
}

// ── Username rotation ─────────────────────────────────────────
function getNextUsername() {
  const usernames = config.bot.usernames;
  const banned    = new Set(progress.bannedUsernames || []);
  for (let i = 0; i < usernames.length; i++) {
    const idx = (currentUsernameIndex + i) % usernames.length;
    if (!banned.has(usernames[idx])) {
      currentUsernameIndex = (idx + 1) % usernames.length;
      progress.currentUsernameIndex = currentUsernameIndex;
      return usernames[idx];
    }
  }
  console.log('[Bot] All usernames banned — resetting ban list...');
  progress.bannedUsernames = [];
  currentUsernameIndex = 0;
  progress.currentUsernameIndex = 0;
  return usernames[0];
}

// ── Create bot ────────────────────────────────────────────────
function createBot() {
  isReconnecting   = false;
  currentUsername  = getNextUsername();
  console.log(`\n[Bot] Connecting as "${currentUsername}" to ${config.server.host}:${config.server.port}`);

  bot = mineflayer.createBot({
    host:    config.server.host,
    port:    config.server.port,
    username: currentUsername,
    version: config.server.version,
    auth:    'offline',
    checkTimeoutInterval: 60000,
  });

  bot.once('spawn',   onSpawn);
  bot.on('chat',      onChat);
  bot.on('kicked',    onKicked);
  bot.on('error',     (e) => { console.error('[Bot] Error:', e.message); isBuilding = false; isPreparing = false; scheduleReconnect(); });
  bot.on('end',       (r) => { console.log('[Bot] Disconnected:', r);    isBuilding = false; isPreparing = false; scheduleReconnect(); });
}

// ── On spawn ──────────────────────────────────────────────────
async function onSpawn() {
  console.log(`[Bot] ✅ Spawned as "${currentUsername}"!`);
  reconnectAttempts = 0;
  await sleep(3000);

  // Start POV viewer
  startViewer(bot);

  // Enable creative fly
  try { bot.creative.startFlying(); } catch (e) {}

  // Auto-resume: if prep is done and image exists, start building automatically
  if (progress.prepDone && isImageReady() && !isBuilding) {
    if (progress.totalPlaced > 0) {
      console.log(`[Bot] Auto-resuming from row ${progress.lastRow} (${progress.totalPlaced} blocks already placed)`);
    } else {
      console.log('[Bot] Auto-starting build (prep done + image ready)');
    }
    await startBuilding();
  } else {
    console.log('[Bot] Ready! In Aternos console: say pixel prepare');
    if (!isImageReady()) console.log('[Bot] ⚠️  Drop input.png in Railway volume first!');
  }
}

// ── Chat command handler ──────────────────────────────────────
async function onChat(username, message) {
  try {
    const full = (username + ' ' + message).toLowerCase();
    if (!full.includes('pixel ')) return;

    const match = full.match(/pixel\s+(\w+)/);
    if (!match) return;
    const command = match[1];
    console.log(`[Console] pixel ${command}`);

    if (command === 'prepare') {
      if (isPreparing || isBuilding) { console.log('[Console] Busy. Use: say pixel stop'); return; }
      isPreparing = true;
      progress.prepDone = false;
      saveProgress(progress);
      console.log('[Bot] Starting terrain prep...');
      try {
        const r = await prepareTerrain(bot);
        progress.originX  = r.originX;
        progress.originY  = r.originY;
        progress.originZ  = r.originZ;
        progress.centerX  = r.centerX;
        progress.centerZ  = r.centerZ;
        progress.prepDone = true;
        saveProgress(progress);
        console.log('[Bot] ✅ Prep done! Now: say pixel start');
      } catch (e) { console.error('[Bot] Prep error:', e.message); }
      isPreparing = false;
      return;
    }

    if (command === 'start') {
      if (isBuilding) { console.log('[Console] Already building!'); return; }
      if (!progress.prepDone && progress.originX === null) { console.log('[Console] Run: say pixel prepare first!'); return; }
      if (!isImageReady()) { console.log('[Console] Drop input.png in Railway volume first!'); return; }
      clearBuildProgress(progress);
      blockGrid = null;
      console.log('[Bot] Starting build!');
      await startBuilding();
      return;
    }

    if (command === 'resume') {
      if (isBuilding) { console.log('[Console] Already building!'); return; }
      if (!isImageReady()) { console.log('[Console] No image found!'); return; }
      await startBuilding();
      return;
    }

    if (command === 'stop') {
      isBuilding = isPreparing = false;
      console.log('[Bot] Stopped. Use: say pixel resume');
      return;
    }

    if (command === 'status') {
      const total = config.image.width * config.image.height;
      const pct   = ((progress.totalPlaced / total) * 100).toFixed(1);
      console.log(`[Status] ${progress.totalPlaced}/${total} (${pct}%) | Row ${progress.lastRow}/${config.image.height} | Building: ${isBuilding}`);
      return;
    }

    if (command === 'center') {
      if (progress.originX === null) { console.log('[Console] No origin yet.'); return; }
      const cx = progress.centerX ?? Math.floor(progress.originX + config.image.width / 2);
      const cz = progress.centerZ ?? Math.floor(progress.originZ + config.image.height / 2);
      console.log(`[Bot] 📍 Center: ${cx}, ${progress.originY}, ${cz}`);
      console.log(`[Bot] 📸 /tp @s ${cx} ${progress.originY + 400} ${cz} — look straight down`);
      return;
    }

    if (command === 'reset') {
      isBuilding = isPreparing = false;
      blockGrid  = null;
      progress   = { lastRow: 0, lastCol: 0, totalPlaced: 0, originX: null, originY: null, originZ: null, prepDone: false, bannedUsernames: [], currentUsernameIndex: 0 };
      saveProgress(progress);
      console.log('[Bot] Reset. Run: say pixel prepare');
      return;
    }

    console.log(`[Console] Unknown: pixel ${command}`);
  } catch (e) {
    // silently ignore any chat parse errors
  }
}

// ── Main build loop ───────────────────────────────────────────
async function startBuilding() {
  if (isBuilding) return;
  isBuilding = true;

  if (!blockGrid) {
    console.log('[Bot] Processing image...');
    try {
      blockGrid = await processImage();
    } catch (e) {
      console.error('[Bot] Image error:', e.message);
      isBuilding = false;
      return;
    }
  }

  const W       = config.image.width;
  const H       = config.image.height;
  const originX = progress.originX;
  const originY = progress.originY;
  const originZ = progress.originZ;
  let blocksSinceSave = 0;

  try { bot.creative.startFlying(); } catch (e) {}

  outer:
  for (let row = progress.lastRow; row < H; row++) {
    for (let col = (row === progress.lastRow ? progress.lastCol : 0); col < W; col++) {
      if (!isBuilding) { console.log('[Bot] Paused.'); break outer; }

      const blockName = blockGrid[row][col];
      if (!blockName) continue;

      const x = originX + col;
      const y = originY;
      const z = originZ + row;

      // Fly above block
      try {
        await bot.creative.flyTo(new Vec3(x, y + config.build.flyHeight, z));
      } catch (e) {}

      // Place block using creative packet
      const placed = await creativePlace(bot, x, y, z, blockName);

      if (placed) {
        progress.totalPlaced++;
        blocksSinceSave++;
        if (blocksSinceSave >= config.build.saveEvery) {
          progress.lastRow = row;
          progress.lastCol = col;
          saveProgress(progress);
          blocksSinceSave = 0;
        }
      } else {
        logSkipped(x, y, z, blockName, 'placement failed');
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
    console.log(`[Bot] Use: say pixel center — then /tp to screenshot`);
  }
}

// ── Disconnect handlers ───────────────────────────────────────
async function onKicked(reason) {
  const r = reason?.toString() ?? '';
  console.log(`[Bot] Kicked: ${r}`);
  isBuilding = isPreparing = false;
  if (r.toLowerCase().includes('ban')) {
    console.log(`[Bot] "${currentUsername}" banned. Switching username...`);
    markBanned(progress, currentUsername);
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  viewerStarted  = false;

  try { bot?.quit(); } catch (e) {}
  bot = null;

  reconnectAttempts++;
  const delay = Math.min(config.bot.reconnectDelay * reconnectAttempts, 30000);
  console.log(`[Bot] Reconnecting in ${delay / 1000}s... (attempt ${reconnectAttempts})`);
  setTimeout(createBot, delay);
}

// ── Image watcher ─────────────────────────────────────────────
watchForImage(() => {
  console.log('\n[Bot] 🖼️  Image ready! Use: say pixel start');
});

// ── Boot ──────────────────────────────────────────────────────
console.log('================================================');
console.log('  MINECRAFT PIXEL ART BOT v2.1');
console.log('================================================');
console.log(`  Server  : ${config.server.host}:${config.server.port}`);
console.log(`  Size    : ${config.image.width}x${config.image.height}`);
console.log(`  POV     : http://localhost:3000`);
console.log('================================================\n');

createBot();
