// ============================================================
//   IMAGE PROCESSOR + FILE WATCHER
//   Watches for image drop and processes it automatically
// ============================================================

const Jimp = require('jimp');
const fs = require('fs');
const { getClosestBlock } = require('./blockPalette');
const config = require('./config');

let imageReady = false;
let onImageReadyCallback = null;

/**
 * Start watching the images folder for a new image
 */
function watchForImage(callback) {
  onImageReadyCallback = callback;
  const imagePath = config.image.path;

  // Check if image already exists on startup
  if (fs.existsSync(imagePath)) {
    console.log(`[ImageWatcher] Image already found at ${imagePath}`);
    imageReady = true;
    if (onImageReadyCallback) onImageReadyCallback();
    return;
  }

  console.log(`[ImageWatcher] Waiting for image at ${imagePath}...`);
  console.log(`[ImageWatcher] Drop your image in the images/ folder as "input.png"`);

  // Watch the images folder
  fs.watch('./images', (eventType, filename) => {
    if (filename && filename === 'input.png' && !imageReady) {
      // Small delay to make sure file is fully written
      setTimeout(() => {
        if (fs.existsSync(imagePath)) {
          console.log(`[ImageWatcher] Image detected! Ready to build.`);
          imageReady = true;
          if (onImageReadyCallback) onImageReadyCallback();
        }
      }, 1000);
    }
  });
}

/**
 * Process the image into a 2D block grid
 */
async function processImage() {
  const imagePath = config.image.path;
  const width = config.image.width;
  const height = config.image.height;

  console.log(`[ImageProcessor] Loading ${imagePath}...`);

  let image;
  try {
    image = await Jimp.read(imagePath);
  } catch (e) {
    throw new Error(`Cannot load image: ${e.message}`);
  }

  image.resize(width, height);
  console.log(`[ImageProcessor] Resized to ${width}x${height}`);

  const grid = [];
  const total = width * height;
  let done = 0;

  for (let row = 0; row < height; row++) {
    const rowBlocks = [];
    for (let col = 0; col < width; col++) {
      const pixel = Jimp.intToRGBA(image.getPixelColor(col, row));
      if (pixel.a < 10) {
        rowBlocks.push(null); // transparent = skip
      } else {
        rowBlocks.push(getClosestBlock(pixel.r, pixel.g, pixel.b));
      }
      done++;
      if (done % 25000 === 0) {
        console.log(`[ImageProcessor] ${((done / total) * 100).toFixed(1)}% processed...`);
      }
    }
    grid.push(rowBlocks);
  }

  console.log(`[ImageProcessor] Done! ${total} blocks mapped.`);
  return grid;
}

function isImageReady() {
  return imageReady;
}

module.exports = { watchForImage, processImage, isImageReady };
