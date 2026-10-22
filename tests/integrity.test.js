'use strict';

/**
 * Structural and security checks that a unit test can actually enforce:
 *  - every local asset referenced by an HTML page exists
 *  - no secret ever appears in browser-delivered code
 *  - every element id read by a page script exists in that page's markup
 *  - the SQL carries the policies the security model depends on
 *
 * Run: node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/* ==========================================================================
 * Asset references
 * ======================================================================== */

const PAGES = ['landing.html', 'auth.html', 'index.html', 'dashboard.html'];

test('every local src/href referenced by a page exists on disk', () => {
  const missing = [];

  for (const page of PAGES) {
    const html = read(page);
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);

    for (const ref of refs) {
      if (/^(https?:)?\/\//.test(ref)) continue;
      if (ref.startsWith('#') || ref.startsWith('data:') || ref.startsWith('mailto:')) continue;
      if (!exists(ref)) missing.push(`${page} -> ${ref}`);
    }
  }

  assert.deepEqual(missing, [], `missing local assets:\n${missing.join('\n')}`);
});

test('every script referenced by a page exists on disk', () => {
  const missing = [];

  for (const page of PAGES) {
    const html = read(page);
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    for (const src of scripts) {
      if (/^(https?:)?\/\//.test(src)) continue;
      if (!exists(src)) missing.push(`${page} -> ${src}`);
    }
  }

  assert.deepEqual(missing, []);
});

test('the service worker precache list only names files that exist', () => {
  const sw = read('sw.js');
  const block = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('const VENDOR'));
  const files = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((f) => f.includes('.'));

  const missing = files.filter((f) => !exists(f));
  assert.deepEqual(missing, [], `sw.js precaches missing files: ${missing.join(', ')}`);
});

test('every page carries the tags iOS needs to install as an app', () => {
  for (const page of ['landing.html', 'auth.html', 'index.html', 'dashboard.html']) {
    const html = read(page);

    // iOS ignores manifest `display`; without this meta tag the home-screen
    // shortcut opens inside Safari with its chrome.
    assert.match(
      html,
      /<meta name="apple-mobile-web-app-capable" content="yes">/,
      `${page} is missing apple-mobile-web-app-capable`,
    );
    assert.match(
      html,
      /rel="apple-touch-icon"[^>]*href="assets\/apple-touch-icon\.png"/,
      `${page} is missing the 180x180 apple-touch-icon`,
    );
  }
});

/* ==========================================================================
 * Secret hygiene
 * ======================================================================== */

test('no secret material appears in browser-delivered scripts', () => {
  const clientFiles = fs.readdirSync(path.join(ROOT, 'script'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `script/${f}`)
    .concat(['script/lib/core.js']);

  const forbidden = [
    { name: 'Roboflow api_key query param', re: /api_key\s*=/i },
    { name: 'service_role key', re: /service_role/i },
    { name: 'Stripe-style secret', re: /sk_(live|test)_/ },
    { name: 'hardcoded demo keys', re: /DEMO_KEYS/i },
    { name: 'fake-result switch', re: /DEMO_MODE/i },
    { name: 'JWT-looking literal', re: /eyJhbGciOi/ },
  ];

  // Strip comments first: prose that warns *against* secrets is not a secret.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const hits = [];
  for (const file of clientFiles) {
    const src = stripComments(read(file));
    for (const rule of forbidden) {
      if (rule.re.test(src)) hits.push(`${file}: ${rule.name}`);
    }
  }

  assert.deepEqual(hits, [], `secret material found in client code:\n${hits.join('\n')}`);
});

test('the Roboflow key lives only in the edge function environment', () => {
  const fn = read('supabase/functions/infer/index.ts');
  assert.match(fn, /Deno\.env\.get\('ROBOFLOW_API_KEY'\)/);
  assert.doesNotMatch(read('script/config.js'), /ROBOFLOW_API_KEY/);
});

test('predictions are never generated from random numbers', () => {
  const ai = read('script/ai.js');
  assert.doesNotMatch(ai, /Math\.random\(\)\s*[,)]/, 'ai.js must not synthesise scores');
});

/* ==========================================================================
 * Element ids used by page scripts
 * ======================================================================== */

