// ============================================================
//   TERRAIN PREP
//   Uses creative mode placeBlock (no OP needed)
//   Splits into strips to stay manageable
// ============================================================

const config = require('./config');
const { Vec3 } = require('vec3');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Place a block in creative mode using packet + placeBlock
// No OP required — just creative mode
async function creativePlace(bot, x, y, z, blockName) {
  try {
    const blockId = bot.registry.blocksByName[blockName]?.id;
    if (blockId === undefined) return false;

    // Write block into hotbar slot 36 (slot 0) via creative packet
    bot._client.write('set_creative_slot', {
      slot: 36,
      item: { present: true, itemId: blockId, itemCount: 64 }
    });
    bot.setQuickBarSlot(0);
    await sleep(30);

    // Place against the block below (face up = Vec3(0,1,0))
    const refBlock = bot.blockAt(new Vec3(x, y - 1, z));
    if (!refBlock) return false;
    await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
    return true;
  } catch (e) {
    return false;
  }
}

async function prepareTerrain(bot) {
  const width  = config.image.width;
  const height = config.image.height;

  const spawnX = Math.floor(bot.spawnPoint?.x ?? bot.entity.position.x);
  const spawnY = Math.floor(bot.spawnPoint?.y ?? bot.entity.position.y);
  const spawnZ = Math.floor(bot.spawnPoint?.z ?? bot.entity.position.z);

  console.log(`[Terrain] Spawn detected: (${spawnX}, ${spawnY}, ${spawnZ})`);

  const originX = spawnX - Math.floor(width / 2);
  const originZ = spawnZ - Math.floor(height / 2);
  const originY = spawnY;

  const x1 = originX;
  const x2 = originX + width - 1;
  const z1 = originZ;
  const z2 = originZ + height - 1;

  console.log(`[Terrain] Area: (${x1},${originY},${z1}) → (${x2},${originY},${z2})`);
  console.log(`[Terrain] This will take ~30-40 mins (250k blocks, no OP)`);

  // Fly to center above area
  try {
    bot.creative.startFlying();
    await bot.creative.flyTo(new Vec3(spawnX, originY + 60, spawnZ));
  } catch (e) {
    console.log(`[Terrain] Fly error (continuing): ${e.message}`);
  }
  await sleep(1000);

  let done = 0;
  const total = width * height;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const x = x1 + col;
      const z = z1 + row;

      // Fly to position
      try {
        await bot.creative.flyTo(new Vec3(x, originY + 5, z));
      } catch (e) {}

      // Clear block at build level if not air
      try {
        const current = bot.blockAt(new Vec3(x, originY, z));
        if (current && current.name !== 'air' && current.name !== 'stone') {
          await bot.dig(current);
        }
      } catch (e) {}

      // Place stone base
      const existing = bot.blockAt(new Vec3(x, originY, z));
      if (!existing || existing.name === 'air') {
        await creativePlace(bot, x, originY, z, 'stone');
      }

      done++;
      await sleep(config.build.placeDelay);

      if (done % 5000 === 0) {
        const pct = ((done / total) * 100).toFixed(1);
        console.log(`[Terrain] Prep: ${pct}% (${done}/${total})`);
      }
    }
  }

  // Gold marker one block ABOVE build level so build doesn't overwrite it
  try {
    await bot.creative.flyTo(new Vec3(spawnX, originY + 5, spawnZ));
    await creativePlace(bot, spawnX, originY + 1, spawnZ, 'gold_block');
    console.log(`[Terrain] Gold marker placed at (${spawnX}, ${originY + 1}, ${spawnZ})`);
  } catch (e) {}

  console.log(`[Terrain] ✅ Terrain prep complete!`);
  console.log(`[Terrain] 📍 Origin: (${originX}, ${originY}, ${originZ})`);

  return { originX, originY, originZ, centerX: spawnX, centerY: originY, centerZ: spawnZ };
}

module.exports = { prepareTerrain, creativePlace };
