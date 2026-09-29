// ============================================================
//   MINECRAFT PIXEL ART BOT v2.1
//   - Creative mode block placement (no OP needed)
//   - Live POV viewer at /viewer on your Railway URL
//   - Status page at your Railway public URL (port 3000)
//   - Railway volume support for persistent progress + image
//   - Auto-resume on reconnect
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

const mineflayer = require('mineflayer');
const { Vec3 }   = require('vec3');
const express    = require('express');
const config     = require('./config');
const { loadProgress, saveProgress, clearBuildProgress, logSkipped, markBanned } = require('./progressManager');
const { watchForImage, processImage, isImageReady } = require('./imageProcessor');
const { prepareTerrain, creativePlace } = require('./terrain');
const { buildWithOp } = require('./opBuilder');
const { renderPreview, sendToDiscord, PREVIEW_PATH } = require('./preview');
const { scanWorld, getScanState, WORLD_PATH } = require('./scanner');

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
let buildStartTime    = null;
const rateSamples     = [];
let viewerStarted     = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Try to load prismarine-viewer (optional) ──────────────────
let prismarineViewer = null;
try {
  prismarineViewer = require('prismarine-viewer').mineflayer;
  console.log('[Viewer] prismarine-viewer loaded OK');
} catch (e) {
  console.log('[Viewer] prismarine-viewer not available: ' + e.message);
}

function startViewer(botInstance) {
  if (viewerStarted || !prismarineViewer) return;
  try {
    prismarineViewer(botInstance, { port: 3007, firstPerson: true });
    viewerStarted = true;
    console.log('[Viewer] 🎮 Bot POV live at /viewer on your Railway URL');
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      viewerStarted = true;
      console.log('[Viewer] Reusing existing viewer on port 3007');
    } else {
      console.log('[Viewer] Could not start viewer: ' + e.message);
    }
  }
}

// ── Status + POV web server ───────────────────────────────────
const app = express();

// ── Preview picture (drawn from the block grid) ──────────────
async function makePreview(notify) {
  if (!blockGrid) blockGrid = await processImage();
  const path = await renderPreview(blockGrid);
  console.log('[Preview] Saved ' + path + (process.env.DISCORD_WEBHOOK_URL ? '' : ' (set DISCORD_WEBHOOK_URL to also get it on Discord)'));
  if (notify) {
    const ok = await sendToDiscord(path, 'Build ' + Math.floor((progress.totalPlaced / (config.image.width * config.image.height)) * 100) + '% - preview');
    if (ok) console.log('[Preview] Sent to Discord');
  }
  return path;
}

app.get('/preview.png', async (req, res) => {
  try {
    const fs = require('fs');
    if (!fs.existsSync(PREVIEW_PATH) || req.query.refresh) await makePreview(false);
    res.set('Cache-Control', 'no-store');
    res.sendFile(require('path').resolve(PREVIEW_PATH));
  } catch (e) {
    res.status(500).send('Preview not available yet: ' + e.message);
  }
});

// ── World scan (real blocks + obstacles) ─────────────────────
async function startScan() {
  const st = getScanState();
  if (st.status === 'running') return 'Scan already running';
  if (!bot) return 'Bot is offline';
  if (isBuilding || isPreparing) return 'Bot is busy building - scan after it finishes (or say pixel stop)';
  if (progress.originX === null) return 'No build origin yet';
  try {
    if (!blockGrid) blockGrid = await processImage();
  } catch (e) { return 'Image error: ' + e.message; }
  scanWorld(bot, blockGrid, progress).catch(e => console.log('[Scan] ' + e.message));
  return 'Scan started';
}

app.get('/scan', async (req, res) => {
  const msg = await startScan();
  console.log('[Scan] ' + msg);
  res.redirect('/');
});

app.get('/world.png', (req, res) => {
  const fs = require('fs');
  if (!fs.existsSync(WORLD_PATH)) return res.status(404).send('No scan yet - open /scan first');
  res.set('Cache-Control', 'no-store');
  res.sendFile(require('path').resolve(WORLD_PATH));
});