/** ids created at runtime by the page script itself. */
const RUNTIME_IDS = new Set([
  'modal-overlay', 'dlg-role', 'dlg-jur', 'net-banner', 'toast-host',
]);

function checkIds(page, script, extraRuntime) {
  const html = read(page);
  const js = read(script);

  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));

  const missing = [...used].filter(
    (id) => !htmlIds.has(id) && !RUNTIME_IDS.has(id) && !(extraRuntime && extraRuntime.has(id)),
  );

  assert.deepEqual(missing, [], `${script} reads ids missing from ${page}: ${missing.join(', ')}`);
}

test('farmer.js only touches ids that exist in index.html', () => {
  checkIds('index.html', 'script/farmer.js', new Set(['chart-activity', 'chart-crop', 'chart-disease']));
});

test('staff.js only touches ids that exist in dashboard.html', () => {
  checkIds('dashboard.html', 'script/staff.js', new Set());
});

test('auth.js only touches ids that exist in auth.html', () => {
  checkIds('auth.html', 'script/auth.js', new Set());
});

test('every nav view in a page has a matching section', () => {
  for (const [page, script] of [['index.html', 'script/farmer.js'], ['dashboard.html', 'script/staff.js']]) {
    const html = read(page);
    const navViews = new Set([...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]));
    const sections = new Set([...html.matchAll(/<section[^>]+data-view="([^"]+)"/g)].map((m) => m[1]));

    for (const v of sections) {
      assert.ok(navViews.has(v), `${page}: section "${v}" has no navigation entry`);
    }
    for (const v of navViews) {
      assert.ok(sections.has(v), `${page}: nav entry "${v}" has no section`);
    }
  }
});

/* ==========================================================================
 * Database security model
 * ======================================================================== */

const SQL = read('sql/schema.sql');

test('RLS is enabled on every table that holds user data', () => {
  for (const table of ['profiles', 'scans', 'scan_predictions', 'audit_events', 'staff_invites', 'training_candidates']) {
    assert.match(
      SQL,
      new RegExp(`alter table public\\.${table}\\s+enable row level security`, 'i'),
      `${table} must have RLS enabled`,
    );
  }
});

test('DA officer read access is scoped to their jurisdiction, not global', () => {
  const scansPolicy = SQL.slice(SQL.indexOf('create policy scans_select'), SQL.indexOf('create policy scans_delete_own'));
  assert.match(scansPolicy, /my_role\(\) = 'da' and jurisdiction_id = public\.my_jurisdiction\(\)/);
  assert.doesNotMatch(scansPolicy, /my_role\(\) in \('admin', 'da'\)/, 'a blanket staff policy would leak other jurisdictions');
});

test('the storage read policy is scoped for DA officers too', () => {
  const storage = SQL.slice(SQL.indexOf('crop images read'));
  assert.match(storage, /s\.jurisdiction_id = public\.my_jurisdiction\(\)/);
});

test('account caps are enforced under an advisory lock, not a bare count', () => {
  assert.match(SQL, /pg_advisory_xact_lock\(hashtext\('agrisuri\.role_cap'\)\)/);
  assert.match(SQL, /v_count >= 15/);
  assert.match(SQL, /v_count >= 50/);
});

test('a claimed staff role is only accepted when it matches an active access key', () => {
  const fn = SQL.slice(
    SQL.indexOf('create or replace function public.handle_new_user'),
    SQL.indexOf('drop trigger if exists on_signup'),
  );

  // The role may be *claimed* by the client, but it must be validated against a
  // hashed key before it is used. That is the invariant, not "never read it".
  assert.match(fn, /public\.staff_keys/, 'the claimed role must be checked against staff_keys');
  assert.match(fn, /k\.role = v_req_role/, 'the key must belong to the claimed role');
  assert.match(fn, /k\.key_hash = encode\(digest\(v_code, 'sha256'\), 'hex'\)/, 'the key must be compared as a hash');
  assert.match(fn, /v_role := v_req_role/, 'the role comes from the validated claim');

  // The farmer branch must never consult the claimed role.
  const farmerBranch = fn.slice(fn.indexOf('-- Farmer path'));
  assert.doesNotMatch(farmerBranch, /v_req_role/, 'the farmer branch must ignore the claimed role');
});

