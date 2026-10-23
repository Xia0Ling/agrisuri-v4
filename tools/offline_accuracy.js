/*
 * Offline accuracy harness.
 *
 * Runs the four Teachable Machine models the app actually uses, on the same
 * eval set and the same preprocessing the browser performs, and reuses
 * script/lib/core.js for the gate decisions — so the numbers here are the ones
 * a phone would produce, not a re-implementation of them.
 *
 *   NODE_PATH=<workspace>/node_modules node tools/offline_accuracy.js
 *
 * Not shipped to the client. Requires @tensorflow/tfjs and jpeg-js.
 */

const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs');
const jpeg = require('jpeg-js');
const Core = require('../script/lib/core.js');

const MODELS = {
  shape: 'YEc0xe3RA',
  texture: 'nDn8d16Cr',
  tomato: '6ZCROPIJdo',
  palay: 'OLUzZa6ah',
};

const THRESHOLDS = { shape: 0.70, texture: 0.60 };
const SIZE = 224;
const ROOT = path.join(__dirname, '_eval');

/** Decode a JPEG to an RGB tensor, exactly as tf.browser.fromPixels would. */
function decode(file) {
  const { data, width, height } = jpeg.decode(fs.readFileSync(file), { useTArray: true });
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return tf.tensor3d(rgb, [height, width, 3], 'int32');
}

/** Teachable Machine normalisation: pixels / 127 - 1, squashed to 224x224. */
function batch(img) {
  return tf.tidy(() =>
    tf.image.resizeBilinear(img.toFloat(), [SIZE, SIZE]).div(127).sub(1).expandDims(0),
  );
}

async function load(id) {
  const base = `https://storage.googleapis.com/tm-model/${id}/`;
  return tf.loadLayersModel(
    tf.io.http(`${base}model.json`, { weightUrlConverter: (name) => `${base}${name}` }),
  );
}

async function predict(model, labels, file) {
  const img = decode(file);
  const input = batch(img);
  const out = model.predict(input);
  const probs = Array.from(await out.data());
  tf.dispose([img, input, out]);

  const total = probs.reduce((a, b) => a + b, 0) || 1;
  return probs
    .map((p, i) => ({ label: labels[i], confidence: p / total }))
    .sort((a, b) => b.confidence - a.confidence);
}

function images(crop) {
  const dir = path.join(ROOT, crop);
  const out = [];
  for (const cls of fs.readdirSync(dir).sort()) {
    const sub = path.join(dir, cls);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub).sort()) {
      if (f.toLowerCase().endsWith('.jpg')) out.push({ file: path.join(sub, f), truth: cls });
    }
  }
  return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const alias = (s) => String(s || '').replace(/^rice_/, 'palay_');

(async () => {
  const models = {};
  const labels = {};
  for (const [key, id] of Object.entries(MODELS)) {
    const meta = await (await fetch(`https://storage.googleapis.com/tm-model/${id}/metadata.json`)).json();
    labels[key] = meta.labels;
    models[key] = await load(id);
    process.stdout.write(`loaded ${key.padEnd(8)} ${meta.labels.length} classes\n`);
  }

  const report = {};
  let e2eCorrect = 0;
  let e2eTotal = 0;

  for (const crop of ['tomato', 'palay']) {
    const rows = images(crop);
    const perClass = {};
    let top1 = 0;
    let gateBlocked = 0;

    for (const row of rows) {
      const preds = await predict(models[crop], labels[crop], row.file);
      const got = alias(preds[0].label);
      const ok = norm(got) === norm(row.truth);
      if (ok) top1 += 1;

      perClass[row.truth] = perClass[row.truth] || { n: 0, ok: 0 };
      perClass[row.truth].n += 1;
      if (ok) perClass[row.truth].ok += 1;

      // End to end: the same two gates the app runs before the disease model.
      const shape = Core.evaluateModelGate(
        (await predict(models.shape, labels.shape, row.file)).map((p) => ({ ...p, label: p.label })),
        THRESHOLDS.shape,
      );
      const texture = Core.evaluateTextureGate(
        await predict(models.texture, labels.texture, row.file),
        THRESHOLDS.texture,
      );

      e2eTotal += 1;
      if (shape.pass && texture.pass && ok) e2eCorrect += 1;
      if (!shape.pass || !texture.pass) gateBlocked += 1;
    }

    report[crop] = { rows: rows.length, top1, gateBlocked, perClass };
    process.stdout.write(
      `${crop}: top-1 ${top1}/${rows.length} (${((top1 / rows.length) * 100).toFixed(1)}%), ` +
        `gate-blocked ${gateBlocked}\n`,
    );
  }

  // Negatives: the gates exist to refuse these.
  const negs = images('negative');
  let rejected = 0;
  for (const row of negs) {
    const shape = Core.evaluateModelGate(await predict(models.shape, labels.shape, row.file), THRESHOLDS.shape);
    const texture = Core.evaluateTextureGate(
      await predict(models.texture, labels.texture, row.file),
      THRESHOLDS.texture,
    );
    if (!shape.pass || !texture.pass) rejected += 1;
  }

  const positives = report.tomato.rows + report.palay.rows;
  const top1All = report.tomato.top1 + report.palay.top1;

  console.log('\n=== offline (Teachable Machine) ===');
  console.log(`disease top-1, gates ignored : ${top1All}/${positives} = ${((top1All / positives) * 100).toFixed(1)}%`);
  console.log(`end-to-end                   : ${e2eCorrect}/${e2eTotal} = ${((e2eCorrect / e2eTotal) * 100).toFixed(1)}%`);
  console.log(`negatives rejected by gates  : ${rejected}/${negs.length} = ${((rejected / negs.length) * 100).toFixed(1)}%`);
  for (const crop of ['tomato', 'palay']) {
    console.log(`\n${crop} per class:`);
    for (const [cls, s] of Object.entries(report[crop].perClass)) {
      console.log(`  ${cls.padEnd(28)} ${s.ok}/${s.n}  ${((s.ok / s.n) * 100).toFixed(1)}%`);
    }
  }

  fs.writeFileSync(
    path.join(__dirname, 'offline_accuracy.json'),
    JSON.stringify({ report, e2eCorrect, e2eTotal, negatives: negs.length, rejected }, null, 2),
  );
})();
