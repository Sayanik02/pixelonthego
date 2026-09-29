// ============================================================
//   BLOCK PALETTE
//   Maps RGB colors to the closest Minecraft block
// ============================================================

const BLOCK_PALETTE = [
  // --- CONCRETE (most vivid) ---
  { r: 207, g: 213, b: 214, block: 'white_concrete' },
  { r: 100, g: 100, b: 100, block: 'gray_concrete' },
  { r: 55,  g: 58,  b: 62,  block: 'black_concrete' },
  { r: 169, g: 169, b: 169, block: 'light_gray_concrete' },
  { r: 160, g: 77,  b: 78,  block: 'red_concrete' },
  { r: 224, g: 97,  b: 0,   block: 'orange_concrete' },
  { r: 240, g: 175, b: 21,  block: 'yellow_concrete' },
  { r: 94,  g: 168, b: 24,  block: 'lime_concrete' },
  { r: 36,  g: 137, b: 199, block: 'light_blue_concrete' },
  { r: 45,  g: 46,  b: 143, block: 'blue_concrete' },
  { r: 100, g: 32,  b: 156, block: 'purple_concrete' },
  { r: 169, g: 48,  b: 159, block: 'magenta_concrete' },
  { r: 213, g: 101, b: 142, block: 'pink_concrete' },
  { r: 21,  g: 119, b: 136, block: 'cyan_concrete' },
  { r: 73,  g: 91,  b: 36,  block: 'green_concrete' },
  { r: 96,  g: 59,  b: 31,  block: 'brown_concrete' },

  // --- WOOL (softer tones) ---
  { r: 233, g: 236, b: 236, block: 'white_wool' },
  { r: 157, g: 157, b: 151, block: 'light_gray_wool' },
  { r: 62,  g: 68,  b: 71,  block: 'gray_wool' },
  { r: 20,  g: 21,  b: 25,  block: 'black_wool' },
  { r: 160, g: 83,  b: 65,  block: 'red_wool' },
  { r: 240, g: 118, b: 19,  block: 'orange_wool' },
  { r: 246, g: 208, b: 61,  block: 'yellow_wool' },
  { r: 112, g: 185, b: 25,  block: 'lime_wool' },
  { r: 58,  g: 176, b: 221, block: 'light_blue_wool' },
  { r: 60,  g: 68,  b: 170, block: 'blue_wool' },
  { r: 122, g: 42,  b: 173, block: 'purple_wool' },
  { r: 188, g: 78,  b: 181, block: 'magenta_wool' },
  { r: 237, g: 141, b: 172, block: 'pink_wool' },
  { r: 21,  g: 137, b: 145, block: 'cyan_wool' },
  { r: 84,  g: 109, b: 27,  block: 'green_wool' },
  { r: 114, g: 71,  b: 40,  block: 'brown_wool' },

  // --- TERRACOTTA (skin tones / earthy) ---
  { r: 209, g: 177, b: 161, block: 'white_terracotta' },
  { r: 135, g: 107, b: 98,  block: 'light_gray_terracotta' },
  { r: 57,  g: 42,  b: 35,  block: 'black_terracotta' },
  { r: 58,  g: 42,  b: 36,  block: 'gray_terracotta' },
  { r: 143, g: 61,  b: 46,  block: 'red_terracotta' },
  { r: 162, g: 84,  b: 38,  block: 'orange_terracotta' },
  { r: 186, g: 133, b: 35,  block: 'yellow_terracotta' },
  { r: 103, g: 117, b: 52,  block: 'lime_terracotta' },
  { r: 113, g: 108, b: 137, block: 'light_blue_terracotta' },
  { r: 74,  g: 59,  b: 91,  block: 'blue_terracotta' },
  { r: 118, g: 70,  b: 86,  block: 'purple_terracotta' },
  { r: 149, g: 88,  b: 108, block: 'magenta_terracotta' },
  { r: 161, g: 78,  b: 78,  block: 'pink_terracotta' },
  { r: 86,  g: 91,  b: 91,  block: 'cyan_terracotta' },
  { r: 76,  g: 83,  b: 42,  block: 'green_terracotta' },
  { r: 77,  g: 51,  b: 35,  block: 'brown_terracotta' },

  // --- NATURAL BLOCKS ---
  { r: 125, g: 125, b: 125, block: 'stone' },
  // 'sand' falls if there is nothing under it, so the builder (opBuilder.js) always lays a
  // solid stone layer one block DOWN before placing art. That lets us use REAL sand again.
  // 'dirt' can turn into grass, so we use coarse_dirt (never changes).
  // sr/sg/sb = the REAL block color (used for previews and scan maps).
  { r: 164, g: 148, b: 97,  sr: 219, sg: 207, sb: 160, block: 'sand' },
  { r: 89,  g: 62,  b: 26,  sr: 119, sg: 85,  sb: 59,  block: 'coarse_dirt' },
];

/**
 * Find closest Minecraft block for a given RGB color
 * Uses weighted Euclidean distance (human eye sensitivity)
 */
function getClosestBlock(r, g, b) {
  let minDistance = Infinity;
  let closestBlock = 'gray_concrete';

  for (const entry of BLOCK_PALETTE) {
    const dr = r - entry.r;
    const dg = g - entry.g;
    const db = b - entry.b;
    const distance = (dr * dr * 0.3) + (dg * dg * 0.59) + (db * db * 0.11);
    if (distance < minDistance) {
      minDistance = distance;
      closestBlock = entry.block;
    }
  }

  return closestBlock;
}

module.exports = { getClosestBlock, BLOCK_PALETTE };