test('account caps are 50 farmers, 15 admins and 15 DA officers', () => {
  const fn = SQL.slice(
    SQL.indexOf('create or replace function public.enforce_role_cap'),
    SQL.indexOf('drop trigger if exists role_cap'),
  );

  assert.match(fn, /role = 'farmer'[\s\S]{0,200}v_count >= 50/, 'farmer cap must be 50');
  assert.match(fn, /role = 'admin'[\s\S]{0,200}v_count >= 15/, 'admin cap must be 15');
  assert.match(fn, /role = 'da'[\s\S]{0,200}v_count >= 15/, 'DA cap must be 15');
});

test('the caps shown in the UI match the caps enforced in the database', () => {
  const cfg = read('script/config.js');
  const m = cfg.match(/accountCaps:\s*\{\s*farmer:\s*(\d+),\s*admin:\s*(\d+),\s*da:\s*(\d+)\s*\}/);
  assert.ok(m, 'script/config.js must declare APP.accountCaps');

  const fn = SQL.slice(
    SQL.indexOf('create or replace function public.enforce_role_cap'),
    SQL.indexOf('drop trigger if exists role_cap'),
  );

  assert.match(fn, new RegExp(`role = 'farmer'[\\s\\S]{0,200}v_count >= ${m[1]}`), 'farmer cap drifted');
  assert.match(fn, new RegExp(`role = 'admin'[\\s\\S]{0,200}v_count >= ${m[2]}`), 'admin cap drifted');
  assert.match(fn, new RegExp(`role = 'da'[\\s\\S]{0,200}v_count >= ${m[3]}`), 'DA cap drifted');
});

test('sample data is client-side only and never touches the database', () => {
  const demo = read('script/demo.js');
  assert.doesNotMatch(demo, /\bdb\.(from|rpc|storage)\b/, 'demo.js must not call Supabase');
  assert.doesNotMatch(demo, /\bStore\./, 'demo.js must not use the data layer');
  assert.doesNotMatch(demo, /createScan|uploadImage/, 'demo.js must never persist a scan');
});

test('clients cannot write roles, audit rows, or scans directly', () => {
  assert.match(SQL, /revoke update, insert, delete on public\.profiles from authenticated/);
  assert.match(SQL, /grant update \(full_name, consent_training, consent_recorded_at\) on public\.profiles to authenticated/);
  assert.match(SQL, /revoke insert, update, delete on public\.audit_events\s+from authenticated/);
  assert.match(SQL, /revoke insert, update on public\.scans from authenticated/);
});

test('a rejected scan cannot carry a diagnosis', () => {
  assert.match(SQL, /A rejected scan cannot contain a disease prediction/);
});

test('stored coordinates are rounded server-side', () => {
  assert.match(SQL, /round\(p_lat::numeric, 3\)/);
  assert.match(SQL, /round\(p_lng::numeric, 3\)/);
});

test('analytics count scans once, never once per prediction', () => {
  const diseases = SQL.slice(SQL.indexOf('function public.analytics_diseases'), SQL.indexOf('function public.analytics_crops'));
  assert.match(diseases, /from public\.scans sc/);
  assert.doesNotMatch(diseases, /scan_predictions/, 'joining predictions would double-count a scan');
});

test('every analytics aggregate excludes rejected scans, so rates and totals agree', () => {
  const names = [
    'analytics_summary', 'analytics_series', 'analytics_diseases', 'analytics_crops',
    'analytics_barangays', 'analytics_barangay_disease', 'analytics_farmers',
  ];

  for (const name of names) {
    const start = SQL.indexOf(`function public.${name}`);
    assert.ok(start > -1, `${name} must exist`);
    const body = SQL.slice(start, SQL.indexOf('$$;', start));
    assert.match(body, /sc\.status <> 'rejected'/, `${name} must exclude rejected scans`);
  }
});

test('the analytics series is zero-filled so gaps cannot shift the axis', () => {
  assert.match(SQL, /generate_series/);
  assert.match(SQL, /interval '1 second'/, 'the exclusive upper bound must not add a trailing empty bucket');
});

/* ==========================================================================
 * Responsive design guard rails
 * ======================================================================== */

