/* ============================================================================
 * AgriSuri core logic — pure functions, no DOM, no network.
 *
 * Loaded as a classic script in the browser (window.Core) and required directly
 * by the Node test suite (module.exports). Keeping the decision logic here is
 * what makes it testable without a build step.
 * ========================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. Prediction normalisation
   * ------------------------------------------------------------------ */

  /**
   * Turn raw model scores into an integer percentage distribution that sums to
   * exactly 100, using the largest-remainder method.
   *
   * Two properties matter and both are tested:
   *   - the output always sums to exactly 100;
   *   - zero-share classes are dropped *before* rounding, so dropping them
   *     cannot break the sum.
   *
   * Raw model probabilities are returned untouched alongside, because they are
   * not calibrated and must not be presented as certainty.
   */
  /*
   * Model class names must equal `diseases.code` or the scan resolves to no
   * disease row: no name, no prevention text, and a healthy leaf gets reported
   * as an unnamed disease.
   *
   * The Teachable Machine rice model was trained with `rice_*` class names
   * while the database uses `palay_*`. Tomato and both gate models already use
   * the canonical names, so they pass through untouched.
   */
  const LABEL_ALIASES = {
    rice_healthy: 'palay_healthy',
    rice_tungro: 'palay_tungro',
    rice_sheath_blight: 'palay_sheath_blight',
    rice_blast: 'palay_blast',
    rice_brown_spot: 'palay_brown_spot',
    rice_bacterial_blight: 'palay_bacterial_blight',
  };

  /** Map a model's class name onto the code the database uses. */
  function normalizeLabel(label) {
    const key = String(label);
    return LABEL_ALIASES[key] || key;
  }

  function normalizePercentages(predictions) {
    const cleaned = (predictions || [])
      .filter((p) => p && typeof p.confidence === 'number' && isFinite(p.confidence) && p.confidence > 0)
      .map((p) => ({ label: String(p.label), raw: Math.max(0, Math.min(1, p.confidence)) }))
      .sort((a, b) => b.raw - a.raw);

    if (!cleaned.length) return [];

    const total = cleaned.reduce((s, p) => s + p.raw, 0);
    if (total <= 0) return [];

    const exact = cleaned.map((p) => (p.raw / total) * 100);
    const floors = exact.map((v) => Math.floor(v));
    let remainder = 100 - floors.reduce((s, v) => s + v, 0);

    // Hand out the leftover units to the largest fractional parts first.
    const order = exact
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);

    const pct = floors.slice();
    for (let k = 0; k < order.length && remainder > 0; k++) {
      pct[order[k].i] += 1;
      remainder -= 1;
    }

    return cleaned
      .map((p, i) => ({ label: p.label, raw: p.raw, pct: pct[i] }))
      .filter((p) => p.pct > 0)
      .map((p, i) => ({ ...p, rank: i + 1 }));
  }

  /** Sum guard used by the UI and the tests. */
  function sumPct(distribution) {
    return (distribution || []).reduce((s, p) => s + p.pct, 0);
  }

  function confidenceBand(confidence, cfg) {
    const high = (cfg && cfg.highConfidence) || 0.75;
    const medium = (cfg && cfg.mediumConfidence) || 0.5;
    if (typeof confidence !== 'number' || !isFinite(confidence)) return 'unknown';
    if (confidence >= high) return 'high';
    if (confidence >= medium) return 'medium';
    return 'low';
  }

  /* ------------------------------------------------------------------ *
   * 2. Image quality
   * ------------------------------------------------------------------ */

  const QUALITY_LIMITS = {
    darkMean: 55,
    brightMean: 215,
    overexposedRatio: 0.3,
    minLaplacianVar: 45,
    minEdgeDensity: 0.02,
  };

  /**
   * Evaluate pre-computed image metrics.
   * `metrics` = { mean, brightRatio, laplacianVar, edgeDensity }
   * Returns { ok, issues: [] } where issues are stable codes the UI maps to copy.
   */
  function evaluateQuality(metrics, limits) {
    const L = { ...QUALITY_LIMITS, ...(limits || {}) };
    const m = metrics || {};
    const issues = [];

    if (!isFinite(m.mean)) return { ok: false, issues: ['unreadable'] };

    if (m.mean < L.darkMean) issues.push('dark');
    if (m.mean > L.brightMean) issues.push('bright');
    if (isFinite(m.brightRatio) && m.brightRatio > L.overexposedRatio) issues.push('overexposed');
    if (isFinite(m.laplacianVar) && m.laplacianVar < L.minLaplacianVar) issues.push('blur');
    if (isFinite(m.edgeDensity) && m.edgeDensity < L.minEdgeDensity) issues.push('flat');

    // A photo that is both dark and blurry is just unusable; collapse noise.
    const unique = [...new Set(issues)];
    return { ok: unique.length === 0, issues: unique };
  }

  /* ------------------------------------------------------------------ *
   * 3. Crop validation (plant-likeness gate)
   * ------------------------------------------------------------------ */

  const GATE_WEIGHTS = { centerVeg: 0.45, veg: 0.25, greenHue: 0.15, texture: 0.15 };
  const GATE_FLOORS = { centerVeg: 0.18, veg: 0.10, greenHue: 0.12 };

  /**
   * Combine independent signals into a plant-likeness score.
   *
   * This is a documented heuristic, NOT a trained classifier. Its provenance is
   * returned with the verdict so the UI can say so plainly. When a trained gate
   * model is configured, the model verdict is used instead and this is skipped.
   *
   * signals = { centerVeg, veg, greenHue, edgeDensity }  — all 0..1
   */
  function evaluateCropGate(signals, threshold) {
    const s = signals || {};
    const t = typeof threshold === 'number' ? threshold : 0.55;

    const clamp01 = (v) => (isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
    const centerVeg = clamp01(s.centerVeg);
    const veg = clamp01(s.veg);
    const greenHue = clamp01(s.greenHue);
    const texture = clamp01((s.edgeDensity || 0) / 0.06);

    const score =
      GATE_WEIGHTS.centerVeg * centerVeg +
      GATE_WEIGHTS.veg * veg +
      GATE_WEIGHTS.greenHue * greenHue +
      GATE_WEIGHTS.texture * texture;

    const fails = [];
    if (centerVeg < GATE_FLOORS.centerVeg) fails.push('center_not_vegetation');
    if (veg < GATE_FLOORS.veg) fails.push('too_little_vegetation');
    if (greenHue < GATE_FLOORS.greenHue) fails.push('not_green_foliage');

    const pass = fails.length === 0 && score >= t;
    return {
      pass,
      score: Math.round(score * 1000) / 1000,
      threshold: t,
      reasons: fails,
      provenance: 'heuristic',
    };
  }

  /*
   * Gate decision policy, shared by both model gates.
   *
   * Raw softmax output is not calibrated, so an absolute threshold alone is the
   * wrong tool: a palay field photo scores 0.52 vs 0.48 while a wall scores
   * 0.89 vs 0.11. Both are binary decisions, but only one carries information.
   *
   * The gates exist to stop obvious non-leaves from reaching the disease model,
   * so they reject only on a CONFIDENT negative and stay out of the way
   * otherwise. A false reject costs a farmer the whole scan; a false accept
   * costs one extra model call, and the disease stage still reports low
   * confidence honestly.
   *
   * MIN_POSITIVE  — below this, a positive top class is treated as no signal.
   * NEG_MARGIN    — how far the top class must beat the runner-up before a
   *                 negative reading is trusted.
   */
  const MIN_POSITIVE = 0.45;
  const NEG_MARGIN = 0.15;

  /** Verdict from a trained gate model's class distribution. */
  function evaluateModelGate(predictions, threshold) {
    const t = typeof threshold === 'number' ? threshold : 0.70;
    const list = (predictions || []).filter((p) => typeof p.confidence === 'number');
    if (!list.length) return { pass: false, score: 0, threshold: t, reasons: ['no_output'], provenance: 'model' };

    const sorted = list.slice().sort((a, b) => b.confidence - a.confidence);
    const top = sorted[0];
    const margin = sorted.length > 1 ? top.confidence - sorted[1].confidence : null;
    const label = String(top.label).toLowerCase();
    const looksNegative = /not[_\s-]?(crop|plant)|non[_\s-]?plant|background|other/.test(label);

    let pass;
    let reason = null;

    if (margin === null) {
      pass = !looksNegative && top.confidence >= t;
      if (!pass) reason = looksNegative ? 'model_says_not_plant' : 'below_threshold';
    } else if (looksNegative) {
      pass = !(margin >= NEG_MARGIN || top.confidence >= t);
      if (!pass) reason = 'model_says_not_plant';
    } else {
      pass = top.confidence >= MIN_POSITIVE || margin >= NEG_MARGIN;
      if (!pass) reason = 'below_threshold';
    }

    return {
      pass,
      score: Math.round(top.confidence * 1000) / 1000,
      threshold: t,
      reasons: pass ? [] : [reason],
      provenance: 'model',
      topLabel: top.label,
      margin: margin === null ? null : Math.round(margin * 1000) / 1000,
      inconclusive: pass && margin !== null && top.confidence < t,
      predictions: list,
    };
  }

  /* ------------------------------------------------------------------ *
   * 3b. Texture gate (layer 2)
   *
   * A leaf photographed up close has vein structure and a broken, high-
   * frequency edge profile. Walls, floors, paper and skin do not. The model
   * decides by class label; the heuristic fallback uses edge density only.
   * ------------------------------------------------------------------ */

  const TEXTURE_NEGATIVE = /wall|concrete|cement|brick|floor|ground|pavement|paper|fabric|cloth|metal|wood|skin|hand|background|not[_\s-]?leaf|non[_\s-]?leaf|other/;
  const TEXTURE_POSITIVE = /leaf|leaves|foliage|plant|vegetation|vein/;

  function evaluateTextureGate(predictions, threshold) {
    const t = typeof threshold === 'number' ? threshold : 0.60;
    const list = (predictions || []).filter((p) => typeof p.confidence === 'number');
    if (!list.length) return { pass: false, score: 0, threshold: t, reasons: ['no_output'], provenance: 'model' };

    const sorted = list.slice().sort((a, b) => b.confidence - a.confidence);
    const top = sorted[0];
    const margin = sorted.length > 1 ? top.confidence - sorted[1].confidence : null;
    const label = String(top.label).toLowerCase();
    const negative = TEXTURE_NEGATIVE.test(label);
    const positive = !negative && TEXTURE_POSITIVE.test(label);

    let pass;
    let reason = null;

    if (margin === null) {
      // One class only: no comparison is possible, so fall back to confidence.
      pass = positive && top.confidence >= t;
      if (!pass) reason = positive ? 'below_threshold' : 'texture_not_leaf';
    } else if (!positive) {
      pass = !(margin >= NEG_MARGIN || top.confidence >= t);
      if (!pass) reason = 'texture_not_leaf';
    } else {
      pass = top.confidence >= MIN_POSITIVE || margin >= NEG_MARGIN;
      if (!pass) reason = 'below_threshold';
    }

    return {
      pass,
      score: Math.round(top.confidence * 1000) / 1000,
      threshold: t,
      reasons: pass ? [] : [reason],
      provenance: 'model',
      topLabel: top.label,
      margin: margin === null ? null : Math.round(margin * 1000) / 1000,
      // True when the gate passed only because the model had no confident
      // opinion. Callers may surface this; it is not a positive identification.
      inconclusive: pass && margin !== null && top.confidence < t,
      predictions: list,
    };
  }

  /** Edge-density fallback used when no texture model is configured. */
  function evaluateTextureHeuristic(signals, threshold) {
    const t = typeof threshold === 'number' ? threshold : 0.60;
    const edge = isFinite(signals && signals.edgeDensity) ? signals.edgeDensity : 0;
    // 0.06 is the empirical ceiling for leaf-scale detail on a 640px frame.
    const score = Math.max(0, Math.min(1, edge / 0.06));
    const pass = score >= t;
    return {
      pass,
      score: Math.round(score * 1000) / 1000,
      threshold: t,
      reasons: pass ? [] : ['texture_not_leaf'],
      provenance: 'heuristic',
    };
  }

  /* ------------------------------------------------------------------ *
   * 3c. Framing (retake, not rejection)
   *
   * A leaf that is present but off to one side is a bad photo, not a wrong
   * subject. The farmer gets asked to retake, never told the crop is invalid.
   * ------------------------------------------------------------------ */

  function evaluateFraming(signals) {
    const s = signals || {};
    const clamp01 = (v) => (isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
    const centerVeg = clamp01(s.centerVeg);
    const veg = clamp01(s.veg);

    // Foliage exists somewhere in the frame, but not where the guide is.
    if (veg >= GATE_FLOORS.veg && centerVeg < GATE_FLOORS.centerVeg) {
      return { ok: false, reason: 'off_center', centerVeg, veg };
    }
    return { ok: true, centerVeg, veg };
  }

  /* ------------------------------------------------------------------ *
   * 4. Timezone-aware date helpers
   * ------------------------------------------------------------------ */

  function partsInTZ(date, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const out = {};
    for (const { type, value } of dtf.formatToParts(date)) {
      if (type !== 'literal') out[type] = value;
    }
    return {
      year: Number(out.year),
      month: Number(out.month),
      day: Number(out.day),
      hour: Number(out.hour) % 24,
      minute: Number(out.minute),
      second: Number(out.second),
    };
  }

  function tzOffsetMs(date, tz) {
    const p = partsInTZ(date, tz);
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUTC - Math.floor(date.getTime() / 1000) * 1000;
  }

  function startOfDayInTZ(date, tz) {
    const p = partsInTZ(date, tz);
    return naiveToInstant(Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0), tz);
  }

  function startOfMonthInTZ(date, tz) {
    const p = partsInTZ(date, tz);
    return naiveToInstant(Date.UTC(p.year, p.month - 1, 1, 0, 0, 0), tz);
  }

  /**
   * Convert a "local wall-clock" timestamp (built with Date.UTC from local parts)
   * into the real UTC instant. Two passes converge for every real offset.
   */
  function naiveToInstant(naive, tz) {
    let guess = naive;
    for (let i = 0; i < 2; i++) guess = naive - tzOffsetMs(new Date(guess), tz);
    return new Date(guess);
  }

  function addDays(date, n) {
    return new Date(date.getTime() + n * 864e5);
  }

  /**
   * Calendar-aware month addition.
   *
   * Doing this with `setUTCMonth` on a UTC instant is wrong: a local-midnight
   * timestamp sits in the previous UTC month (UTC+8), so "+1 month" lands on the
   * wrong date and, from a 31-day month, silently rolls over into the next one.
   * Instead the local calendar date is advanced and converted back.
   */
  function addMonths(date, n, tz) {
    if (!tz) {
      const d = new Date(date.getTime());
      d.setUTCMonth(d.getUTCMonth() + n);
      return d;
    }
    const p = partsInTZ(date, tz);
    return naiveToInstant(Date.UTC(p.year, p.month - 1 + n, 1, 0, 0, 0), tz);
  }

  /** Start of the bucket that contains `date`, in the app timezone. */
  function bucketStartInTZ(date, bucket, tz) {
    const p = partsInTZ(date, tz);

    if (bucket === 'hour') {
      return naiveToInstant(Date.UTC(p.year, p.month - 1, p.day, p.hour, 0, 0), tz);
    }
    if (bucket === 'month') {
      return naiveToInstant(Date.UTC(p.year, p.month - 1, 1, 0, 0, 0), tz);
    }
    if (bucket === 'week') {
      // Weekday must be read from the local calendar date. getUTCDay() on a
      // local-midnight instant returns the *previous* UTC day in UTC+8.
      const cal = Date.UTC(p.year, p.month - 1, p.day);
      const dow = (new Date(cal).getUTCDay() + 6) % 7; // Monday = 0
      return naiveToInstant(cal - dow * 864e5, tz);
    }
    return naiveToInstant(Date.UTC(p.year, p.month - 1, p.day), tz);
  }

  function nextBucket(date, bucket, tz) {
    if (bucket === 'month') return addMonths(date, 1, tz);
    const step = bucket === 'hour' ? 36e5 : bucket === 'week' ? 7 * 864e5 : 864e5;
    return bucketStartInTZ(new Date(date.getTime() + step), bucket, tz);
  }

  /**
   * Resolve a preset into a half-open [from, to) UTC window plus a bucket size.
   * Half-open bounds mean a scan at exactly midnight belongs to one bucket only.
   */
  function rangeFor(preset, now, tz) {
    const n = now || new Date();
    const t = tz || 'Asia/Manila';
    const today = startOfDayInTZ(n, t);

    switch (preset) {
      case 'today':
        return { from: today, to: addDays(today, 1), bucket: 'hour' };
      case 'week':
        return { from: addDays(today, -6), to: addDays(today, 1), bucket: 'day' };
      case 'month':
        return { from: addDays(today, -29), to: addDays(today, 1), bucket: 'day' };
      case 'quarter':
        return { from: addDays(today, -89), to: addDays(today, 1), bucket: 'week' };
      case 'year':
        return { from: addMonths(startOfMonthInTZ(n, t), -11, t), to: addDays(today, 1), bucket: 'month' };
      default:
        return { from: addDays(today, -6), to: addDays(today, 1), bucket: 'day' };
    }
  }

  /** Bucket key for a UTC timestamp, evaluated in the app timezone. */
  function bucketKey(date, bucket, tz) {
    const start = bucketStartInTZ(date, bucket, tz);
    const p = partsInTZ(start, tz);

    if (bucket === 'hour') return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}`;
    if (bucket === 'month') return `${p.year}-${pad(p.month)}`;
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /**
   * Merge a sparse SQL series into a dense, ordered one.
   *
   * SQL already zero-fills with generate_series; this is the client-side guard so
   * a missing or duplicated row can never shift the x-axis away from the data.
   */
  function alignSeries(rows, range, tz) {
    const map = new Map();
    for (const r of rows || []) {
      map.set(bucketKey(new Date(r.bucket), range.bucket, tz), r);
    }

    const out = [];
    const seen = new Set();
    let cursor = bucketStartInTZ(range.from, range.bucket, tz);
    let guard = 0;

    while (cursor < range.to && guard++ < 4000) {
      const key = bucketKey(cursor, range.bucket, tz);

      if (!seen.has(key)) {
        seen.add(key);
        const hit = map.get(key);
        out.push({
          key,
          bucket: new Date(cursor.getTime()),
          scans: hit ? Number(hit.scans) || 0 : 0,
          affected: hit ? Number(hit.affected) || 0 : 0,
        });
      }

      cursor = nextBucket(cursor, range.bucket, tz);
    }

    return out;
  }

  /* ------------------------------------------------------------------ *
   * 5. Metric helpers
   * ------------------------------------------------------------------ */

  /** Percentage change between two periods, or null when there is no baseline. */
  function pctChange(current, previous) {
    if (!isFinite(current) || !isFinite(previous) || previous === 0) return null;
    return ((current - previous) / previous) * 100;
  }

  function ratio(numerator, denominator) {
    if (!isFinite(numerator) || !isFinite(denominator) || denominator === 0) return null;
    return numerator / denominator;
  }

  /** Rounds to 3 decimals; keeps coordinate precision policy in one place. */
  function roundCoord(v, precision) {
    if (typeof v !== 'number' || !isFinite(v)) return null;
    const p = typeof precision === 'number' ? precision : 3;
    const f = Math.pow(10, p);
    return Math.round(v * f) / f;
  }

  /** ISO date string (YYYY-MM-DD) for a Date, in the app timezone. */
  function isoDateInTZ(date, tz) {
    const p = partsInTZ(date, tz);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }

  return {
    normalizePercentages,
    normalizeLabel,
    sumPct,
    confidenceBand,
    evaluateQuality,
    evaluateCropGate,
    evaluateModelGate,
    evaluateTextureGate,
    evaluateTextureHeuristic,
    evaluateFraming,
    QUALITY_LIMITS,
    GATE_WEIGHTS,
    GATE_FLOORS,
    partsInTZ,
    tzOffsetMs,
    startOfDayInTZ,
    startOfMonthInTZ,
    bucketStartInTZ,
    nextBucket,
    addDays,
    addMonths,
    rangeFor,
    bucketKey,
    alignSeries,
    pctChange,
    ratio,
    roundCoord,
    isoDateInTZ,
  };
});
