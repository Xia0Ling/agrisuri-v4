#!/usr/bin/env node
/**
 * End-to-end check of the local scan pipeline.
 *
 * Runs real images through the local inference proxy, then feeds the raw
 * predictions through the same `Core` functions the browser uses. This is the
 * closest thing to a field test without a camera: it proves the decision logic
 * and the model chain agree, not just that the models answer.
 *
 *   node tools/verify-pipeline.js            (server must be running on :5173)
 *   node tools/verify-pipeline.js 5174
 *
 * Exit code 0 = every case behaved as expected.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Core = require('../script/lib/core.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 5173);
const BASE = `http://127.0.0.1:${PORT}`;

const THRESHOLDS = { shape: 0.70, texture: 0.60, high: 0.75, medium: 0.50 };

async function infer(stage, crop, relPath) {
  const image = fs.readFileSync(path.join(ROOT, relPath)).toString('base64');
  const res = await fetch(`${BASE}/api/infer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer verify' },
    body: JSON.stringify({ stage, crop, image }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${stage}${crop ? '/' + crop : ''} -> ${res.status} ${body.message || ''}`);
  return body;
}

function decide(predictions, threshold, kind) {
  return kind === 'shape'
    ? Core.evaluateModelGate(predictions, threshold)
    : Core.evaluateTextureGate(predictions, threshold);
}

/** `pass~` means the gate let it through because the model had no opinion. */
function fmt(g) {
  const state = g.pass ? (g.inconclusive ? 'pass~' : 'pass') : 'REJECT';
  return `${state}(${g.topLabel} ${g.score}${g.margin != null ? ` m${g.margin}` : ''})`;
}

async function runCase(name, { crop, image, expect }) {
  const stages = [];
  let shape = null;
  let texture = null;

  if (expect !== 'gate_fail') {
    shape = decide((await infer('shape_gate', null, image)).predictions, THRESHOLDS.shape, 'shape');
    stages.push(`shape=${fmt(shape)}`);
    if (!shape.pass) {
      console.log(`  ${name}\n    ${stages.join('  ')}  -> rejected at shape`);
      return expect === 'shape_reject';
    }

    texture = decide((await infer('texture_gate', null, image)).predictions, THRESHOLDS.texture, 'texture');
    stages.push(`texture=${fmt(texture)}`);
    if (!texture.pass) {
      console.log(`  ${name}\n    ${stages.join('  ')}  -> rejected at texture`);
      return expect === 'texture_reject';
    }
  } else {
    // Negative case: the shape gate alone must reject it.
    shape = decide((await infer('shape_gate', null, image)).predictions, THRESHOLDS.shape, 'shape');
    stages.push(`shape=${fmt(shape)}`);
    console.log(`  ${name}\n    ${stages.join('  ')}`);
    return !shape.pass;
  }

  const disease = await infer('disease', crop, image);
  const distribution = Core.normalizePercentages(disease.predictions);
  const band = Core.confidenceBand(distribution[0].raw, THRESHOLDS);

  const top = distribution[0];
  const sorted = distribution.every((p, i) => i === 0 || distribution[i - 1].raw >= p.raw);
  const sums = Core.sumPct(distribution) === 100;

  console.log(
    `  ${name}\n` +
      `    ${stages.join('  ')}\n` +
      `    disease=${disease.model_id}/${disease.model_version}  band=${band}\n` +
      `    ${distribution.map((p) => `${p.label} ${p.pct}%`).join('  |  ')}`,
  );

  return top.label === expect && sorted && sums && band !== 'low';
}

(async () => {
  const cases = [
    {
      name: 'tomato early blight',
      crop: 'tomato',
      image: 'dataset/tomato_disease/tomato_early_blight/00000.jpg',
      expect: 'tomato_early_blight',
    },
    {
      name: 'palay blast',
      crop: 'palay',
      image: 'dataset/palay-disease/palay_blast/00000.jpg',
      expect: 'palay_blast',
    },
    {
      name: 'palay healthy',
      crop: 'palay',
      image: 'dataset/palay-disease/palay_healthy/00000.jpg',
      expect: 'palay_healthy',
    },
    {
      name: 'not a leaf (shape gate)',
      crop: null,
      image: 'dataset/texture/not_leaf/00000.jpg',
      expect: 'gate_fail',
    },
  ];

  let failed = 0;
  console.log(`\nAgriSuri pipeline check against ${BASE}\n`);

  for (const c of cases) {
    let ok = false;
    try {
      ok = await runCase(c.name, c);
    } catch (err) {
      console.log(`  ${c.name}\n    ERROR ${err.message}`);
    }
    console.log(`    ${ok ? 'PASS' : 'FAIL'}\n`);
    if (!ok) failed++;
  }

  console.log(failed === 0 ? 'All cases passed.\n' : `${failed} case(s) failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