test('every page is zoomable and declares a responsive viewport', () => {
  for (const page of PAGES) {
    const html = read(page);
    const meta = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/i);
    assert.ok(meta, `${page} has no viewport meta`);

    const content = meta[1];
    assert.match(content, /width=device-width/, `${page} must scale to the device width`);
    assert.doesNotMatch(content, /maximum-scale/i, `${page} must not cap pinch zoom`);
    assert.doesNotMatch(content, /user-scalable\s*=\s*no/i, `${page} must allow pinch zoom`);
  }
});

test('every stylesheet ships at least one mobile breakpoint', () => {
  for (const file of fs.readdirSync(path.join(ROOT, 'style')).filter((f) => f.endsWith('.css'))) {
    const css = read(`style/${file}`);
    assert.match(css, /@media[^{]*max-width/, `style/${file} has no max-width breakpoint`);
  }
});

test('layout is defined in CSS, not inline in scripts', () => {
  for (const file of fs.readdirSync(path.join(ROOT, 'script')).filter((f) => f.endsWith('.js'))) {
    const js = read(`script/${file}`);
    assert.doesNotMatch(
      js,
      /style="[^"]*grid-template-columns/,
      `script/${file} hard-codes a grid; it cannot collapse on small screens`,
    );
  }
});

test('the farmer app swaps its sidebar for a bottom tab bar on phones', () => {
  const css = read('style/app.css');
  const html = read('index.html');

  // Extract the body of the first rule for a selector, so the assertion does not
  // depend on whitespace or on regex escaping.
  const ruleBody = (source, selector) => {
    const start = source.indexOf(selector);
    if (start === -1) return '';
    const open = source.indexOf('{', start);
    const close = source.indexOf('}', open);
    if (open === -1 || close === -1) return '';
    return source.slice(open + 1, close);
  };

  assert.match(html, /class="tabbar"/, 'index.html needs a mobile tab bar');
  assert.match(ruleBody(css, '.tabbar'), /display:\s*none/, 'tab bar must be hidden on desktop');

  const mobile = css.slice(css.indexOf('@media (max-width: 900px)'));
  assert.match(ruleBody(mobile, '.tabbar'), /display:\s*grid/, 'tab bar must show at the phone breakpoint');
  assert.match(ruleBody(mobile, '.side'), /display:\s*none/, 'desktop sidebar must hide at the phone breakpoint');
});

test('mobile navigation keeps accessible names instead of display:none', () => {
  const css = read('style/staff.css');

  // Find the rule that targets the hidden labels and inspect what it does.
  const at = css.indexOf('.rail__link span');
  assert.ok(at > -1, 'the mobile rail label rule must exist');

  const window = css.slice(at, at + 260);
  assert.ok(
    !window.includes('display: none'),
    'hiding the label with display:none removes the button accessible name',
  );
  assert.ok(
    window.includes('clip-path: inset(50%)'),
    'labels should be visually hidden, not removed',
  );
});

test('no stylesheet shrink-wraps the page body', () => {
  for (const file of fs.readdirSync(path.join(ROOT, 'style')).filter((f) => f.endsWith('.css'))) {
    const css = read(`style/${file}`);
    assert.ok(
      !css.includes('max-width: fit-content'),
      `style/${file} shrink-wraps a box, which breaks narrow screens`,
    );
  }
});

/* ==========================================================================
 * Translation coverage
 * ======================================================================== */

