/**
 * Rasterises the artwork SVGs into the PNG sizes the Homey App Store expects.
 * Author: Marian Lojka <marian.lojka@gmail.com>
 */
// Needs `npm i -g sharp` (or a local install); it is not a dependency of the app.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

async function render(svg, out, w, h, flatten) {
  let pipe = sharp(path.join(__dirname, svg), { density: 384 }).resize(w, h, { fit: 'fill' });
  if (flatten) pipe = pipe.flatten({ background: '#ffffff' });
  await pipe.png().toFile(path.join(root, out));
  console.log(`${out}  ${w}x${h}`);
}

module.exports = { render };

if (require.main === module) {
  (async () => {
    const jobs = JSON.parse(fs.readFileSync(path.join(__dirname, 'jobs.json'), 'utf8'));
    for (const job of jobs) await render(job.svg, job.out, job.w, job.h, job.flatten);
  })();
}
