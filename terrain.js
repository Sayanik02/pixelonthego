// ============================================================
//   TERRAIN PREP
//   Clears and flattens 500x500 area before building
//   Uses /fill if OP, falls back to block-by-block if not
// ============================================================

const config = require('./config');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let isOP = false;

/**
 * Check if bot currently has OP by trying a harmless op-only action
 */
async function checkOP(bot) {
  return new Promise((resolve) => {
    // Try running a harmless gamerule check - only works with OP
    bot.chat('/gamerule doFireTick');
    const timer = setTimeout(() => resolve(false), 2000);

    bot.once('message', (msg) => {
      clearTimeout(timer);
      const text = msg.toString();
      if (text.includes('doFireTick') || text.includes('Game rule')) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

/**
 * Main terrain preparation function
 * Auto-detects spawn point — no coordinates needed!
 * @param {object} bot - mineflayer bot
 */
async function prepareTerrain(bot) {
  const width = config.image.width;
  const height = config.image.height;

  // ── Auto-detect spawn ──────────────────────────────────────
  // Use the bot's own spawn point which is set to world spawn
  const spawnX = Math.floor(bot.spawnPoint?.x ?? bot.entity.position.x);
  const spawnY = Math.floor(bot.spawnPoint?.y ?? bot.entity.position.y);
  const spawnZ = Math.floor(bot.spawnPoint?.z ?? bot.entity.position.z);

  console.log(`[Terrain] Detected spawn at: (${spawnX}, ${spawnY}, ${spawnZ})`);

  // Center the 500x500 area ON the spawn point
  const originX = spawnX - Math.floor(width / 2);
  const originZ = spawnZ - Math.floor(height / 2);
  const originY = spawnY;

  const x1 = originX;
  const x2 = originX + width - 1;
  const z1 = originZ;
  const z2 = originZ + height - 1;

  // Y range: clear from build level up to sky, fill from bedrock to build level
  const clearYBottom = originY;
  const clearYTop = 320;
  const fillYBottom = -64;
  const fillYTop = originY - 1;

  console.log(`[Terrain] Starting terrain prep for ${width}x${height} area`);
  console.log(`[Terrain] Area: (${x1},${originY},${z1}) to (${x2},${originY},${z2})`);
  console.log(`[Terrain] Spawn (center): (${spawnX}, ${spawnY}, ${spawnZ})`);

  // Fly to center of area at safe height
  const centerX = spawnX;
  const centerZ = spawnZ;

  console.log(`[Terrain] Flying to prep position...`);
  try {
    bot.creative.startFlying();
    await bot.creative.flyTo({ x: centerX, y: originY + 50, z: centerZ });
  } catch (e) {
    console.log(`[Terrain] Fly error (continuing anyway): ${e.message}`);
  }

  await sleep(1000);

  // Check if OP
  isOP = await checkOP(bot);
  console.log(`[Terrain] OP status: ${isOP ? 'YES - using /fill (fast)' : 'NO - using block-by-block (slower)'}`);

  if (isOP) {
    await prepareWithFill(bot, x1, x2, z1, z2, originY, clearYTop, fillYBottom, fillYTop);
  } else {
    await prepareBlockByBlock(bot, x1, x2, z1, z2, originY);
  }

  // Place gold block at center as camera marker
  await placeGoldMarker(bot, centerX, originY, centerZ);

  console.log(`[Terrain] ✅ Terrain prep complete!`);
  console.log(`[Terrain] 📍 Center marker (gold block) at: ${centerX}, ${originY}, ${centerZ}`);
  console.log(`[Terrain] 📸 For screenshot: fly to ${centerX}, ${originY + 400}, ${centerZ} and look straight down`);

  return { originX, originY, originZ, centerX, centerY: originY, centerZ };
}

/**
 * Fast prep using /fill commands (requires OP)
 */
async function prepareWithFill(bot, x1, x2, z1, z2, originY, clearYTop, fillYBottom, fillYTop) {
  console.log(`[Terrain] Step 1/3: Clearing everything above build level...`);
  bot.chat(`/fill ${x1} ${originY} ${z1} ${x2} ${clearYTop} ${z2} air`);
  await sleep(3000);

  console.log(`[Terrain] Step 2/3: Filling holes and water below build level...`);
  bot.chat(`/fill ${x1} ${fillYBottom} ${z1} ${x2} ${fillYTop} ${z2} stone`);
  await sleep(3000);

  console.log(`[Terrain] Step 3/3: Placing flat stone base at build level...`);
  bot.chat(`/fill ${x1} ${originY - 1} ${z1} ${x2} ${originY - 1} ${z2} stone`);
  await sleep(3000);

  console.log(`[Terrain] /fill complete!`);
}

/**
 * Slower block-by-block prep (no OP needed)
 * Only handles the build layer and one layer above
 */
async function prepareBlockByBlock(bot, x1, x2, z1, z2, originY) {
  const width = x2 - x1 + 1;
  const depth = z2 - z1 + 1;
  let done = 0;
  const total = width * depth;

  console.log(`[Terrain] Block-by-block prep started (${total} blocks) - this will take a while...`);

  for (let x = x1; x <= x2; x++) {
    for (let z = z1; z <= z2; z++) {
      // Check block at build level
      const buildBlock = bot.blockAt({ x, y: originY, z });
      const aboveBlock = bot.blockAt({ x, y: originY + 1, z });

      // Clear block at build level if not air (we need it clear for building)
      if (buildBlock && buildBlock.name !== 'air') {
        try {
          await bot.creative.setBlock({ x, y: originY, z }, 0); // 0 = air
        } catch (e) { /* ignore */ }
      }

      // Clear one block above build level
      if (aboveBlock && aboveBlock.name !== 'air') {
        try {
          await bot.creative.setBlock({ x, y: originY + 1, z }, 0);
        } catch (e) { /* ignore */ }
      }

      // Fill if air at build level - 1 (hole/pond)
      const belowBlock = bot.blockAt({ x, y: originY - 1, z });
      if (!belowBlock || belowBlock.name === 'air' || belowBlock.name === 'water' || belowBlock.name === 'lava') {
        try {
          await bot.creative.setBlock({ x, y: originY - 1, z }, 1); // 1 = stone
        } catch (e) { /* ignore */ }
      }

      done++;
      if (done % 5000 === 0) {
        const pct = ((done / total) * 100).toFixed(1);
        console.log(`[Terrain] Block-by-block prep: ${pct}% done`);
        await sleep(10);
      }
    }
    await sleep(5); // small breath per column
  }

  console.log(`[Terrain] Block-by-block prep complete!`);
}

/**
 * Place a gold block at center as screenshot reference
 */
async function placeGoldMarker(bot, x, y, z) {
  try {
    const goldId = bot.registry.blocksByName['gold_block']?.id;
    if (goldId) {
      await bot.creative.setBlock({ x, y, z }, goldId);
      console.log(`[Terrain] Gold block placed at center (${x}, ${y}, ${z})`);
    }
  } catch (e) {
    console.log(`[Terrain] Could not place gold marker: ${e.message}`);
  }
}

module.exports = { prepareTerrain };