test('every translation key exists in both languages and every used key exists', () => {
  const src = read('script/i18n.js');
  const enStart = src.indexOf('en: {');
  const filStart = src.indexOf('fil: {');

  assert.ok(enStart > -1 && filStart > enStart, 'both dictionaries must be present');

  const keyRe = /'([a-zA-Z0-9.]+)':/g;
  const enKeys = new Set([...src.slice(enStart, filStart).matchAll(keyRe)].map((m) => m[1]));
  const filKeys = new Set([...src.slice(filStart).matchAll(keyRe)].map((m) => m[1]));

  assert.ok(enKeys.size > 150, `expected a substantial dictionary, got ${enKeys.size}`);

  const onlyEn = [...enKeys].filter((k) => !filKeys.has(k));
  const onlyFil = [...filKeys].filter((k) => !enKeys.has(k));
  assert.deepEqual(onlyEn, [], `keys missing from Filipino: ${onlyEn.join(', ')}`);
  assert.deepEqual(onlyFil, [], `keys missing from English: ${onlyFil.join(', ')}`);

  const used = new Set();
  for (const file of ['script/farmer.js', 'script/auth.js', 'script/demo.js']) {
    for (const m of read(file).matchAll(/\bt\('([a-zA-Z0-9.]+)'/g)) used.add(m[1]);
  }
  for (const page of ['index.html', 'auth.html', 'landing.html']) {
    for (const m of read(page).matchAll(/data-i18n(?:-ph|-aria|-title)?="([a-zA-Z0-9.]+)"/g)) used.add(m[1]);
  }

  const missing = [...used].filter((k) => !enKeys.has(k));
  assert.deepEqual(missing, [], `used but not translated: ${missing.join(', ')}`);
});

/* ==========================================================================
 * Supabase / pgcrypto compatibility
 * ======================================================================== */

test('every function that pins a search_path also includes the extensions schema', () => {
  // Supabase installs pgcrypto into `extensions`. A SECURITY DEFINER function
  // with `set search_path = public` cannot resolve digest() or gen_random_bytes()
  // and fails at CREATE time with 42883.
  const declarations = [...SQL.matchAll(/set search_path = ([a-z_, ]+) as \$\$/g)].map((m) => m[1]);

  assert.ok(declarations.length >= 10, `expected the security-definer functions, found ${declarations.length}`);

  const bad = declarations.filter((d) => !d.includes('extensions'));
  assert.deepEqual(bad, [], `these search_paths omit the extensions schema: ${bad.join(' | ')}`);
});

test('pgcrypto is required explicitly before it is used', () => {
  assert.match(SQL, /create extension if not exists pgcrypto/);
  assert.match(SQL, /from pg_extension where extname = 'pgcrypto'/);
});

/* ==========================================================================
 * Fixed page controls
 * ======================================================================== */

test('the auth page has one bottom developer button and a top-anchored language control', () => {
  const css = read('style/auth.css');

  // A duplicate .dev-toggle rule pinning itself with position:fixed was what
  // made it escape its container and cover the language button.
  const devRules = [...css.matchAll(/\.dev-toggle[ \t]*\{([^}]*)\}/g)].map((m) => m[1]);
  const pinned = devRules.filter((body) => /position:[^;}]*fixed/.test(body));

  assert.equal(pinned.length, 1, 'exactly one .dev-toggle rule may pin itself to the viewport');
  assert.match(pinned[0], /bottom:/, 'the developer button belongs at the bottom');
  assert.doesNotMatch(pinned[0], /top:/, 'anchoring both top and bottom would stretch the button');

  const langRules = [...css.matchAll(/\.lang-toggle[ \t]*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(langRules.length > 0, 'the language control needs a rule');
  assert.ok(
    langRules.every((body) => !/position:[^;}]*fixed/.test(body)),
    'the language button must be laid out by .top-actions, not position itself',
  );

  assert.match(css, /\.top-actions[ \t]*\{[^}]*top:/, 'the language control is anchored top-right');
});

test('every page exposes the language switch near the top', () => {
  for (const page of ['landing.html', 'auth.html', 'index.html']) {
    const html = read(page);
    assert.match(html, /id="lang-btn"/, `${page} needs a language button`);
    assert.match(html, /id="lang-label"/, `${page} needs a language label`);
  }
});

test('the auth form never traps its fields in an inner scroll box', () => {
  const css = read('style/auth.css');

  assert.doesNotMatch(css, /form-fields-scroll/, 'the inner scroll container must be gone');

  const rule = (css.match(/\.form-fields[ \t]*\{([^}]*)\}/) || [])[1] || '';
  assert.ok(rule, '.form-fields must exist');
  assert.doesNotMatch(rule, /max-height|overflow/, 'the fields must size to their content');
});

test('the auth brand sits inside the form card, not in a tall header', () => {
  const html = read('auth.html');
  const card = html.slice(html.indexOf('class="form-card"'), html.indexOf('</div>\n\n        <p class="brand-tag"'));

  assert.match(card, /class="[^"]*auth-brand[^"]*"/, 'the brand row belongs inside the card');
  assert.doesNotMatch(html, /class="branding"/, 'the old tall header block must be gone');
});
