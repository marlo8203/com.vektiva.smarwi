/**
 * Builds the driver images from the product photo: trimmed to the device and
 * centred on a square white canvas, the way the App Store wants them.
 * Author: Marian Lojka <marian.lojka@gmail.com>
 */
// Needs `npm i -g sharp` (or a local install); it is not a dependency of the app.
const sharp = require('sharp');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'docs', 'vektiva-product.png');

async function build(size, margin) {
  const box = Math.round(size * (1 - margin * 2));

  const device = await sharp(source)
    .flatten({ background: '#ffffff' })
    .trim({ background: '#ffffff', threshold: 12 })
    .resize(box, box, { fit: 'inside' })
    .toBuffer();

  return sharp({
    create: {
      width: size, height: size, channels: 3, background: '#ffffff',
    },
  })
    .composite([{ input: device, gravity: 'centre' }])
    .png()
    .toBuffer();
}

(async () => {
  for (const size of [75, 500, 1000]) {
    const buffer = await build(size, size === 75 ? 0.04 : 0.08);
    const out = path.join(root, 'drivers/smarwi/assets/images',
      size === 75 ? 'small.png' : size === 500 ? 'large.png' : 'xlarge.png');
    await sharp(buffer).toFile(out);
    console.log(`${out}  ${size}x${size}`);
  }
})();