// ── Repair: scan, re-fill only the wrong/missing blocks, scan again ──
let repairStatus = '';
async function startRepair() {
  if (repairStatus && !/^(Done|Failed|Nothing)/.test(repairStatus)) return 'Repair already running';
  if (getScanState().status === 'running') return 'Scan running - try again in a minute';
  if (!bot) return 'Bot is offline';
  if (isBuilding || isPreparing) return 'Bot is busy building';
  if (progress.originX === null) return 'No build origin yet';
  (async () => {
    try {
      if (!blockGrid) blockGrid = await processImage();
      const W = config.image.width, H = config.image.height;
      repairStatus = 'Scanning to find missing blocks...';
      await scanWorld(bot, blockGrid, progress);
      let st = getScanState();
      if (st.status !== 'done') { repairStatus = 'Failed: ' + st.message; return; }

      const mask = st.mismatch;
      const k = st.counts;
      const obstacles = k.tree + k.water + k.lava + k.other + k.plant;
      let need = 0;
      const masked = blockGrid.map((row, r) => row.map((n, c) => (mask[r * W + c] ? (need++, n) : null)));
      // Always runs, even if the scan looks clean: it also lays the stone layer under the art and clears the sky.
      repairStatus = 'Clearing sky (' + obstacles + ' blocked columns), stone layer below, fixing ' + need + ' blocks...';
      console.log('[Repair] ' + repairStatus);
      let repairing = true;
      const tmp = { lastRow: 0, lastCol: 0, totalPlaced: 0, originX: progress.originX, originY: progress.originY, originZ: progress.originZ, centerX: progress.centerX, centerZ: progress.centerZ };
      // prep=true: wipes everything above the art + lays the stone layer under it (so sand stays)
      const res = await buildWithOp(bot, masked, tmp, { isBuilding: () => repairing, save: () => {} }, { prep: true });
      if (res === 'fallback') { repairStatus = 'Failed: bot is not OP'; return; }

      repairStatus = 'Re-scanning to verify...';
      await scanWorld(bot, blockGrid, progress);
      st = getScanState();
      if (st.status === 'done') {
        const k2 = st.counts;
        const left = k2.tree + k2.water + k2.lava + k2.other;
        if (k2.wrong === 0 && left === 0) {
          progress.totalPlaced = W * H;
          saveProgress(progress);
          repairStatus = 'Done - build verified, 0 wrong blocks, nothing covering the art';
        } else {
          repairStatus = 'Done - ' + k2.wrong + ' blocks still wrong, ' + left + ' columns still blocked';
        }
      } else {
        repairStatus = 'Failed: ' + st.message;
      }
      console.log('[Repair] ' + repairStatus);
    } catch (e) {
      repairStatus = 'Failed: ' + e.message;
      console.log('[Repair] ' + e.message);
    }
  })();
  return 'Repair started';
}

app.get('/repair', async (req, res) => {
  console.log('[Repair] ' + await startRepair());
  res.redirect('/');
});

