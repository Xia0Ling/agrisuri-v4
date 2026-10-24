'use strict';

/**
 * DOM integration test.
 *
 * Executes the real page scripts inside jsdom against a stubbed Supabase client,
 * so the boot path, the query wiring and the render code all actually run. This
 * catches the class of bug that unit tests cannot: a missing element id, a wrong
 * argument name, a render function that throws on real-shaped data.
 *
 * Run:
 *   NODE_PATH=<workspace>/node_modules node --test tests/dom.test.js
 *
 * Skips cleanly when jsdom is not installed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  test('DOM integration suite', { skip: 'jsdom is not installed' }, () => {});
  module.exports = {};
  return;
}

/* ==========================================================================
 * Fixtures
 * ======================================================================== */

const BARANGAYS = [
  { id: 'b1', name: 'Callos', jurisdiction_id: 'j1' },
  { id: 'b2', name: 'Poblacion I', jurisdiction_id: 'j1' },
];

const PROFILE = {
  id: 'u1',
  full_name: 'Maria Santos',
  role: 'farmer',
  jurisdiction_id: 'j1',
  barangay_id: 'b1',
  terms_accepted_at: '2026-10-01T00:00:00.000Z',
  is_active: true,
  consent_training: false,
  created_at: '2026-09-01T02:00:00.000Z',
  email: 'maria@example.com',
};

const SCAN = {
  id: 's1',
  user_id: 'u1',
  crop_code: 'tomato',
  status: 'validated',
  top_label: 'Early Blight (Alternaria solani)',
  top_confidence: 0.82,
  confidence_band: 'high',
  image_path: 'u1/1.jpg',
  normalized: [{ label: 'Early Blight', pct: 82 }],
  created_at: '2026-10-17T03:00:00.000Z',
  barangay_id: 'b1',
  lat: 15.429,
  lng: -121.015,
  location_source: 'gps',
  model_id: 'agrisuri/tomato-disease',
  inference_mode: 'online',
  profiles: { full_name: 'Maria Santos' },
  barangays: { name: 'Callos' },
};

const DISEASES = [
  { label: 'Early Blight (Alternaria solani)', code: 'tomato_early_blight', is_healthy: false, scans: 7 },
  { label: 'Healthy', code: 'tomato_healthy', is_healthy: true, scans: 3 },
];

/* ==========================================================================
 * A chainable Supabase stub
 * ======================================================================== */

function builder(payload) {
  const api = {
    select: () => api,
    eq: () => api,
    neq: () => api,
    is: () => api,
    in: () => api,
    gte: () => api,
    lt: () => api,
    lte: () => api,
    ilike: () => api,
    order: () => api,
    limit: () => api,
    range: () => api,
    single: () => Promise.resolve(payload.single || { data: null, error: null }),
    maybeSingle: () => Promise.resolve(payload.single || { data: null, error: null }),
    then: (resolve, reject) => Promise.resolve(payload).then(resolve, reject),
  };
  return api;
}

function makeClient(overrides) {
  const o = overrides || {};
  const calls = [];

  const client = {
    calls,
    auth: {
      getSession: async () => ({
        data: { session: o.session === null ? null : { user: { id: PROFILE.id, email: PROFILE.email }, access_token: 'token' } },
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null }),
      signInWithPassword: async () => ({ data: { user: { id: PROFILE.id } }, error: null }),
      signUp: async () => ({ data: { session: null }, error: null }),
    },
    from(table) {
      calls.push(table);
      return builder(o.table ? o.table(table) : { data: [], error: null, count: 0 });
    },
    rpc(name, params) {
      calls.push(`rpc:${name}`);
      return builder(o.rpc ? o.rpc(name, params) : { data: null, error: null });
    },
    storage: {
      from() {
        return {
          upload: async () => ({ data: { path: 'x' }, error: null }),
          createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/x.jpg' }, error: null }),
          createSignedUrls: async (paths) => ({
            data: (paths || []).map((p) => ({ path: p, signedUrl: 'https://example.test/' + p })),
            error: null,
          }),
        };
      },
    },
  };

  return client;
}

/* ==========================================================================
 * Page harness
 * ======================================================================== */

