/* ============================================================================
 * Sample data for the UI preview.
 *
 * No inference model is connected and a fresh database has no scans, so charts
 * would all be empty. This module produces deterministic, realistic-looking
 * numbers so the interface can be reviewed.
 *
 * Rules it follows:
 *   - nothing here is ever written to Supabase;
 *   - every card that uses it renders a "Sample data" badge;
 *   - it never claims to be a diagnosis.
 *
 * Turn it off with DEMO_DATA.enabled = false in config.js.
 * ========================================================================== */

const Demo = (() => {
  const ON = () => !!(typeof DEMO_DATA !== 'undefined' && DEMO_DATA.enabled);

  const DISEASES = {
    tomato: [
      { code: 'tomato_early_blight', label: 'Early Blight', healthy: false, weight: 34 },
      { code: 'tomato_late_blight', label: 'Late Blight', healthy: false, weight: 18 },
      { code: 'tomato_septoria', label: 'Septoria Leaf Spot', healthy: false, weight: 14 },
      { code: 'tomato_leaf_mold', label: 'Leaf Mold', healthy: false, weight: 9 },
      { code: 'tomato_healthy', label: 'Healthy', healthy: true, weight: 25 },
    ],
    palay: [
      { code: 'palay_blast', label: 'Rice Blast', healthy: false, weight: 31 },
      { code: 'palay_bacterial_blight', label: 'Bacterial Leaf Blight', healthy: false, weight: 21 },
      { code: 'palay_brown_spot', label: 'Brown Spot', healthy: false, weight: 16 },
      { code: 'palay_tungro', label: 'Tungro', healthy: false, weight: 7 },
      { code: 'palay_healthy', label: 'Healthy', healthy: true, weight: 25 },
    ],
  };

  const BARANGAYS = [
    'Callos', 'Las Piñas', 'Poblacion I', 'Poblacion II', 'Poblacion III',
    'Poblacion IV', 'San Josef', 'San Mariano', 'Santo Tomas', 'Sinasajan',
  ];

  /* ------------------------------------------------------------------ *
   * Deterministic pseudo-randomness, seeded by the date window, so the
   * same range always renders the same numbers.
   * ------------------------------------------------------------------ */

  function seedFrom(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rng(seed) {
    let a = seed;
    return function next() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const rangeSeed = (range) => `${range.from.toISOString().slice(0, 13)}|${range.bucket}`;

  /* ------------------------------------------------------------------ *
   * Aggregates
   * ------------------------------------------------------------------ */

  function series(range) {
    const rand = rng(seedFrom(rangeSeed(range)));
    const days = Math.max(1, Math.round((range.to - range.from) / 864e5));
    const out = [];
    const step = range.bucket === 'hour' ? 1 : range.bucket === 'week' ? 7 : range.bucket === 'month' ? 30 : 1;
    const slots = range.bucket === 'hour' ? 24 : Math.ceil(days / step);

    let cursor = new Date(range.from.getTime());

    for (let i = 0; i < slots; i++) {
      // A gentle weekly rhythm plus noise, so the chart looks like real use.
      const weekday = new Date(cursor.getTime() + 8 * 36e5).getUTCDay();
      const weekend = weekday === 0 || weekday === 6 ? 0.55 : 1;
      const base = 2.6 * weekend;
      const scans = Math.max(0, Math.round(base + rand() * 3.4 - 0.6));
      const affected = Math.round(scans * (0.42 + rand() * 0.22));

      out.push({ bucket: new Date(cursor.getTime()), scans, affected });

      if (range.bucket === 'hour') cursor = new Date(cursor.getTime() + 36e5);
      else if (range.bucket === 'week') cursor = new Date(cursor.getTime() + 7 * 864e5);
      else if (range.bucket === 'month') {
        cursor = new Date(cursor.getTime());
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      } else cursor = new Date(cursor.getTime() + 864e5);
    }

    return out;
  }

  function summary(range) {
    const rows = series(range);
    const scans = rows.reduce((s, r) => s + r.scans, 0);
    const affected = rows.reduce((s, r) => s + r.affected, 0);
    return {
      scans,
      affected,
      farmers: Math.min(10, Math.max(3, Math.round(scans / 7))),
      confirmed: Math.round(affected * 0.22),
      barangays: Math.min(BARANGAYS.length, Math.max(2, Math.round(scans / 12))),
    };
  }

  /** Counts by crop, split so the total matches the summary. */
  function crops(range) {
    const total = summary(range).scans;
    const tomato = Math.round(total * 0.58);
    return [
      { crop_code: 'tomato', crop_name: 'Tomato', scans: tomato },
      { crop_code: 'palay', crop_name: 'Palay', scans: total - tomato },
    ];
  }

  function diseases(range) {
    const total = summary(range).scans;
    const pool = [...DISEASES.tomato, ...DISEASES.palay];
    const weightSum = pool.reduce((s, d) => s + d.weight, 0);

    let allocated = 0;
    return pool
      .map((d, i) => {
        const value = i === pool.length - 1 ? total - allocated : Math.round((d.weight / weightSum) * total);
        allocated += value;
        return { label: d.label, code: d.code, is_healthy: d.healthy, scans: value };
      })
      .filter((d) => d.scans > 0)
      .sort((a, b) => b.scans - a.scans);
  }

  function barangays(range) {
    const rand = rng(seedFrom(rangeSeed(range) + 'brgy'));
    const total = summary(range).scans;
    const chosen = BARANGAYS.slice(0, 8);

    const raw = chosen.map((name) => ({ name, w: 0.5 + rand() }));
    const wSum = raw.reduce((s, r) => s + r.w, 0);

    let allocated = 0;
    return raw.map((r, i) => {
      const scans = i === raw.length - 1 ? total - allocated : Math.round((r.w / wSum) * total);
      allocated += scans;
      return {
        barangay: r.name,
        barangay_id: null,
        scans,
        affected: Math.round(scans * (0.35 + rand() * 0.35)),
        farmers: Math.max(1, Math.round(scans / 6)),
      };
    }).sort((a, b) => b.scans - a.scans);
  }

  function barangayDisease(range) {
    const rows = barangays(range).slice(0, 6);
    const pool = diseases(range).filter((d) => !d.is_healthy).slice(0, 5);
    const out = [];

    rows.forEach((b, bi) => {
      let left = b.affected;
      pool.forEach((d, di) => {
        const share = di === pool.length - 1 ? left : Math.round(left / (pool.length - di) * (0.8 + (bi % 3) * 0.1));
        const value = Math.max(0, Math.min(left, share));
        left -= value;
        if (value > 0) out.push({ barangay: b.barangay, disease: d.label, scans: value });
      });
    });

    return out;
  }

  function farmerStats() {
    return [
      { user_id: 'demo-1', scans: 14, affected: 8, last_scan: new Date(Date.now() - 2 * 36e5).toISOString() },
      { user_id: 'demo-2', scans: 9, affected: 5, last_scan: new Date(Date.now() - 26 * 36e5).toISOString() },
      { user_id: 'demo-3', scans: 6, affected: 2, last_scan: new Date(Date.now() - 50 * 36e5).toISOString() },
    ];
  }

  /* ------------------------------------------------------------------ *
   * Sample scan rows for the history list
   * ------------------------------------------------------------------ */

  function scans(count) {
    const n = count || 12;
    const pool = [...DISEASES.tomato, ...DISEASES.palay];
    const out = [];

    for (let i = 0; i < n; i++) {
      const d = pool[i % pool.length];
      const crop = d.code.startsWith('palay') ? 'palay' : 'tomato';
      out.push({
        id: `demo-scan-${i}`,
        crop_code: crop,
        status: 'validated',
        top_label: d.label,
        top_confidence: 0.62 + ((i * 7) % 30) / 100,
        confidence_band: 'medium',
        image_path: null,
        normalized: [],
        created_at: new Date(Date.now() - (i * 9 + 3) * 36e5).toISOString(),
        barangay_id: null,
        lat: null,
        lng: null,
        location_source: 'profile',
        model_id: null,
        inference_mode: null,
        demo: true,
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Sample inference result for the scan flow
   * ------------------------------------------------------------------ */

  function predictions(crop) {
    const pool = DISEASES[crop] || DISEASES.tomato;

    // Fixed, plausible scores. Deliberately not random: the same crop always
    // shows the same sample so screenshots and demos stay stable.
    const scores = crop === 'palay'
      ? [0.58, 0.21, 0.12, 0.05, 0.04]
      : [0.64, 0.18, 0.09, 0.05, 0.04];

    return pool.map((d, i) => ({ label: d.label, confidence: scores[i] != null ? scores[i] : 0.03 }));
  }

  /** Badge markup. Empty string when sample data is off. */
  function badge(extraClass) {
    if (!ON()) return '';
    return `<span class="sample-badge ${extraClass || ''}" title="${DEMO_DATA.badge}">${DEMO_DATA.badge}</span>`;
  }

  function note() {
    if (!ON()) return '';
    return `<p class="sample-note">${t('common.sampleNote')}</p>`;
  }

  return {
    on: ON,
    series,
    summary,
    crops,
    diseases,
    barangays,
    barangayDisease,
    farmerStats,
    scans,
    predictions,
    badge,
    note,
    BARANGAYS,
  };
})();
