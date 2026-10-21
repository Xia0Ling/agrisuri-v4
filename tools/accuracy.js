#!/usr/bin/env node
/**
 * Accuracy report for the local pipeline.
 *
 * Runs `tools/_eval` (built by make_eval_set.py at the app's own 512 px / q82
 * preprocessing) through the local inference proxy, then applies the exact
 * `Core` functions the browser uses. Two numbers matter and they are different:
 *
 *   model accuracy  — every positive image, gates ignored. Model quality.
 *   end-to-end      — only images that survive both gates. What a farmer sees.
 *
 *   python tools/make_eval_set.py --per-class 8
 *   node tools/accuracy.js
 *   node tools/accuracy.js --concurrency 4 --out tools/accuracy-report.json
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Core = require('../script/lib/core.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 5173);
const BASE = `http://127.0.0.1:${PORT}`;

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const EVAL = path.resolve(ROOT, argOf('dir', 'tools/_eval'));
const CONCURRENCY = Number(argOf('concurrency', 6));
const OUT_FILE = path.resolve(ROOT, argOf('out', 'tools/accuracy-report.json'));

const SHAPE_THRESHOLD = 0.70;
const TEXTURE_THRESHOLD = 0.60;
const BANDS = { high: 0.75, medium: 0.50 };

const CROP_OF = { tomato: 'tomato', palay: 'palay', negative: null };

/* ------------------------------------------------------------------ */

