// ============================================================
//   PREVIEW RENDERER — draws the block grid as a PNG
//   (a faithful picture of what the bot builds, no game client needed)
// ============================================================

const Jimp = require('jimp');
const fs = require('fs');
const { BLOCK_PALETTE } = require('./blockPalette');

const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const PREVIEW_PATH = `${VOLUME}/preview.png`;

async function renderPreview(grid, scale = 2) {
  const colors = new Map(BLOCK_PALETTE.map(p => [p.block, [p.r, p.g, p.b]]));
  const H = grid.length, W = grid[0].length;
  const img = new Jimp(W * scale, H * scale, 0x1a1a2eff);

  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const c = colors.get(grid[row][col]);
      if (!c) continue;
      const rgba = Jimp.rgbaToInt(c[0], c[1], c[2], 255);
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++)
          img.setPixelColor(rgba, col * scale + dx, row * scale + dy);
    }
  }
  await img.writeAsync(PREVIEW_PATH);
  return PREVIEW_PATH;
}

// Optional: post the picture to Discord (set DISCORD_WEBHOOK_URL in Railway variables)
async function sendToDiscord(path, message) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return false;
  try {
    const form = new FormData();
    form.append('content', message || 'Pixel art build preview');
    form.append('file', new Blob([fs.readFileSync(path)], { type: 'image/png' }), 'preview.png');
    const res = await fetch(url, { method: 'POST', body: form });
    return res.ok;
  } catch (e) {
    console.log('[Preview] Discord send failed: ' + e.message);
    return false;
  }
}

module.exports = { renderPreview, sendToDiscord, PREVIEW_PATH };
