// ============================================================
//   TERRAIN PREP
//   Clears and flattens 500x500 area before building
// ============================================================

const config = require('./config');
const { Vec3 } = require('vec3');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function checkOP(bot) {
  return new Promise((resolve) => {
    bot.chat('/gamerule doFireTick');
    const timer = setTimeout(() => resolve(false), 3000);
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

async function prepareTerrain(bot) {
  const width = config.image.width;
  const height = config.image.height;

  // Auto-detect spawn
  const spawnX = Math.floor(bot.spawnPoint ? bot.spawnPoint.x : bot.entity.position.x);
  const spawnY = Math.floor(bot.spawnPoint ? bot.spawnPoint.y : bot.entity.position.y);
  const spawnZ = Math.floor(bot.spawnPoint ? bot.spawnPoint.z : bot.entity.position.z);

  console.log(`[Terrain] Detected spawn at: (${spawnX}, ${spawnY}, ${spawnZ})`);

  const originX = spawnX - Math.floor(width / 2);
  const originZ = spawnZ - Math.floor(height / 2);
  const originY = spawnY;

  const x1 = originX;
  const x2 = originX + width - 1;
  const z1 = originZ;
  const z2 = originZ + height - 1;

  console.log(`[Terrain] Starting terrain prep for ${width}x${height} area`);
  console.log(`[Terrain] Area: (${x1},${originY},${z1}) to (${x2},${originY},${z2})`);
  console.log(`[Terrain] Spawn (center): (${spawnX}, ${spawnY}, ${spawnZ})`);

  const centerX = spawnX;
  const centerZ = spawnZ;

  // Fly to center using Vec3
  console.log(`[Terrain] Flying to prep position...`);
  try {
    bot.creative.startFlying();
    await bot.creative.flyTo(new Vec3(centerX, originY + 50, centerZ));
    console.log(`[Terrain] Arrived at prep position`);
  } catch (e) {
    console.log(`[Terrain] Fly error (continuing): ${e.message}`);
  }

  await sleep(1000);

  // Check OP
  const isOP = await checkOP(bot);
  console.log(`[Terrain] OP status: ${isOP ? 'YES - using /fill (fast)' : 'NO - using block-by-block'}`);

  if (isOP) {
    await prepareWithFill(bot, x1, x2, z1, z2, originY);
  } else {
    await prepareBlockByBlock(bot, x1, x2, z1, z2, originY);
  }

  // Place gold block at center
  await placeGoldMarker(bot, centerX, originY, centerZ);

  console.log(`[Terrain] ✅ Terrain prep complete!`);
  console.log(`[Terrain] 📍 Gold block center at: ${centerX}, ${originY}, ${centerZ}`);
  console.log(`[Terrain] 📸 Screenshot: /tp @s ${centerX} ${originY + 400} ${centerZ} then look straight down`);

  return { originX, originY, originZ, centerX, centerY: originY, centerZ };
}

async function prepareWithFill(bot, x1, x2, z1, z2, originY) {
  console.log(`[Terrain] Step 1/3: Clearing above build level...`);
  bot.chat(`/fill ${x1} ${originY} ${z1} ${x2} 320 ${z2} air`);
  await sleep(5000);

  console.log(`[Terrain] Step 2/3: Filling holes below build level...`);
  bot.chat(`/fill ${x1} -64 ${z1} ${x2} ${originY - 1} ${z2} stone`);
  await sleep(5000);

  console.log(`[Terrain] Step 3/3: Placing flat base...`);
  bot.chat(`/fill ${x1} ${originY - 1} ${z1} ${x2} ${originY - 1} ${z2} stone`);
  await sleep(3000);

  console.log(`[Terrain] /fill complete!`);
}

async function prepareBlockByBlock(bot, x1, x2, z1, z2, originY) {
  const width = x2 - x1 + 1;
  const depth = z2 - z1 + 1;
  let done = 0;
  const total = width * depth;

  console.log(`[Terrain] Block-by-block prep started (${total} blocks)...`);

  for (let x = x1; x <= x2; x++) {
    for (let z = z1; z <= z2; z++) {
      try {
        // Use Vec3 for blockAt
        const buildPos = new Vec3(x, originY, z);
        const abovePos = new Vec3(x, originY + 1, z);
        const belowPos = new Vec3(x, originY - 1, z);

        const buildBlock = bot.blockAt(buildPos);
        const aboveBlock = bot.blockAt(abovePos);
        const belowBlock = bot.blockAt(belowPos);

        // Clear block at build level
        if (buildBlock && buildBlock.name !== 'air') {
          await bot.creative.setBlock(buildPos, 0);
        }

        // Clear one block above
        if (aboveBlock && aboveBlock.name !== 'air') {
          await bot.creative.setBlock(abovePos, 0);
        }

        // Fill hole below
        if (!belowBlock || belowBlock.name === 'air' ||
            belowBlock.name === 'water' || belowBlock.name === 'lava') {
          await bot.creative.setBlock(belowPos, 1); // stone
        }
      } catch (e) {
        // ignore individual block errors, keep going
      }

      done++;
      if (done % 5000 === 0) {
        const pct = ((done / total) * 100).toFixed(1);
        console.log(`[Terrain] Block-by-block prep: ${pct}% done`);
        await sleep(10);
      }
    }
    await sleep(5);
  }

  console.log(`[Terrain] Block-by-block prep complete!`);
}

async function placeGoldMarker(bot, x, y, z) {
  try {
    const goldId = bot.registry.blocksByName['gold_block']?.id;
    if (goldId !== undefined) {
      await bot.creative.setBlock(new Vec3(x, y, z), goldId);
      console.log(`[Terrain] Gold block placed at center (${x}, ${y}, ${z})`);
    }
  } catch (e) {
    console.log(`[Terrain] Could not place gold marker: ${e.message}`);
  }
}

module.exports = { prepareTerrain };