function loadPage(page, client, opts) {
  const o = opts || {};
  let html = fs.readFileSync(path.join(ROOT, page), 'utf8');

  // Drop the CDN tags; the stubs below replace them.
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/g, '');

  html = html.replace(/<script src="(script\/[^"]+)"><\/script>/g, (m, src) => {
    let code = fs.readFileSync(path.join(ROOT, src), 'utf8');

    // Let a test switch sample data off without touching the real config.
    if (o.demo === false && src === 'script/config.js') {
      // Line-ending agnostic: the working tree may be CRLF on Windows.
      code = code.replace(/enabled:\s*true/, 'enabled: false');
    }

    // Let a test simulate "no gateway deployed" so the unconfigured state can
    // be asserted. Mutating the object is enough; the binding is const, not frozen.
    if (o.gateway === '' && src === 'script/config.js') {
      code += "\nAI_CONFIG.gatewayUrl = '';\n";
    }

    return `<script>\n${code}\n</script>`;
  });

  const dom = new JSDOM(html, {
    url: o.url || `https://agrisuri.test/${page}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.supabase = { createClient: () => client };

      // Seed localStorage before any page script runs, so cache-fallback paths
      // can be exercised without a network.
      if (o.storage) {
        for (const [key, value] of Object.entries(o.storage)) {
          window.localStorage.setItem(key, JSON.stringify(value));
        }
      }

      window.Chart = class Chart {
        constructor(canvas, config) {
          this.config = config;
          this.canvas = canvas;
          (window.__charts = window.__charts || []).push({ id: canvas && canvas.id, config });
        }
        destroy() {}
      };
      window.Chart.defaults = {
        font: {},
        animation: {},
        plugins: { tooltip: { titleFont: {} }, legend: { labels: {} } },
      };

      window.tmImage = { load: async () => ({ predict: async () => [] }) };
      window.tf = {};

      window.fetch = async (url) => {
        const href = String(url);

        if (href.includes('open-meteo.com/v1/forecast')) {
          const hours = Array.from({ length: 24 }, (_, i) => `2026-10-18T${String(i).padStart(2, '0')}:00`);
          return {
            ok: true,
            json: async () => ({
              current: {
                temperature_2m: 31.4,
                relative_humidity_2m: 74,
                apparent_temperature: 34.1,
                precipitation: 0,
                weather_code: 2,
                wind_speed_10m: 8.2,
                time: '2026-10-18T14:00',
              },
              daily: {
                temperature_2m_max: [33.2],
                temperature_2m_min: [24.1],
                precipitation_probability_max: [40],
              },
              hourly: {
                time: hours,
                temperature_2m: hours.map((_, i) => 24 + (i % 12)),
                weather_code: hours.map((_, i) => (i % 3 === 0 ? 2 : 1)),
                precipitation_probability: hours.map((_, i) => (i * 3) % 100),
              },
            }),
          };
        }

        if (href.includes('geocoding-api')) {
          return { ok: true, json: async () => ({ results: [{ latitude: 15.42, longitude: -121.01 }] }) };
        }

        throw new Error(`unexpected fetch: ${url}`);
      };

      window.navigator.geolocation = {
        getCurrentPosition: (_ok, fail) => fail && fail(new Error('denied')),
      };

      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

      // jsdom has no IndexedDB; the offline queue must degrade, not crash.
      delete window.indexedDB;

      window.__errors = [];
      window.addEventListener('error', (e) => window.__errors.push(e.message));
      window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
    },
  });

  return dom;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==========================================================================
 * Farmer dashboard
 * ======================================================================== */

function farmerClient(overrides) {
  const o = overrides || {};
  return makeClient({
    table(table) {
      if (table === 'profiles') {
        const p = o.noTerms ? { ...PROFILE, terms_accepted_at: null } : PROFILE;
        return { data: p, error: null, single: { data: p, error: null } };
      }
      if (table === 'barangays') return { data: BARANGAYS, error: null, count: BARANGAYS.length };
      if (table === 'scans') return o.scans || { data: [SCAN], error: null, count: 1 };
      if (table === 'diseases') return o.diseases || { data: DISEASES, error: null };
      if (table === 'scan_predictions') return { data: [], error: null };
      return { data: [], error: null, count: 0 };
    },
    rpc(name) {
      if (name === 'analytics_summary') {
        return o.summary || { data: { scans: 10, farmers: 1, affected: 6, confirmed: 0, barangays: 1 }, error: null };
      }
      if (name === 'analytics_series') {
        return o.series || {
          data: [
            { bucket: '2026-10-16T00:00:00+08:00', scans: 3, affected: 2 },
            { bucket: '2026-10-17T00:00:00+08:00', scans: 5, affected: 3 },
            { bucket: '2026-10-18T00:00:00+08:00', scans: 2, affected: 1 },
          ],
          error: null,
        };
      }
      if (name === 'analytics_diseases') return { data: DISEASES, error: null };
      if (name === 'analytics_crops') return { data: [{ crop_code: 'tomato', crop_name: 'Tomato', scans: 10 }], error: null };
      return { data: null, error: null };
    },
  });
}

test('farmer dashboard boots and renders real-shaped data without throwing', async () => {
  const dom = loadPage('index.html', farmerClient());
  const { window } = dom;
  await wait(1100); // let the count-up animation settle

  assert.deepEqual(window.__errors, [], `uncaught errors: ${window.__errors.join(' | ')}`);

  const doc = window.document;
  assert.equal(doc.documentElement.style.visibility, 'visible', 'page must be revealed after boot');
  assert.equal(doc.getElementById('acct-name').textContent, 'Maria Santos');
  assert.equal(doc.getElementById('acct-barangay').textContent, 'Callos');

  // Counts come from the stubbed summary, not from fabricated defaults.
  assert.equal(doc.getElementById('stat-month').textContent, '10');
  assert.equal(doc.getElementById('stat-flagged').textContent, '6');

  // Real data present, so the sample badge must stay hidden.
  assert.equal(doc.getElementById('sample-badge').hidden, true);

  assert.match(doc.getElementById('recent-list').textContent, /Early Blight/);
  assert.ok((window.__charts || []).some((c) => c.id === 'chart-activity'), 'activity chart must be built');

  dom.window.close();
});

test('diseases fall back to the cached copy when the network is gone', async () => {
  const seeded = [{
    id: 'd1', crop_code: 'tomato', code: 'tomato_early_blight', name: 'Cached Only',
    is_healthy: false, severity: 'high', symptoms: null, treatment: null,
    prevention: 'Cached prevention', safety: null, source: null,
  }];

  const dom = loadPage(
    'index.html',
    farmerClient({ diseases: { data: null, error: { message: 'Failed to fetch' } } }),
    { storage: { agri_diseases: seeded } },
  );
  const { window } = dom;
  await wait(400);

  // Store is a top-level const, not a window property, so reach it via eval.
  const rows = await window.eval('Store.diseases()');
  assert.equal(rows.length, 1, 'must fall back to the cached rows');
  assert.equal(rows[0].name, 'Cached Only');
  assert.equal(rows[0].prevention, 'Cached prevention');

  dom.window.close();
});

test('staff are never asked to accept the farmer terms', async () => {
  const dom = loadPage('dashboard.html', staffClient('admin', { noTerms: true }));
  const { window } = dom;
  await wait(900);

  const doc = window.document;
  assert.equal(doc.getElementById('terms-modal'), null, 'no terms gate for staff');
  assert.notEqual(doc.getElementById('page-title').textContent, '', 'the dashboard must boot');

  dom.window.close();
});

test('an account that has not accepted the terms is blocked until it does', async () => {
  const dom = loadPage('index.html', farmerClient({ noTerms: true }));
  const { window } = dom;
  await wait(700);

  const doc = window.document;
  const modal = doc.getElementById('terms-modal');
  assert.ok(modal, 'the terms must be presented before the app is usable');
  assert.match(modal.textContent, /guess, not a diagnosis/i);
  assert.match(modal.textContent, /consult an expert/i);
  assert.match(modal.textContent, /does not replace an expert/i);

  // Nothing behind the modal may have loaded.
  assert.equal(doc.getElementById('stat-month').textContent, '0', 'the dashboard must not boot');

  dom.window.close();
});

test('the theme starts light and only goes dark when the user asks', async () => {
  const dom = loadPage('index.html', farmerClient());
  const { window } = dom;
  await wait(400);

  const doc = window.document;
  assert.equal(doc.documentElement.dataset.theme, 'light', 'light must be the default');

  const btn = doc.querySelector('[data-theme-toggle]');
  assert.ok(btn, 'a toggle must exist');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(60);

  assert.equal(doc.documentElement.dataset.theme, 'dark');
  assert.equal(window.localStorage.getItem('agri_theme'), 'dark', 'the choice must persist');

  dom.window.close();
});

test('weather card renders current, daily range and the next hours', async () => {
  const dom = loadPage('index.html', farmerClient());
  const { window } = dom;
  await wait(700);

  const body = window.document.getElementById('weather-body');

  assert.match(body.textContent, /31°/, 'current temperature');
  assert.match(body.textContent, /34°/, 'feels-like temperature');
  assert.match(body.textContent, /33°/, 'daily high');
  assert.match(body.textContent, /24°/, 'daily low');
  assert.match(body.textContent, /74%/, 'humidity');

  // Geolocation is denied in the harness, so the barangay fallback must be
  // labelled as an approximation rather than presented as exact.
  assert.match(body.textContent, /near your barangay/);
  assert.equal(window.document.querySelectorAll('.weather__hour').length, 6);

  dom.window.close();
});

test('a genuinely empty database shows an honest empty state when sample data is off', async () => {
  const dom = loadPage('index.html', farmerClient({
    scans: { data: [], error: null, count: 0 },
    summary: { data: { scans: 0, farmers: 0, affected: 0, confirmed: 0, barangays: 0 }, error: null },
    series: { data: [], error: null },
  }), { demo: false });

  const { window } = dom;
  await wait(700);

  assert.deepEqual(window.__errors, []);

  const doc = window.document;
  assert.equal(doc.getElementById('stat-month').textContent, '0');
  assert.equal(doc.getElementById('chart-empty').hidden, false, 'empty state must be visible');
  assert.match(doc.getElementById('recent-list').textContent, /No scans yet/);
  assert.equal(doc.getElementById('sample-badge').hidden, true);

  dom.window.close();
});

test('an empty database with sample data on is clearly badged', async () => {
  const dom = loadPage('index.html', farmerClient({
    scans: { data: [], error: null, count: 0 },
    summary: { data: { scans: 0, farmers: 0, affected: 0, confirmed: 0, barangays: 0 }, error: null },
    series: { data: [], error: null },
  }));

  const { window } = dom;
  await wait(700);

  assert.deepEqual(window.__errors, []);

  const doc = window.document;
  assert.equal(doc.getElementById('sample-badge').hidden, false, 'sample data must be labelled');
  assert.ok((window.__charts || []).some((c) => c.id === 'chart-activity'), 'sample chart must render');
  assert.equal(doc.getElementById('chart-empty').hidden, true);

  dom.window.close();
});

test('switching tabs activates the right section and rebuilds the scan view', async () => {
  const dom = loadPage('index.html', farmerClient({
    scans: { data: [], error: null, count: 0 },
    summary: { data: { scans: 0, farmers: 0, affected: 0, confirmed: 0, barangays: 0 }, error: null },
    series: { data: [], error: null },
  }));

  const { window } = dom;
  await wait(500);

  const doc = window.document;
  doc.querySelector('.tabbar__item[data-view="scan"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(80);

  assert.ok(doc.querySelector('#view-scan').classList.contains('is-active'));
  assert.equal(doc.getElementById('view-title').textContent, 'Scan');

  // A gateway is configured, so the panel must say so — and must not repeat the
  // old "no model is connected / sample data" line, which would be false.
  const status = doc.getElementById('ai-status').textContent;
  assert.match(status, /Configured/, `gateway must read Configured: ${status}`);
  assert.doesNotMatch(status, /No model is connected/i, `stale sample notice: ${status}`);
  assert.doesNotMatch(status, /Offline shape gate/i, `offline row must be hidden when online: ${status}`);

  // The crop is preselected, so capture is available without answering anything.
  assert.equal(doc.getElementById('btn-upload').disabled, false);
  assert.equal(doc.getElementById('btn-camera').disabled, false);

  // Switching crop keeps capture available and marks the choice.
  doc.querySelector('.crop-option[data-crop="palay"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(40);
  assert.equal(doc.querySelector('.crop-option[data-crop="palay"]').getAttribute('aria-checked'), 'true');
  assert.equal(doc.getElementById('btn-upload').disabled, false);

  dom.window.close();
});

test('model status lists the offline fallback and reports "Not set" when no gateway exists', async () => {
  const dom = loadPage('index.html', farmerClient(), { gateway: '' });
  const { window } = dom;
  await wait(500);

  const doc = window.document;
  doc.querySelector('.tabbar__item[data-view="scan"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(80);

  const status = doc.getElementById('ai-status').textContent;
  assert.match(status, /Offline shape gate/, 'offline fallback must be listed when there is no gateway');
  assert.match(status, /Not set/, 'unconfigured models must be reported honestly');

  dom.window.close();
});

test('the language toggle switches the farmer UI to Filipino and back', async () => {
  const dom = loadPage('index.html', farmerClient());
  const { window } = dom;
  await wait(600);

  const doc = window.document;
  assert.equal(doc.getElementById('view-title').textContent, 'Dashboard');
  // The language button is now a globe icon; label text is not rendered.

  doc.getElementById('lang-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(150);

  assert.equal(doc.documentElement.lang, 'fil');
  assert.equal(doc.querySelector('.tabbar__item[data-view="scan"] span').textContent, 'Mag-scan ng Pananim');
  assert.equal(doc.getElementById('stat-flagged').previousElementSibling.textContent, 'May sakit');

  doc.getElementById('lang-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(150);

  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(doc.querySelector('.tabbar__item[data-view="scan"] span').textContent, 'Scan Crops');

  dom.window.close();
});

/* ==========================================================================
 * Staff console
 * ======================================================================== */

function staffClient(role, overrides) {
  const o = overrides || {};
  const profile = { ...PROFILE, role, full_name: role === 'admin' ? 'Admin Cruz' : 'Officer Reyes', barangay_id: null };

  const staffProfile = o.noTerms ? { ...profile, terms_accepted_at: null } : profile;

  return makeClient({
    table(table) {
      if (table === 'profiles') {
        return {
          data: [staffProfile, { ...PROFILE, id: 'u2', role: 'farmer' }],
          error: null,
          count: 2,
          single: { data: staffProfile, error: null },
        };
      }
      if (table === 'scan_feedback') return o.feedback || { data: [], error: null };
      if (table === 'barangays') return { data: BARANGAYS, error: null };
      if (table === 'jurisdictions') return { data: [{ id: 'j1', name: 'Peñaranda', province: 'Nueva Ecija' }], error: null };
      if (table === 'scans') return { data: [SCAN], error: null, count: 1 };
      if (table === 'audit_events') return { data: [], error: null };
      return { data: [], error: null, count: 0 };
    },
    rpc(name) {
      if (name === 'analytics_summary') return { data: { scans: 42, farmers: 9, affected: 25, confirmed: 3, barangays: 4 }, error: null };
      if (name === 'analytics_series') return { data: [{ bucket: '2026-10-17T00:00:00+08:00', scans: 4, affected: 2 }], error: null };
      if (name === 'analytics_diseases') return { data: DISEASES, error: null };
      if (name === 'analytics_crops') return { data: [{ crop_code: 'tomato', crop_name: 'Tomato', scans: 42 }], error: null };
      if (name === 'analytics_barangays') return { data: [{ barangay_id: 'b1', barangay: 'Callos', scans: 20, affected: 14, farmers: 5 }], error: null };
      if (name === 'analytics_barangay_disease') return { data: [{ barangay: 'Callos', disease: 'Early Blight', scans: 14 }], error: null };
      if (name === 'analytics_farmers') return { data: [{ user_id: 'u2', scans: 5, affected: 3, last_scan: '2026-10-17T03:00:00.000Z' }], error: null };
      return { data: null, error: null };
    },
  });
}

test('admin console renders KPIs and exposes administration sections', async () => {
  const dom = loadPage('dashboard.html', staffClient('admin'));
  const { window } = dom;
  await wait(1100);

  assert.deepEqual(window.__errors, [], `uncaught errors: ${window.__errors.join(' | ')}`);

  const doc = window.document;
  assert.equal(doc.getElementById('kpi-scans').textContent, '42');
  assert.equal(doc.getElementById('kpi-farmers').textContent, '9');
  assert.equal(doc.getElementById('kpi-rate').textContent, '60%');
  assert.match(doc.getElementById('kpi-top').textContent, /Early Blight/);
  assert.equal(doc.getElementById('rail-role').textContent, 'Administrator');
  assert.equal(doc.getElementById('rail-admin-nav').hidden, false, 'admin must see the admin nav');
  assert.equal(doc.getElementById('scope-text').textContent, 'All jurisdictions');

  dom.window.close();
});

test('only an admin gets a delete control on scan records', async () => {
  const admin = loadPage('dashboard.html', staffClient('admin'));
  await wait(900);
  admin.window.document.querySelector('[data-view="scans"]')
    .dispatchEvent(new admin.window.MouseEvent('click', { bubbles: true }));
  await wait(600);

  assert.ok(
    admin.window.document.querySelectorAll('#tbl-scans [data-del]').length > 0,
    'admin must be able to delete a record',
  );

  // Gallery cards open the same detail modal, so the control must be in there too.
  admin.window.document.querySelector('#tbl-scans [data-detail]')
    .dispatchEvent(new admin.window.MouseEvent('click', { bubbles: true }));
  await wait(500);
  const foot = admin.window.document.querySelector('.modal__foot');
  assert.ok(foot, 'the detail modal must open');
  assert.match(foot.textContent, /Delete record/, 'the modal must offer delete for an admin');

  admin.window.close();

  const da = loadPage('dashboard.html', staffClient('da'));
  await wait(900);
  da.window.document.querySelector('[data-view="scans"]')
    .dispatchEvent(new da.window.MouseEvent('click', { bubbles: true }));
  await wait(600);

  assert.equal(
    da.window.document.querySelectorAll('#tbl-scans [data-del]').length,
    0,
    'a DA officer must not see a delete control',
  );

  da.window.document.querySelector('#tbl-scans [data-detail]')
    .dispatchEvent(new da.window.MouseEvent('click', { bubbles: true }));
  await wait(500);
  const daFoot = da.window.document.querySelector('.modal__foot');
  assert.ok(!daFoot || !/Delete record/.test(daFoot.textContent), 'no delete for a DA officer');

  da.window.close();
});

test('a staff session can be locked and only released by signing in again', async () => {
  const dom = loadPage('dashboard.html', staffClient('admin'));
  await wait(900);

  const doc = dom.window.document;
  assert.equal(doc.getElementById('idle-lock'), null, 'no lock until the limit passes');

  dom.window.eval('Idle.lock()');
  await wait(50);

  const lock = doc.getElementById('idle-lock');
  assert.ok(lock, 'locking must create the overlay');
  assert.ok(lock.classList.contains('is-open'));
  assert.match(lock.textContent, /Five minutes of inactivity/);
  assert.match(lock.textContent, /log in again/i);
  assert.equal(doc.body.style.overflow, 'hidden', 'the page behind must not scroll');

  dom.window.close();
});

test('a DA officer gets the mail queue and can reach training data', async () => {
  const feedback = {
    data: [
      {
        scan_id: 's1',
        verdict: 'wrong',
        corrected_code: null,
        note: 'yellow edges after the rain',
        status: 'pending',
        created_at: '2026-10-21T03:00:00.000Z',
        scans: {
          id: 's1', crop_code: 'tomato', top_label: 'tomato_early_blight',
          top_confidence: 0.93, image_path: 'u1/x.jpg',
          created_at: '2026-10-21T03:00:00.000Z',
          user_id: 'u2', barangay_id: 'b1', jurisdiction_id: 'j1', lat: null, lng: null,
        },
      },
    ],
    error: null,
  };

  const dom = loadPage('dashboard.html', staffClient('da', { feedback }));
  const { window } = dom;
  await wait(900);

  const doc = window.document;

  // The review nav is for both roles; the administration nav is not.
  assert.equal(doc.getElementById('rail-admin-nav').hidden, true);
  assert.equal(doc.getElementById('rail-review-nav').hidden, false);

  doc.querySelector('[data-view="mail"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(600);

  const body = doc.querySelector('#tbl-mail tbody').textContent;
  assert.match(body, /Other:/, `free-text correction must be labelled: ${body}`);
  assert.match(body, /yellow edges after the rain/);
  assert.match(body, /Approve/);
  assert.match(body, /Reject/);
  assert.doesNotMatch(body, /Delete photo/, 'rejected photos are kept, not deleted');
  assert.match(doc.getElementById('mail-summary').textContent, /1 submission/);

  // Training data is no longer admin-only.
  doc.querySelector('[data-view="training"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(400);
  assert.ok(doc.querySelector('[data-view="training"]').classList.contains('is-active'));

  dom.window.close();
});

test('admin sees farmer verdicts and the error rate in the training view', async () => {
  const feedback = {
    data: [
      {
        scan_id: 's1',
        verdict: 'wrong',
        corrected_code: 'tomato_late_blight',
        note: null,
        status: 'approved',
        created_at: '2026-10-21T03:00:00.000Z',
        scans: {
          id: 's1', crop_code: 'tomato', top_label: 'tomato_early_blight',
          image_path: 'u1/x.jpg', created_at: '2026-10-21T03:00:00.000Z',
          user_id: 'u2', barangay_id: 'b1',
        },
      },
      {
        scan_id: 's2',
        verdict: 'correct',
        corrected_code: null,
        note: null,
        status: 'approved',
        created_at: '2026-10-21T02:00:00.000Z',
        scans: {
          id: 's2', crop_code: 'palay', top_label: 'palay_blast',
          image_path: 'u1/y.jpg', created_at: '2026-10-21T02:00:00.000Z',
          user_id: 'u2', barangay_id: 'b1',
        },
      },
      {
        scan_id: 's3',
        verdict: 'wrong',
        corrected_code: null,
        note: 'this is a carabao, not a leaf',
        status: 'rejected',
        reject_class: 'not_leaf',
        created_at: '2026-10-21T01:00:00.000Z',
        scans: {
          id: 's3', crop_code: 'tomato', top_label: 'tomato_healthy',
          image_path: 'u1/z.jpg', created_at: '2026-10-21T01:00:00.000Z',
          user_id: 'u2', barangay_id: 'b1',
        },
      },
    ],
    error: null,
  };

  const dom = loadPage('dashboard.html', staffClient('admin', { feedback }));
  const { window } = dom;
  await wait(900);

  const doc = window.document;
  doc.querySelector('[data-view="training"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(600);

  const summary = doc.getElementById('train-summary').textContent;
  assert.match(summary, /3 decided/, `summary must count decided rows: ${summary}`);
  assert.match(summary, /2 approved/, `summary must count approvals: ${summary}`);
  assert.match(summary, /1 rejected as negative examples/, `rejections must be counted: ${summary}`);

  const body = doc.querySelector('#tbl-training tbody').textContent;
  assert.match(body, /Corrected/, 'a corrected verdict must be labelled');
  assert.match(body, /Late Blight/, 'codes must be shown as disease names');
  assert.match(body, /Confirmed/);
  assert.match(body, /Rejected/, 'a rejected photo must appear as a negative example');
  assert.match(body, /Not Leaf/, 'its negative class must be visible');

  dom.window.close();
});

test('accounts screen reports the live caps, not stale hardcoded ones', async () => {
  const dom = loadPage('dashboard.html', staffClient('admin'));
  const { window } = dom;
  await wait(1100);

  const doc = window.document;
  doc.querySelector('[data-view="accounts"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(700);

  const text = doc.getElementById('cap-text').textContent;
  assert.match(text, /of 50 farmer accounts used/, `farmer cap missing: ${text}`);
  assert.match(text, /of 15 admin accounts used/, `admin cap missing: ${text}`);
  assert.match(text, /of 15 DA Officer accounts used/, `DA cap missing: ${text}`);

  dom.window.close();
});

test('DA officer console hides administration and reports jurisdiction scope', async () => {  const dom = loadPage('dashboard.html', staffClient('da'));
  const { window } = dom;
  await wait(700);

  assert.deepEqual(window.__errors, [], `uncaught errors: ${window.__errors.join(' | ')}`);

  const doc = window.document;
  assert.equal(doc.getElementById('rail-role').textContent, 'DA Officer');
  assert.equal(doc.getElementById('rail-admin-nav').hidden, true, 'DA officer must not see admin nav');
  assert.equal(doc.getElementById('scope-text').textContent, 'Peñaranda');

  dom.window.close();
});

test('DA officer is blocked from switching to an admin-only view', async () => {
  const dom = loadPage('dashboard.html', staffClient('da'));
  const { window } = dom;
  await wait(600);

  const doc = window.document;
  const hiddenBtn = doc.querySelector('.rail__link[data-view="accounts"]');
  hiddenBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(60);

  assert.ok(doc.querySelector('section[data-view="overview"]').classList.contains('is-active'));
  assert.ok(!doc.querySelector('section[data-view="accounts"]').classList.contains('is-active'));

  dom.window.close();
});

/* ==========================================================================
 * Auth page
 * ======================================================================== */

function authClient(overrides) {
  const base = makeClient({
    session: null,
    table(table) {
      if (table === 'barangays') return { data: BARANGAYS, error: null };
      return { data: [], error: null };
    },
  });

  return Object.assign(base, overrides || {});
}

test('auth page loads barangays and switches between farmer and staff sign-up', async () => {
  const dom = loadPage('auth.html', authClient());
  const { window } = dom;
  await wait(400);

  assert.deepEqual(window.__errors, [], `uncaught errors: ${window.__errors.join(' | ')}`);

  const doc = window.document;
  const options = [...doc.querySelectorAll('#input-brgy option')].map((o) => o.textContent);
  assert.ok(options.includes('Callos'), `barangays must be loaded, got: ${options.join(', ')}`);

  // Developer mode is off: no role tabs, no access-code field.
  assert.equal(doc.getElementById('switcher-role').classList.contains('hidden'), true);
  assert.equal(doc.getElementById('group-code').classList.contains('hidden'), true);

  doc.getElementById('tab-register').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(40);
  assert.equal(doc.getElementById('group-brgy').classList.contains('hidden'), false);

  // The developer button reveals the staff form.
  doc.getElementById('dev-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(40);

  assert.equal(doc.getElementById('dev-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.getElementById('switcher-role').classList.contains('hidden'), false);
  assert.equal(doc.getElementById('group-code').classList.contains('hidden'), false);
  assert.equal(doc.getElementById('group-brgy').classList.contains('hidden'), true);
  assert.equal(doc.getElementById('input-code').required, true);
  // The key is per role, so the label must name the selected one.
  assert.match(doc.getElementById('label-code').textContent, /Admin Officer/);

  doc.getElementById('tab-da').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(40);
  assert.equal(doc.getElementById('tab-da').classList.contains('active'), true);
  assert.match(doc.getElementById('label-code').textContent, /DA Officer/);

  // Turning it off returns to the plain farmer login.
  doc.getElementById('dev-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(40);
  assert.equal(doc.getElementById('dev-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(doc.getElementById('switcher-role').classList.contains('hidden'), true);
  assert.equal(doc.getElementById('tab-login').classList.contains('active'), true);

  dom.window.close();
});

test('developer mode is a switch on both dashboards and forces sample data', async () => {
  for (const page of ['index.html', 'dashboard.html']) {
    const dom = loadPage(page, page === 'index.html' ? farmerClient() : staffClient('admin'));
    const { window } = dom;
    await wait(600);

    const doc = window.document;
    const btn = doc.querySelector('[data-demo-toggle]');
    assert.ok(btn, `${page} must offer a developer mode button`);
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.equal(window.eval('Demo.forced()'), false);

    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(60);

    assert.equal(window.localStorage.getItem('agri_demo'), 'on', `${page}: the choice must persist`);
    assert.equal(window.eval('Demo.forced()'), true, `${page}: sample data must be forced on`);

    dom.window.close();
  }
});

test('developer mode shows every disease class, not a subset', async () => {
  const dom = loadPage('index.html', farmerClient());
  await wait(400);

  // The sample set has to cover all 14 classes the models can return.
  const codes = dom.window.eval(
    "Demo.diseases(Core.rangeFor('month', new Date(), 'Asia/Manila')).map(d => d.code)",
  );
  assert.equal(codes.length, 14, `expected 14 classes, got ${codes.length}`);

  dom.window.close();
});

test('the terms card makes the page behind it unreachable', async () => {
  const dom = loadPage('auth.html', authClient());
  const { window } = dom;
  await wait(400);

  const doc = window.document;
  window.eval("Terms.show({ blocking: false })");
  await wait(80);

  const modal = doc.getElementById('terms-modal');
  assert.ok(modal, 'the card must open');

  // Language, theme and developer controls sit above the overlay in auth.css
  // (z-index 900), so z-index alone leaves them clickable. inert is the fix.
  const behind = [...doc.body.children].filter((n) => n !== modal);
  assert.ok(behind.length > 0, 'there must be page content to block');
  assert.ok(behind.every((n) => n.inert === true), 'everything behind must be inert');

  modal.querySelector('[data-terms-accept]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(300);

  assert.ok(behind.every((n) => n.inert === false), 'closing must release the page');

  dom.window.close();
});

test('the terms row only appears when registering', async () => {
  const dom = loadPage('auth.html', authClient());
  const { window } = dom;
  await wait(400);

  const doc = window.document;
  const group = doc.getElementById('group-terms');

  // It must reuse .field-group, because that is the class auth.css actually
  // hides. A bare .hidden does nothing there — which is how the consent row
  // ended up showing on the login tab.
  assert.ok(group.classList.contains('field-group'), 'must use the field-group hidden rule');
  assert.ok(group.classList.contains('hidden'), 'hidden on the login tab');

  doc.getElementById('tab-register').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(80);

  assert.ok(!group.classList.contains('hidden'), 'visible when registering');

  dom.window.close();
});

test('staff registration validates the access code then sends role and code', async () => {
  const client = authClient();
  const seen = { rpc: null, signUp: null };

  client.rpc = (name, params) => {
    seen.rpc = { name, params };
    return builder({ data: { valid: true, role: params.p_role, source: 'key' }, error: null });
  };
  client.auth.signUp = async (payload) => {
    seen.signUp = payload;
    return { data: { session: null }, error: null };
  };

  const dom = loadPage('auth.html', client);
  const { window } = dom;
  await wait(400);

  const doc = window.document;
  doc.getElementById('dev-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(40);
  doc.getElementById('tab-da').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(40);

  doc.getElementById('input-name').value = 'Officer Reyes';
  doc.getElementById('input-terms').checked = true;
  doc.getElementById('input-code').value = 'AGRI-OFFICER-2026';
  doc.getElementById('input-email').value = 'officer@agrisuri.ph';
  doc.getElementById('input-password').value = 'Secret123!';
  doc.getElementById('input-confirm').value = 'Secret123!';

  doc.getElementById('auth-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(300);

  assert.ok(seen.rpc, 'the access code must be checked server-side first');
  assert.equal(seen.rpc.name, 'check_access_code');
  assert.equal(seen.rpc.params.p_role, 'da');

  assert.ok(seen.signUp, 'sign-up must run after a valid code');
  assert.equal(seen.signUp.options.data.access_code, 'AGRI-OFFICER-2026');
  assert.equal(seen.signUp.options.data.role, 'da');
  assert.equal(seen.signUp.options.data.barangay_id, undefined, 'staff must not carry a barangay');

  dom.window.close();
});

test('a rejected access code stops the registration before an account is created', async () => {
  const client = authClient();
  let signedUp = false;

  client.rpc = () => builder({ data: { valid: false }, error: null });
  client.auth.signUp = async () => { signedUp = true; return { data: { session: null }, error: null }; };

  const dom = loadPage('auth.html', client);
  const { window } = dom;
  await wait(400);

  const doc = window.document;
  doc.getElementById('dev-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(40);

  doc.getElementById('input-name').value = 'Someone';
  doc.getElementById('input-terms').checked = true;
  doc.getElementById('input-code').value = 'WRONG-CODE';
  doc.getElementById('input-email').value = 'x@y.ph';
  doc.getElementById('input-password').value = 'Secret123!';
  doc.getElementById('input-confirm').value = 'Secret123!';

  doc.getElementById('auth-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(250);

  assert.equal(signedUp, false, 'no account may be created with a bad code');
  assert.match(doc.getElementById('toast-msg').textContent, /access code/i);

  dom.window.close();
});

/* ==========================================================================
 * Landing page
 * ======================================================================== */

test('landing page runs its inline script and grows the plant', async () => {
  const dom = loadPage('landing.html', makeClient({ session: null }));
  const { window } = dom;
  await wait(300);

  assert.deepEqual(window.__errors, [], `uncaught errors: ${window.__errors.join(' | ')}`);

  const doc = window.document;
  const plant = doc.querySelector('.plant');
  assert.ok(plant, 'the plant illustration must exist');
  assert.ok(plant.classList.contains('is-grown'), 'growth sequence must be triggered');

  assert.ok(doc.querySelectorAll('.leaf').length >= 10, 'leaves must be present');
  assert.equal(doc.querySelectorAll('.fruit').length, 3);
  assert.ok(doc.querySelectorAll('.pollen').length >= 4);
  assert.ok(doc.querySelector('.nav > .nav__inner'), 'nav needs an inner container');

  dom.window.close();
});

test('the landing page language toggle translates the copy', async () => {
  const dom = loadPage('landing.html', makeClient({ session: null }));
  const { window } = dom;
  await wait(250);

  assert.deepEqual(window.__errors, [], `uncaught errors: ${window.__errors.join(' | ')}`);

  const doc = window.document;
  const title = doc.querySelector('h1 span[data-i18n="land.hero.title1"]');
  assert.equal(title.textContent, 'Find the disease');
  assert.equal(doc.getElementById('lang-label').textContent, 'FIL');

  doc.getElementById('lang-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(100);

  assert.equal(doc.getElementById('lang-label').textContent, 'EN');
  assert.equal(doc.documentElement.lang, 'fil');
  assert.equal(title.textContent, 'Hanapin ang sakit');
  assert.match(doc.querySelector('.nav__links a').textContent, /Paano gumagana/);

  dom.window.close();
});

test('every auth mode shows all of its fields at once, with no scroll container', async () => {
  const dom = loadPage('auth.html', authClient());
  const { window } = dom;
  await wait(400);

  const doc = window.document;
  const visible = () => [...doc.querySelectorAll('#auth-form .field-group')]
    .filter((g) => !g.classList.contains('hidden')).length;

  // No inner scroll box anywhere in the card.
  assert.equal(doc.querySelector('.form-fields-scroll'), null, 'the scroll container must not exist');
  const fields = doc.querySelector('.form-fields');
  assert.ok(fields, '.form-fields must exist');
  const maxHeight = window.getComputedStyle(fields).maxHeight;
  assert.ok(maxHeight === 'none' || maxHeight === '', `fields must not be height-capped, got "${maxHeight}"`);

  // Log in: email + password
  assert.equal(visible(), 2);

  // Register as farmer: name, barangay, email, password, confirm, terms
  doc.getElementById('tab-register').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(40);
  assert.equal(visible(), 6);

  // Developer mode: name, access code, email, password, confirm — no terms,
  // they are a farmer-only consent.
  doc.getElementById('dev-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(40);
  assert.equal(visible(), 5);

  dom.window.close();
});
