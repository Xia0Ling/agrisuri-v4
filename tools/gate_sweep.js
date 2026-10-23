/*
 * Why the offline end-to-end number is lower than its top-1.
 *
 * The disease models are fine; the shape/texture gates are refusing real
 * diseased leaves. This records every gate score once, then sweeps the two
 * thresholds offline so the trade-off is a measured curve instead of a guess.
 *
 *   NODE_PATH=<workspace>/node_modules node tools/gate_sweep.js
 */

const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs');
const jpeg = require('jpeg-js');
const Core = require('../script/lib/core.js');

const MODELS = { shape: 'YEc0xe3RA', texture: 'nDn8d16Cr', tomato: '6ZCROPIJdo', palay: 'OLUzZa6ah' };
const SIZE = 224;
const ROOT = path.join(__dirname, '_eval');

function decode(file) {
  const { data, width, height } = jpeg.decode(fs.readFileSync(file), { useTArray: true });
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
  }
  return tf.tensor3d(rgb, [height, width, 3], 'int32');
}

async function load(id) {
  const base = `https://storage.googleapis.com/tm-model/${id}/`;
  return tf.loadLayersModel(tf.io.http(`${base}model.json`, { weightUrlConverter: (n) => `${base}${n}` }));
}

async function predict(model, labels, file) {
  const img = decode(file);
  const input = tf.tidy(() =>
    tf.image.resizeBilinear(img.toFloat(), [SIZE, SIZE]).div(127).sub(1).expandDims(0),
  );
  const out = model.predict(input);
  const probs = Array.from(await out.data());
  tf.dispose([img, input, out]);
  const total = probs.reduce((a, b) => a + b, 0) || 1;
  return probs.map((p, i) => ({ label: labels[i], confidence: p / total }));
}

function images(crop) {
  const dir = path.join(ROOT, crop);
  const out = [];
  for (const cls of fs.readdirSync(dir).sort()) {
    const sub = path.join(dir, cls);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub).sort()) {
      if (f.toLowerCase().endsWith('.jpg')) out.push({ file: path.join(sub, f), truth: cls, crop });
    }
  }
  return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const alias = (s) => String(s || '').replace(/^rice_/, 'palay_');

(async () => {
  const models = {};
  const labels = {};
  for (const [k, id] of Object.entries(MODELS)) {
    labels[k] = (await (await fetch(`https://storage.googleapis.com/tm-model/${id}/metadata.json`)).json()).labels;
    models[k] = await load(id);
  }

  const rows = [];
  const all = [...images('tomato'), ...images('palay'), ...images('negative')];

  for (const row of all) {
    const isNeg = row.crop === 'negative';
    const s = await predict(models.shape, labels.shape, row.file);
    const t = await predict(models.texture, labels.texture, row.file);

    let correct = false;
    if (!isNeg) {
      const d = (await predict(models[row.crop], labels[row.crop], row.file))
        .slice()
        .sort((a, b) => b.confidence - a.confidence);
      correct = norm(alias(d[0].label)) === norm(row.truth);
    }

    // Keep the full distributions: the gates decide on the label as well as the
    // score (a confident "not_plant" fails regardless of threshold), so scoring
    // them by hand would model the wrong thing.
    rows.push({ isNeg, correct, shape: s, texture: t });
  }

  fs.writeFileSync(path.join(__dirname, 'gate_scores.json'), JSON.stringify(rows));

  const positives = rows.filter((r) => !r.isNeg);
  const negatives = rows.filter((r) => r.isNeg);

  console.log(`positives ${positives.length}, negatives ${negatives.length}`);

  console.log('\n  shape  texture | e2e correct | negatives rejected');
  for (const st of [0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
    for (const tt of [0.45, 0.5, 0.55, 0.6]) {
      const pass = positives.filter((r) =>
        Core.evaluateModelGate(r.shape, st).pass &&
        Core.evaluateTextureGate(r.texture, tt).pass &&
        r.correct).length;
      const rej = negatives.filter((r) =>
        !Core.evaluateModelGate(r.shape, st).pass ||
        !Core.evaluateTextureGate(r.texture, tt).pass).length;
      console.log(
        `  ${st.toFixed(2)}  ${tt.toFixed(2)}   | ${String(pass).padStart(3)}/${positives.length} ` +
          `${((pass / positives.length) * 100).toFixed(1).padStart(5)}% | ${rej}/${negatives.length}`,
      );
    }
  }
})();
