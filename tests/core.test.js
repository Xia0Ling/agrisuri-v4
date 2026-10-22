'use strict';

/**
 * Unit tests for the pure decision logic in script/lib/core.js.
 * Run: node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../script/lib/core.js');

/* ==========================================================================
 * Percentage normalisation
 * ======================================================================== */

test('normalizePercentages always sums to exactly 100', () => {
  const cases = [
    [{ label: 'a', confidence: 0.9 }, { label: 'b', confidence: 0.1 }],
    [{ label: 'a', confidence: 1 / 3 }, { label: 'b', confidence: 1 / 3 }, { label: 'c', confidence: 1 / 3 }],
    [{ label: 'a', confidence: 0.3333 }, { label: 'b', confidence: 0.3333 }, { label: 'c', confidence: 0.3334 }],
    [{ label: 'a', confidence: 0.5 }, { label: 'b', confidence: 0.3 }, { label: 'c', confidence: 0.2 }],
    Array.from({ length: 17 }, (_, i) => ({ label: `c${i}`, confidence: (i + 1) / 153 })),
    [{ label: 'only', confidence: 0.42 }],
  ];

  for (const input of cases) {
    const out = Core.normalizePercentages(input);
    assert.equal(Core.sumPct(out), 100, `sum must be 100 for ${JSON.stringify(input)}`);
  }
});

test('normalizePercentages sums to 100 across 500 randomised inputs', () => {
  for (let run = 0; run < 500; run++) {
    const n = 1 + Math.floor(Math.random() * 12);
    const preds = Array.from({ length: n }, (_, i) => ({
      label: `class-${i}`,
      confidence: Math.random(),
    }));
    const out = Core.normalizePercentages(preds);
    if (!out.length) continue;
    assert.equal(Core.sumPct(out), 100, `run ${run} produced ${Core.sumPct(out)}`);
    assert.ok(out.every((p) => Number.isInteger(p.pct) && p.pct > 0), 'every emitted pct is a positive integer');
  }
});

test('normalizeLabel maps the rice model classes onto the palay codes', () => {
  assert.equal(Core.normalizeLabel('rice_healthy'), 'palay_healthy');
  assert.equal(Core.normalizeLabel('rice_tungro'), 'palay_tungro');
  assert.equal(Core.normalizeLabel('rice_sheath_blight'), 'palay_sheath_blight');
  assert.equal(Core.normalizeLabel('rice_blast'), 'palay_blast');
  assert.equal(Core.normalizeLabel('rice_brown_spot'), 'palay_brown_spot');
  assert.equal(Core.normalizeLabel('rice_bacterial_blight'), 'palay_bacterial_blight');
});

test('normalizeLabel leaves canonical class names untouched', () => {
  assert.equal(Core.normalizeLabel('tomato_early_blight'), 'tomato_early_blight');
  assert.equal(Core.normalizeLabel('palay_healthy'), 'palay_healthy');
  assert.equal(Core.normalizeLabel('plant'), 'plant');
  assert.equal(Core.normalizeLabel('not_leaf'), 'not_leaf');
  assert.equal(Core.normalizeLabel('something_unmapped'), 'something_unmapped');
});

test('normalizePercentages drops non-positive and non-finite scores before rounding', () => {
  const out = Core.normalizePercentages([
    { label: 'a', confidence: 0.8 },
    { label: 'b', confidence: 0 },
    { label: 'c', confidence: -0.2 },
    { label: 'd', confidence: NaN },
    { label: 'e', confidence: 0.2 },
  ]);

  assert.deepEqual(out.map((p) => p.label), ['a', 'e']);
  assert.equal(Core.sumPct(out), 100);
});

test('normalizePercentages returns an empty array when there is nothing usable', () => {
  assert.deepEqual(Core.normalizePercentages([]), []);
  assert.deepEqual(Core.normalizePercentages(null), []);
  assert.deepEqual(Core.normalizePercentages([{ label: 'a', confidence: 0 }]), []);
});

test('normalizePercentages keeps raw scores and sorts by rank', () => {
  const out = Core.normalizePercentages([
    { label: 'low', confidence: 0.1 },
    { label: 'high', confidence: 0.7 },
    { label: 'mid', confidence: 0.2 },
  ]);

  assert.deepEqual(out.map((p) => p.label), ['high', 'mid', 'low']);
  assert.deepEqual(out.map((p) => p.rank), [1, 2, 3]);
  assert.equal(out[0].raw, 0.7);
});