app.get('/', (req, res) => {
  const total     = config.image.width * config.image.height;
  const pct       = progress.totalPlaced ? ((progress.totalPlaced / total) * 100).toFixed(1) : '0.0';
  const botOnline = bot ? 'Online' : 'Offline';
  const botClass  = bot ? 'online' : 'offline';
  const username  = currentUsername || 'none';
  const placed    = progress.totalPlaced.toLocaleString();
  const totalStr  = total.toLocaleString();

  let posX = '?', posY = '?', posZ = '?';
  if (bot && bot.entity) {
    posX = Math.floor(bot.entity.position.x);
    posY = Math.floor(bot.entity.position.y);
    posZ = Math.floor(bot.entity.position.z);
  }

  let distInfo = '';
  if (bot && bot.entity && progress.originX !== null) {
    const dx = Math.floor(bot.entity.position.x) - progress.originX;
    const dz = Math.floor(bot.entity.position.z) - progress.originZ;
    const dist = Math.floor(Math.sqrt(dx*dx + dz*dz));
    distInfo = dist < 5 ? 'AT BUILD AREA' : dist + ' blocks away from origin';
  }

  let activity = 'Idle';
  if (!bot) activity = 'DISCONNECTED - reconnecting...';
  else if (isPreparing) activity = 'Flattening terrain...';
  else if (isBuilding && progress.totalPlaced === 0) activity = 'Flying to build area...';
  else if (isBuilding) activity = 'Placing blocks - Row ' + progress.lastRow + ', Col ' + progress.lastCol;
  else if (progress.totalPlaced === total) activity = 'BUILD COMPLETE!';
  else if (progress.lastRow >= config.image.height) activity = 'Build finished - ' + (total - progress.totalPlaced) + ' blocks unconfirmed (use Scan + repair)';
  else if (progress.totalPlaced > 0) activity = 'Paused at row ' + progress.lastRow;

  let targetInfo = '';
  if (isBuilding && progress.originX !== null) {
    const tx = progress.originX + progress.lastCol;
    const ty = progress.originY;
    const tz = progress.originZ + progress.lastRow;
    targetInfo = '(' + tx + ', ' + ty + ', ' + tz + ')';
  }

  // Rolling rate over the last 60s (avoids lifetime-average blowups & resume skew)
  const nowMs = Date.now();
  if (isBuilding) {
    rateSamples.push({ t: nowMs, n: progress.totalPlaced });
    while (rateSamples.length && nowMs - rateSamples[0].t > 60000) rateSamples.shift();
  } else {
    rateSamples.length = 0;
  }

  let eta = '';
  let bps = '';
  if (isBuilding && rateSamples.length >= 2) {
    const first = rateSamples[0];
    const last  = rateSamples[rateSamples.length - 1];
    const dt    = (last.t - first.t) / 1000;
    const dn    = last.n - first.n;
    if (dt >= 10 && dn >= 5) {
      const rate = dn / dt;
      bps = rate.toFixed(1) + ' blocks/s';
      const remaining = (total - progress.totalPlaced) / rate;
      const days = Math.floor(remaining / 86400);
      const hrs  = Math.floor((remaining % 86400) / 3600);
      const mins = Math.floor((remaining % 3600) / 60);
      eta = (days > 0 ? days + 'd ' : '') + hrs + 'h ' + mins + 'm remaining';
    } else {
      eta = 'calculating...';
    }
  }

  const originX  = progress.originX !== null ? progress.originX : '?';
  const originY  = progress.originY !== null ? progress.originY : '?';
  const originZ  = progress.originZ !== null ? progress.originZ : '?';
  const imgStatus  = isImageReady() ? 'YES' : 'NO';
  const prepDone   = progress.prepDone ? 'YES' : 'NO';
  const sc = getScanState();
  const repairLine = repairStatus ? 'Repair: ' + repairStatus + '<br>' : '';
  let scanCard = repairLine + '<a href="/scan">Scan world for obstacles</a> &nbsp;|&nbsp; <a href="/repair">Scan + repair</a>';
  if (sc.status === 'running') {
    scanCard = repairLine + 'World scan: ' + sc.message + ' (' + sc.tilesDone + '/' + sc.tilesTotal + ')';
  } else if (sc.status === 'error') {
    scanCard = 'World scan failed: ' + sc.message + ' &nbsp;<a href="/scan">retry</a>';
  } else if (sc.status === 'done' && sc.counts) {
    const k = sc.counts;
    const bad = k.tree + k.water + k.lava + k.other;
    scanCard = '<b>World scan</b> (' + sc.finishedAt.toLocaleTimeString() + ')<br>'
      + repairLine
      + (bad === 0 ? 'No obstacles found. ' : 'Obstacles: ' + k.tree + ' tree, ' + k.water + ' water, ' + k.lava + ' lava, ' + k.other + ' other columns. ')
      + 'Wrong blocks: ' + k.wrong + '. Not loaded: ' + k.unknown + '.<br>'
      + (sc.wrongPairs && sc.wrongPairs.length ? 'Wrong (expected -> found): ' + sc.wrongPairs.slice(0, 4).map(p => p[0] + ' x' + p[1]).join('; ') + '<br>' : '')
      + (sc.samples.length ? 'e.g. ' + sc.samples.slice(0, 4).join('; ') + '<br>' : '')
      + '<a href="/world.png" target="_blank">Open world map</a> &nbsp;|&nbsp; <a href="/scan">scan again</a>' + (k.wrong > 0 ? ' &nbsp;|&nbsp; <a href="/repair">repair ' + k.wrong + ' wrong blocks</a>' : '');
  }

  const viewerLink = viewerStarted
    ? '<a href="/viewer" target="_blank">Open Live POV Viewer</a>'
    : '<span style="color:#888">POV viewer not available</span>';

  res.send(`<!DOCTYPE html><html><head><title>PixelBot Status</title>
    <meta http-equiv="refresh" content="5">
    <style>
      body{font-family:monospace;background:#1a1a2e;color:#e0e0e0;padding:24px;max-width:750px;margin:auto}
      h1{color:#00d4ff;margin-bottom:2px}
      .ts{color:#888;font-size:12px;margin-bottom:14px}
      .card{background:#16213e;padding:14px 18px;border-radius:8px;margin:10px 0;line-height:1.9}
      .activity{background:#0d2137;border-left:4px solid #00d4ff;padding:12px 16px;border-radius:0 8px 8px 0;margin:10px 0;font-size:15px;color:#00d4ff;font-weight:bold}
      .bar-wrap{background:#0f3460;border-radius:4px;height:20px;margin:8px 0 4px;position:relative;overflow:hidden}
      .bar-fill{background:#00d4ff;border-radius:4px;height:20px;width:${pct}%}
      .bar-pct{position:absolute;right:8px;top:2px;font-size:12px;color:#fff}
      .online{color:#00ff88}.offline{color:#ff4444}
      .coord{color:#ffd700}
      .good{color:#00ff88}.warn{color:#ff9900}
      table{width:100%;border-collapse:collapse}
      td{padding:2px 8px;vertical-align:top}
      td:first-child{color:#888;width:150px;white-space:nowrap}
      a{color:#00d4ff}
    </style></head><body>
    <h1>Minecraft Pixel Art Bot</h1>
    <div class="ts">Last updated: ${new Date().toLocaleTimeString()}</div>

    <div class="activity">${activity}</div>

    <div class="card"><table>
      <tr><td>Bot status</td><td><span class="${botClass}">${botOnline}</span> &mdash; ${username}</td></tr>
      <tr><td>Bot position</td><td class="coord">(${posX}, ${posY}, ${posZ})</td></tr>
      <tr><td>Build origin</td><td class="coord">(${originX}, ${originY}, ${originZ})</td></tr>
      ${distInfo ? '<tr><td>Distance</td><td class="' + (distInfo.startsWith('AT') ? 'good' : 'warn') + '">' + distInfo + '</td></tr>' : ''}
      ${targetInfo ? '<tr><td>Target block</td><td class="coord">' + targetInfo + '</td></tr>' : ''}
    </table></div>

    <div class="card">
      <b>Progress:</b> ${placed} / ${totalStr} blocks
      ${bps ? '&nbsp;&mdash;&nbsp;' + bps : ''}
      ${eta ? '&nbsp;&mdash;&nbsp;' + eta : ''}
      <div class="bar-wrap"><div class="bar-fill"></div><span class="bar-pct">${pct}%</span></div>
      Row ${progress.lastRow} / ${config.image.height} &nbsp;|&nbsp; Col ${progress.lastCol} / ${config.image.width}
    </div>

    <div class="card"><table>
      <tr><td>Prep done</td><td>${prepDone}</td></tr>
      <tr><td>Image ready</td><td>${imgStatus}</td></tr>
      <tr><td>Reconnects</td><td>${reconnectAttempts}</td></tr>
    </table></div>

    <div class="card">${viewerLink}</div>
    <div class="card"><a href="/preview.png?refresh=1" target="_blank">Open build preview (PNG)</a></div>
    <div class="card">${scanCard}</div>
    </body></html>`);
});

