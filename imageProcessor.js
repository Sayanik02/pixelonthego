// ============================================================
//   IMAGE PROCESSOR + FILE WATCHER
// ============================================================

const Jimp = require('jimp');
const fs = require('fs');
const { getClosestBlock } = require('./blockPalette');
const config = require('./config');

// Use Railway volume if available, otherwise local
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const IMAGE_PATH = `${VOLUME}/input.png`;

let imageReady = false;
let onImageReadyCallback = null;

function watchForImage(callback) {
  onImageReadyCallback = callback;

  // Check if image already exists
  if (fs.existsSync(IMAGE_PATH)) {
    console.log(`[ImageWatcher] Image found at ${IMAGE_PATH}`);
    imageReady = true;
    if (onImageReadyCallback) onImageReadyCallback();
    return;
  }

  // Also check local images/ folder as fallback
  if (fs.existsSync(config.image.path)) {
    console.log(`[ImageWatcher] Image found at ${config.image.path}`);
    imageReady = true;
    if (onImageReadyCallback) onImageReadyCallback();
    return;
  }

  console.log(`[ImageWatcher] Waiting for image...`);
  console.log(`[ImageWatcher] Upload input.png to Railway volume at: ${IMAGE_PATH}`);

  // Watch volume folder
  try {
    fs.watch(VOLUME, (eventType, filename) => {
      if (filename === 'input.png' && !imageReady) {
        setTimeout(() => {
          if (fs.existsSync(IMAGE_PATH)) {
            console.log(`[ImageWatcher] Image detected!`);
            imageReady = true;
            if (onImageReadyCallback) onImageReadyCallback();
          }
        }, 1000);
      }
    });
  } catch (e) {
    console.log(`[ImageWatcher] Watch error: ${e.message}`);
  }
}

function getImagePath() {
  if (fs.existsSync(IMAGE_PATH)) return IMAGE_PATH;
  if (fs.existsSync(config.image.path)) return config.image.path;
  return IMAGE_PATH;
}

async function processImage() {
  const imagePath = getImagePath();
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
        rowBlocks.push(null);
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