test('a single class normalises to 100 without inflating confidence', () => {
  const out = Core.normalizePercentages([{ label: 'healthy', confidence: 0.31 }]);
  assert.equal(out[0].pct, 100);
  assert.equal(out[0].raw, 0.31);
});

/* ==========================================================================
 * Confidence bands
 * ======================================================================== */

test('confidenceBand maps thresholds correctly', () => {
  const cfg = { highConfidence: 0.75, mediumConfidence: 0.5 };
  assert.equal(Core.confidenceBand(0.9, cfg), 'high');
  assert.equal(Core.confidenceBand(0.75, cfg), 'high');
  assert.equal(Core.confidenceBand(0.6, cfg), 'medium');
  assert.equal(Core.confidenceBand(0.5, cfg), 'medium');
  assert.equal(Core.confidenceBand(0.49, cfg), 'low');
  assert.equal(Core.confidenceBand(undefined, cfg), 'unknown');
});

/* ==========================================================================
 * Image quality
 * ======================================================================== */

test('evaluateQuality accepts a well exposed, sharp frame', () => {
  const r = Core.evaluateQuality({ mean: 130, brightRatio: 0.02, laplacianVar: 320, edgeDensity: 0.12 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('evaluateQuality rejects underexposed frames', () => {
  const r = Core.evaluateQuality({ mean: 30, brightRatio: 0, laplacianVar: 300, edgeDensity: 0.1 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.includes('dark'));
});

test('evaluateQuality rejects overexposed frames', () => {
  const r = Core.evaluateQuality({ mean: 230, brightRatio: 0.6, laplacianVar: 300, edgeDensity: 0.1 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.includes('bright'));
  assert.ok(r.issues.includes('overexposed'));
});

test('evaluateQuality rejects blurry frames', () => {
  const r = Core.evaluateQuality({ mean: 120, brightRatio: 0, laplacianVar: 12, edgeDensity: 0.1 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.includes('blur'));
});

test('evaluateQuality rejects featureless frames', () => {
  const r = Core.evaluateQuality({ mean: 120, brightRatio: 0, laplacianVar: 200, edgeDensity: 0.001 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.includes('flat'));
});

test('evaluateQuality reports unreadable input instead of throwing', () => {
  const r = Core.evaluateQuality({});
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues, ['unreadable']);
});

/* ==========================================================================
 * Crop gate
 * ======================================================================== */

test('crop gate accepts a frame dominated by green foliage', () => {
  const r = Core.evaluateCropGate({ centerVeg: 0.82, veg: 0.71, greenHue: 0.65, edgeDensity: 0.09 }, 0.55);
  assert.equal(r.pass, true);
  assert.equal(r.provenance, 'heuristic');
  assert.deepEqual(r.reasons, []);
});

test('crop gate rejects a grey wall', () => {
  const r = Core.evaluateCropGate({ centerVeg: 0.02, veg: 0.03, greenHue: 0.05, edgeDensity: 0.02 }, 0.55);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.includes('center_not_vegetation'));
  assert.ok(r.reasons.includes('not_green_foliage'));
});

test('crop gate rejects a green wall that has colour but no structure', () => {
  // Painted surface: high green share, but almost no vegetation fraction in the
  // centre and no texture — this is exactly why colour alone is not used.
  const r = Core.evaluateCropGate({ centerVeg: 0.05, veg: 0.06, greenHue: 0.8, edgeDensity: 0.01 }, 0.55);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.includes('center_not_vegetation'));
  assert.ok(r.reasons.includes('too_little_vegetation'));
});

test('crop gate clamps out-of-range signals instead of producing a NaN score', () => {
  const r = Core.evaluateCropGate({ centerVeg: 5, veg: -3, greenHue: NaN, edgeDensity: Infinity }, 0.55);
  assert.ok(Number.isFinite(r.score), 'score must stay finite');
  assert.equal(r.pass, false);
});

test('model gate rejects an explicit not-crop class', () => {
  const r = Core.evaluateModelGate(
    [{ label: 'not_crop', confidence: 0.95 }, { label: 'tomato', confidence: 0.05 }],
    0.7,
  );
  assert.equal(r.pass, false);
  assert.deepEqual(r.reasons, ['model_says_not_plant']);
  assert.equal(r.provenance, 'model');
});

test('model gate rejects a confident but below-threshold crop class', () => {
  const r = Core.evaluateModelGate([{ label: 'tomato', confidence: 0.61 }], 0.7);
  assert.equal(r.pass, false);
  assert.deepEqual(r.reasons, ['below_threshold']);
});

test('model gate accepts a confident crop class', () => {
  const r = Core.evaluateModelGate([{ label: 'palay', confidence: 0.88 }], 0.7);
  assert.equal(r.pass, true);
  assert.equal(r.topLabel, 'palay');
});

test('model gate fails closed when the model returns nothing', () => {
  const r = Core.evaluateModelGate([], 0.7);
  assert.equal(r.pass, false);
  assert.deepEqual(r.reasons, ['no_output']);
});

/* ==========================================================================
 * Date ranges and bucketing
 * ======================================================================== */

const TZ = 'Asia/Manila';

test('rangeFor produces half-open windows of the expected length', () => {
  const now = new Date('2026-10-18T14:00:00+08:00');

  const week = Core.rangeFor('week', now, TZ);
  assert.equal(Math.round((week.to - week.from) / 864e5), 7);
  assert.equal(week.bucket, 'day');

  const month = Core.rangeFor('month', now, TZ);
  assert.equal(Math.round((month.to - month.from) / 864e5), 30);

  const today = Core.rangeFor('today', now, TZ);
  assert.equal(Math.round((today.to - today.from) / 864e5), 1);
  assert.equal(today.bucket, 'hour');
});

test('rangeFor starts at local midnight, not UTC midnight', () => {
  const now = new Date('2026-10-18T23:30:00+08:00');
  const day = Core.rangeFor('today', now, TZ);
  const p = Core.partsInTZ(day.from, TZ);

  assert.equal(p.hour, 0);
  assert.equal(p.minute, 0);
  assert.equal(p.day, 18);
  assert.equal(p.month, 10);
});

test('a scan at exactly local midnight lands in the new day only', () => {
  const midnight = new Date('2026-10-18T00:00:00+08:00');
  const justBefore = new Date('2026-10-17T23:59:59+08:00');

  assert.equal(Core.bucketKey(midnight, 'day', TZ), '2026-10-18');
  assert.equal(Core.bucketKey(justBefore, 'day', TZ), '2026-10-17');
});

test('bucketKey groups weeks by their Monday', () => {
  const sunday = new Date('2026-10-18T10:00:00+08:00');
  const monday = new Date('2026-10-12T10:00:00+08:00');
  assert.equal(Core.bucketKey(sunday, 'week', TZ), Core.bucketKey(monday, 'week', TZ));
});

test('alignSeries zero-fills missing buckets and keeps them ordered', () => {
  const now = new Date('2026-10-18T14:00:00+08:00');
  const range = Core.rangeFor('week', now, TZ);

  const rows = [
    { bucket: '2026-10-12T00:00:00+08:00', scans: 3, affected: 1 },
    { bucket: '2026-10-16T00:00:00+08:00', scans: 5, affected: 2 },
  ];

  const out = Core.alignSeries(rows, range, TZ);
  assert.equal(out.length, 7);
  assert.deepEqual(out.map((r) => r.scans), [3, 0, 0, 0, 5, 0, 0]);
  assert.deepEqual(out.map((r) => r.affected), [1, 0, 0, 0, 2, 0, 0]);

  const keys = out.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate buckets');
});

test('alignSeries does not duplicate the final bucket when stepping by month', () => {
  const now = new Date('2026-10-18T14:00:00+08:00');
  const range = Core.rangeFor('year', now, TZ);
  const out = Core.alignSeries([], range, TZ);

  assert.equal(out.length, 12);
  const keys = out.map((r) => r.key);
  assert.equal(new Set(keys).size, 12);
});

test('alignSeries tolerates rows with unknown buckets without shifting the axis', () => {
  const now = new Date('2026-10-18T14:00:00+08:00');
  const range = Core.rangeFor('week', now, TZ);

  const out = Core.alignSeries([{ bucket: '2020-01-01T00:00:00Z', scans: 99 }], range, TZ);
  assert.equal(out.length, 7);
  assert.equal(out.reduce((s, r) => s + r.scans, 0), 0, 'out-of-range row is ignored');
});

/* ==========================================================================
 * Metric helpers
 * ======================================================================== */

test('pctChange returns null when there is no baseline', () => {
  assert.equal(Core.pctChange(5, 0), null);
  assert.equal(Core.pctChange(0, 0), null);
  assert.equal(Core.pctChange(NaN, 2), null);
  assert.equal(Core.pctChange(10, 5), 100);
  assert.equal(Core.pctChange(5, 10), -50);
});

test('ratio returns null instead of Infinity for an empty denominator', () => {
  assert.equal(Core.ratio(3, 0), null);
  assert.equal(Core.ratio(0, 0), null);
  assert.equal(Core.ratio(1, 4), 0.25);
});

test('roundCoord keeps three decimals so exact farm positions are not stored', () => {
  assert.equal(Core.roundCoord(15.4287234, 3), 15.429);
  assert.equal(Core.roundCoord(-121.0149999, 3), -121.015);
  assert.equal(Core.roundCoord(null, 3), null);
  assert.equal(Core.roundCoord('abc', 3), null);
});

test('isoDateInTZ uses the app timezone, not UTC', () => {
  const d = new Date('2026-10-18T23:30:00+08:00');
  assert.equal(Core.isoDateInTZ(d, TZ), '2026-10-18');
  assert.equal(Core.isoDateInTZ(d, 'UTC'), '2026-10-18');
  assert.equal(Core.isoDateInTZ(new Date('2026-10-18T00:30:00+08:00'), TZ), '2026-10-18');
});

/* ==========================================================================
 * Layer 2 — texture gate
 * ======================================================================== */

test('texture gate accepts a confident leaf-surface class', () => {
  const v = Core.evaluateTextureGate([{ label: 'leaf_texture', confidence: 0.92 }], 0.6);
  assert.equal(v.pass, true);
  assert.deepEqual(v.reasons, []);
});

test('texture gate rejects a wall even when the model is certain', () => {
  const v = Core.evaluateTextureGate([{ label: 'concrete_wall', confidence: 0.99 }], 0.6);
  assert.equal(v.pass, false);
  assert.deepEqual(v.reasons, ['texture_not_leaf']);
});

test('texture gate does not treat "not_leaf" as a positive label', () => {
  const v = Core.evaluateTextureGate([{ label: 'not_leaf', confidence: 0.95 }], 0.6);
  assert.equal(v.pass, false);
  assert.deepEqual(v.reasons, ['texture_not_leaf']);
});

test('texture gate rejects a weak leaf reading below the threshold', () => {
  const v = Core.evaluateTextureGate([{ label: 'leaf_texture', confidence: 0.41 }], 0.6);
  assert.equal(v.pass, false);
  assert.deepEqual(v.reasons, ['below_threshold']);
});

test('texture gate fails closed on an empty prediction set', () => {
  const v = Core.evaluateTextureGate([], 0.6);
  assert.equal(v.pass, false);
  assert.deepEqual(v.reasons, ['no_output']);
});

test('texture heuristic uses edge density, not colour', () => {
  assert.equal(Core.evaluateTextureHeuristic({ edgeDensity: 0.05 }, 0.6).pass, true);
  assert.equal(Core.evaluateTextureHeuristic({ edgeDensity: 0.01 }, 0.6).pass, false);
  assert.equal(Core.evaluateTextureHeuristic({}, 0.6).pass, false);
});

/* ==========================================================================
 * Framing — retake, never rejection
 * ======================================================================== */

test('framing asks for a retake when the leaf sits outside the guide', () => {
  const v = Core.evaluateFraming({ veg: 0.4, centerVeg: 0.02 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'off_center');
});

test('framing passes when the leaf is under the guide', () => {
  assert.equal(Core.evaluateFraming({ veg: 0.4, centerVeg: 0.55 }).ok, true);
});

test('framing does not fire when there is no foliage anywhere', () => {
  // No leaf at all is a gate decision, not a framing decision.
  assert.equal(Core.evaluateFraming({ veg: 0.01, centerVeg: 0.0 }).ok, true);
});
