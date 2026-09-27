// ============================================================
//   PROGRESS MANAGER
// ============================================================

const fs = require('fs');

const PROGRESS_FILE = './progress.json';
const SKIP_LOG = './skipped.log';

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      console.log(`[Progress] Resuming from row ${data.lastRow}, col ${data.lastCol} (${data.totalPlaced} blocks placed)`);
      return data;
    } catch (e) {
      console.log('[Progress] Corrupt progress file, starting fresh');
    }
  }
  return {
    lastRow: 0,
    lastCol: 0,
    totalPlaced: 0,
    originX: null,
    originY: null,
    originZ: null,
    prepDone: false,
    bannedUsernames: [],
    currentUsernameIndex: 0,
  };
}

function saveProgress(data) {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[Progress] Save error:', e.message);
  }
}

function clearBuildProgress(data) {
  data.lastRow = 0;
  data.lastCol = 0;
  data.totalPlaced = 0;
  saveProgress(data);
}

function logSkipped(x, y, z, block, reason) {
  const line = `[${new Date().toISOString()}] SKIPPED ${block} at (${x},${y},${z}) - ${reason}\n`;
  fs.appendFileSync(SKIP_LOG, line);
}

function markBanned(data, username) {
  if (!data.bannedUsernames.includes(username)) {
    data.bannedUsernames.push(username);
    console.log(`[Progress] Marked ${username} as banned`);
    saveProgress(data);
  }
}

module.exports = { loadProgress, saveProgress, clearBuildProgress, logSkipped, markBanned };