// Proxy POV viewer (prismarine-viewer runs on 3007)
// We proxy server-side so the browser never tries to reach localhost directly
let httpProxyMiddleware = null;
try {
  httpProxyMiddleware = require('http-proxy-middleware').createProxyMiddleware;
} catch (e) {
  console.log('[Viewer] http-proxy-middleware not available: ' + e.message);
}

app.get('/viewer', (req, res, next) => {
  if (!viewerStarted) {
    res.send('<html><body style="background:#000;color:#fff;font-family:monospace;padding:30px">' +
      '<h2>POV Viewer not available</h2>' +
      '<p>prismarine-viewer failed to load. Check Railway build logs.</p>' +
      '<a href="/" style="color:#00d4ff">← Back to status</a></body></html>');
    return;
  }
  if (!httpProxyMiddleware) {
    res.send('<html><body style="background:#000;color:#fff;font-family:monospace;padding:30px">' +
      '<h2>Proxy not available</h2>' +
      '<p>Run: <code>npm install http-proxy-middleware</code> then redeploy.</p>' +
      '<a href="/" style="color:#00d4ff">← Back to status</a></body></html>');
    return;
  }
  next();
});

// Mount the actual proxy for /viewer and its sub-paths (WebSocket + HTTP)
if (true) { // always register; middleware guards when viewer isn't ready
  const lazyProxy = (req, res, next) => {
    if (!viewerStarted || !httpProxyMiddleware) { next(); return; }
    httpProxyMiddleware({
      target: 'http://127.0.0.1:3007',
      changeOrigin: true,
      ws: true,
      pathRewrite: { '^/viewer': '' },
      logLevel: 'silent',
    })(req, res, next);
  };
  app.use('/viewer', lazyProxy);
}