async function infer(stage, crop, file, attempt = 0) {
  const image = fs.readFileSync(file).toString('base64');
  const res = await fetch(`${BASE}/api/infer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer eval' },
    body: JSON.stringify({ stage, crop, image }),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      return infer(stage, crop, file, attempt + 1);
    }
  }

  const body = await res.json();
  if (!res.ok) throw new Error(`${stage}: ${res.status} ${body.message || ''}`);
  return body;
}

function walk() {
  const out = [];
  for (const group of Object.keys(CROP_OF)) {
    const dir = path.join(EVAL, group);
    if (!fs.existsSync(dir)) continue;
    for (const cls of fs.readdirSync(dir)) {
      const clsDir = path.join(dir, cls);
      if (!fs.statSync(clsDir).isDirectory()) continue;
      for (const f of fs.readdirSync(clsDir)) {
        if (/\.(jpe?g|png)$/i.test(f)) {
          out.push({ group, expected: cls, file: path.join(clsDir, f), crop: CROP_OF[group] });
        }
      }
    }
  }
  return out;
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ */

function pct(n, d) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : '-';
}

async function main() {
  const items = walk();
  if (!items.length) {
    console.error('No images in tools/_eval. Run: python tools/make_eval_set.py');
    process.exit(1);
  }

  const started = Date.now();
  console.log(`\nScoring ${items.length} images against ${BASE} (concurrency ${CONCURRENCY})\n`);

  let done = 0;
  const rows = await pool(items, CONCURRENCY, async (item) => {
    try {
      const [shapeRaw, textureRaw] = await Promise.all([
        infer('shape_gate', null, item.file),
        infer('texture_gate', null, item.file),
      ]);

      const shape = Core.evaluateModelGate(shapeRaw.predictions, SHAPE_THRESHOLD);
      const texture = Core.evaluateTextureGate(textureRaw.predictions, TEXTURE_THRESHOLD);

      let disease = null;
      if (item.crop) disease = await infer('disease', item.crop, item.file);

      done++;
      if (done % 20 === 0) process.stdout.write(`  ${done}/${items.length}\r`);

      return { ...item, shape, texture, disease, error: null };
    } catch (err) {
      done++;
      return { ...item, error: err.message };
    }
  });

  process.stdout.write(' '.repeat(30) + '\r');

  const failed = rows.filter((r) => r.error);
  if (failed.length) {
    console.log(`${failed.length} request(s) failed, e.g. ${failed[0].error}`);
  }

  const positives = rows.filter((r) => r.crop && r.disease && !r.error);
  const negatives = rows.filter((r) => !r.crop && !r.error);

  /* ---- model accuracy: every positive, gates ignored ---- */
  const perClass = new Map();
  let top1 = 0;
  let top3 = 0;
  const confusion = new Map();
  const unmapped = new Set();

  for (const r of positives) {
    const dist = Core.normalizePercentages(r.disease.predictions);
    const labels = dist.map((p) => p.label);
    const predicted = labels[0];
    const hit1 = predicted === r.expected;
    const hit3 = labels.slice(0, 3).includes(r.expected);

    if (hit1) top1++;
    if (hit3) top3++;
    if (!hit1) {
      const key = `${r.expected} -> ${predicted}`;
      confusion.set(key, (confusion.get(key) || 0) + 1);
    }
    if (!labels.every((l) => /^[a-z0-9_]+$/.test(l))) unmapped.add(predicted);

    const c = perClass.get(r.expected) || { n: 0, hit1: 0, hit3: 0, low: 0 };
    c.n++;
    if (hit1) c.hit1++;
    if (hit3) c.hit3++;
    if (Core.confidenceBand(dist[0].raw, BANDS) === 'low') c.low++;
    perClass.set(r.expected, c);
  }

  /* ---- gate behaviour ---- */
  const gateShape = positives.filter((r) => r.shape.pass).length;
  const gateTexture = positives.filter((r) => r.texture.pass).length;
  const gateBoth = positives.filter((r) => r.shape.pass && r.texture.pass).length;
  const negPassShape = negatives.filter((r) => r.shape.pass).length;
  const negPassTexture = negatives.filter((r) => r.texture.pass).length;
  const negPassBoth = negatives.filter((r) => r.shape.pass && r.texture.pass).length;

  /* ---- end-to-end: survivors only ---- */
  const survivors = positives.filter((r) => r.shape.pass && r.texture.pass);
  const e2e = survivors.filter(
    (r) => Core.normalizePercentages(r.disease.predictions)[0].label === r.expected,
  ).length;

  /* ---- print ---- */
  console.log('\nModel accuracy (gates ignored)\n');
  console.log(`  ${'class'.padEnd(28)} n   top-1   top-3   low-band`);
  for (const [cls, c] of [...perClass.entries()].sort()) {
    console.log(
      `  ${cls.padEnd(28)} ${String(c.n).padStart(2)}  ` +
        `${pct(c.hit1, c.n).padStart(6)}  ${pct(c.hit3, c.n).padStart(6)}  ${String(c.low).padStart(8)}`,
    );
  }

  console.log('\n  Overall');
  console.log(`    top-1            ${top1}/${positives.length}  (${pct(top1, positives.length)})`);
  console.log(`    top-3            ${top3}/${positives.length}  (${pct(top3, positives.length)})`);

  console.log('\nGates');
  console.log(`  positives passing shape      ${gateShape}/${positives.length}  (${pct(gateShape, positives.length)})`);
  console.log(`  positives passing texture    ${gateTexture}/${positives.length}  (${pct(gateTexture, positives.length)})`);
  console.log(`  positives reaching disease   ${gateBoth}/${positives.length}  (${pct(gateBoth, positives.length)})`);
  if (negatives.length) {
    console.log(`  negatives rejected by shape  ${negatives.length - negPassShape}/${negatives.length}`);
    console.log(`  negatives rejected by texture ${negatives.length - negPassTexture}/${negatives.length}`);
    console.log(`  negatives rejected by both   ${negatives.length - negPassBoth}/${negatives.length}`);
  }

  console.log('\nEnd to end (what a farmer sees)');
  console.log(`  ${e2e}/${positives.length} correct  (${pct(e2e, positives.length)})`);
  console.log(`  ${positives.length - gateBoth} image(s) never reached the disease model`);

  if (confusion.size) {
    console.log('\nTop confusions');
    [...confusion.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .forEach(([k, v]) => console.log(`  ${v}x  ${k}`));
  }
  if (unmapped.size) console.log(`\nUnexpected labels: ${[...unmapped].join(', ')}`);

  console.log(`\n  ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        images: items.length,
        model: {
          top1,
          top3,
          n: positives.length,
          per_class: Object.fromEntries(perClass),
        },
        gates: {
          positives: positives.length,
          shape_pass: gateShape,
          texture_pass: gateTexture,
          both_pass: gateBoth,
          negatives: negatives.length,
          negatives_rejected_both: negatives.length - negPassBoth,
        },
        end_to_end: { correct: e2e, n: positives.length },
        confusions: Object.fromEntries(confusion),
      },
      null,
      2,
    ),
  );
  console.log(`  report written to ${path.relative(ROOT, OUT_FILE)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