app.listen(3000, () => console.log('[Web] Status page running on port 3000'));

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
  isReconnecting  = false;
  currentUsername = getNextUsername();
  console.log('\n[Bot] Connecting as "' + currentUsername + '" to ' + config.server.host + ':' + config.server.port);

  bot = mineflayer.createBot({
    host:     config.server.host,
    port:     config.server.port,
    username: currentUsername,
    version:  config.server.version,
    auth:     'offline',
    checkTimeoutInterval: 60000,
  });

  bot.once('spawn', onSpawn);
  bot.on('chat',    onChat);
  bot.on('kicked',  onKicked);
  bot.on('error',   function(e) {
    console.error('[Bot] Error:', e.message);
    isBuilding  = false;
    isPreparing = false;
    scheduleReconnect();
  });
  bot.on('end', function(r) {
    console.log('[Bot] Disconnected:', r);
    isBuilding  = false;
    isPreparing = false;
    scheduleReconnect();
  });
}

// ── On spawn ──────────────────────────────────────────────────
async function onSpawn() {
  console.log('[Bot] ✅ Spawned as "' + currentUsername + '"!');
  reconnectAttempts = 0;
  await sleep(3000);

  // Start POV viewer
  startViewer(bot);

  try { bot.creative.startFlying(); } catch (e) {}

  if (progress.prepDone && isImageReady() && !isBuilding) {
    if (progress.totalPlaced > 0) {
      console.log('[Bot] Auto-resuming from row ' + progress.lastRow + ' (' + progress.totalPlaced + ' blocks already placed)');
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
    console.log('[Console] pixel ' + command);

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
      console.log('[Status] ' + progress.totalPlaced + '/' + total + ' (' + pct + '%) | Row ' + progress.lastRow + '/' + config.image.height + ' | Building: ' + isBuilding);
      return;
    }

    if (command === 'repair') {
      startRepair().then(m => console.log('[Repair] ' + m));
      return;
    }

    if (command === 'scan') {
      startScan().then(m => console.log('[Scan] ' + m));
      return;
    }

    if (command === 'preview') {
      makePreview(true).catch(e => console.log('[Preview] ' + e.message));
      setTimeout(() => startScan().then(m => console.log('[Scan] ' + m)), 3000);
      return;
    }

    if (command === 'center') {
      if (progress.originX === null) { console.log('[Console] No origin yet.'); return; }
      const cx = progress.centerX || Math.floor(progress.originX + config.image.width / 2);
      const cz = progress.centerZ || Math.floor(progress.originZ + config.image.height / 2);
      console.log('[Bot] 📍 Center: ' + cx + ', ' + progress.originY + ', ' + cz);
      console.log('[Bot] 📸 /tp @s ' + cx + ' ' + (progress.originY + 400) + ' ' + cz + ' — look straight down');
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

    console.log('[Console] Unknown: pixel ' + command);
  } catch (e) {}
}

// ── Main build loop ───────────────────────────────────────────
async function startBuilding() {
  if (isBuilding) return;
  isBuilding     = true;
  buildStartTime = Date.now();

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

  // ── Fast path: OP + /fill ──
  if (config.build.useOp) {
    const result = await buildWithOp(bot, blockGrid, progress, {
      isBuilding: () => isBuilding,
      save: () => saveProgress(progress),
    });
    if (result === 'done') {
      isBuilding = false;
      console.log('[Bot] 🎉 BUILD COMPLETE! ' + progress.totalPlaced + ' blocks placed.');
      console.log('[Bot] Use: say pixel center — then /tp to screenshot');
      makePreview(true).catch(e => console.log('[Preview] ' + e.message));
      return;
    }
    if (result === 'paused') return;
    // 'fallback' → continue with the slow legacy loop below
  }

  try { bot.creative.startFlying(); } catch (e) {}

  outer:
  for (let row = progress.lastRow; row < H; row++) {
    for (let col = (row === progress.lastRow ? progress.lastCol : 0); col < W; col++) {
      if (!isBuilding) { console.log('[Bot] Paused.'); break outer; }

      const blockName = blockGrid[row][col];
      if (!blockName) continue;
      progress.lastRow = row;
      progress.lastCol = col;

      const x = originX + col;
      const y = originY;
      const z = originZ + row;

      try {
        // only fly when out of reach (placing reach is ~5 blocks)
        const p = bot.entity.position;
        const far = Math.abs(p.x - x) > 4 || Math.abs(p.z - z) > 4 || Math.abs(p.y - (y + config.build.flyHeight)) > 4;
        if (far) {
          // fly a few blocks ahead along the row so the next ~6 blocks need no flying
          await Promise.race([
            bot.creative.flyTo(new Vec3(x + 3, y + config.build.flyHeight, z)),
            sleep(3000),
          ]);
        }
      } catch (e) {}

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
      console.log('[Bot] Row ' + (row + 1) + '/' + H + ' (' + pct + '%) | ' + progress.totalPlaced + ' blocks');
    }
  }

  if (isBuilding) {
    isBuilding = false;
    console.log('[Bot] 🎉 BUILD COMPLETE! ' + progress.totalPlaced + ' blocks placed.');
    console.log('[Bot] Use: say pixel center — then /tp to screenshot');
    makePreview(true).catch(e => console.log('[Preview] ' + e.message));
  }
}

// ── Disconnect handlers ───────────────────────────────────────
async function onKicked(reason) {
  const r = reason ? reason.toString() : '';
  console.log('[Bot] Kicked: ' + r);
  isBuilding = isPreparing = false;
  if (r.toLowerCase().includes('ban')) {
    console.log('[Bot] "' + currentUsername + '" banned. Switching username...');
    markBanned(progress, currentUsername);
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  // Do NOT reset viewerStarted — port 3007 stays bound between reconnects

  try { if (bot) bot.quit(); } catch (e) {}
  bot = null;

  reconnectAttempts++;
  const delay = Math.min(config.bot.reconnectDelay * reconnectAttempts, 30000);
  console.log('[Bot] Reconnecting in ' + (delay / 1000) + 's... (attempt ' + reconnectAttempts + ')');
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
console.log('  Server  : ' + config.server.host + ':' + config.server.port);
console.log('  Size    : ' + config.image.width + 'x' + config.image.height);
console.log('  Status  : your Railway public URL');
console.log('  POV     : your Railway public URL + /viewer');
console.log('================================================\n');

createBot();
