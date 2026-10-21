#!/usr/bin/env node
/**
 * Zero-dependency static server + local inference proxy.
 *
 *   npm run serve            → http://localhost:5173        (this machine only)
 *   npm run serve:lan        → http://<lan-ip>:5173         (phone on same Wi-Fi)
 *   node tools/serve.js 8080
 *   node tools/serve.js --lan
 *
 * Three deliberate design choices:
 *
 * 1. ALLOW-LIST, not a deny-list. Binding to 0.0.0.0 makes the server reachable
 *    from the whole Wi-Fi network, so a directory-traversal guard alone is not
 *    enough — it would still serve `dataset/`, `sql/`, `supabase/functions/`
 *    (which contains server-only code), and `.workbuddy-ai/`. Only the files
 *    the app actually loads are reachable; everything else is a 404.
 *
 * 2. LOCAL INFERENCE PROXY. The browser must never hold the Roboflow key. In
 *    production the key lives in the Supabase Edge Function; locally this
 *    server plays that role at POST /api/infer, with the same request and
 *    response shape, so `script/ai.js` needs no special case. The key is read
 *    from ROBOFLOW_API_KEY or `tools/roboflow.key` — never from client code.
 *
 * 3. HTTP is fine for phones. The scan screen uses `<input capture="environment">`
 *    on coarse pointers, which opens the native camera app and needs no secure
 *    context. Only desktop uses getUserMedia, and `localhost` is already a
 *    secure context there.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const lanMode = argv.includes('--lan');
const portArg = argv.find((a) => /^\d+$/.test(a));
const PORT = Number(portArg || process.env.PORT || 5173);
const HOST = process.env.HOST || (lanMode ? '0.0.0.0' : '127.0.0.1');

/* ------------------------------------------------------------------ *
 * Static file serving
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Exactly what the app loads. Anything else is a 404. */
const ALLOWED_DIRS = ['/script/', '/style/', '/assets/'];
const ALLOWED_ROOT_FILES = new Set([
  '/index.html',
  '/auth.html',
  '/dashboard.html',
  '/landing.html',
  '/manifest.json',
  '/sw.js',
  '/favicon.ico',
]);

function isAllowed(pathname) {
  if (ALLOWED_ROOT_FILES.has(pathname)) return true;
  if (!ALLOWED_DIRS.some((d) => pathname.startsWith(d))) return false;
  return !pathname.split('/').some((seg) => seg.startsWith('.'));
}

function send(res, status, body, headers) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function json(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';

  // Normalise before the prefix test so `//script/../supabase/x` cannot pass.
  const normalised = path.posix.normalize(pathname);
  if (normalised.includes('\0') || normalised.startsWith('/..')) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  }
  if (!isAllowed(normalised)) {
    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain' });
  }

  const target = path.resolve(ROOT, '.' + normalised);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  }

  fs.readFile(target, (err, data) => {
    if (err) {
      const code = err.code === 'ENOENT' ? 404 : 500;
      return send(res, code, code === 404 ? 'Not Found' : 'Server Error', {
        'Content-Type': 'text/plain',
      });
    }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    send(res, 200, req.method === 'HEAD' ? undefined : data, {
      'Content-Type': type,
      'Content-Length': data.length,
    });
  });
}

/* ------------------------------------------------------------------ *
 * Local inference proxy
 *
 * Mirrors `supabase/functions/infer` so the client contract is identical:
 *   request  { stage: 'shape_gate'|'texture_gate'|'disease', crop?, image }
 *   response { model_id, model_version, predictions: [{label, confidence}],
 *              latency_ms }
 * ------------------------------------------------------------------ */

const ROBOFLOW_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 12 * 1024 * 1024;

/*
 * Each entry is a candidate list, tried in order until one answers.
 *
 * Roboflow binds the trained artifact to the project slug that existed at
 * training time. Renaming the project afterwards leaves the new slug returning
 * 404 while the old one keeps working — which is exactly what happened to the
 * shape model. Listing both means a rename cannot break the pipeline, and a
 * later redeploy under the new name needs no code change.
 */
const MODELS = {
  shape_gate: ['shape-u5iks/1', 'disease_-_texture_tomato_-_palay/1'],
  crop_gate: ['shape-u5iks/1', 'disease_-_texture_tomato_-_palay/1'],
  texture_gate: ['texture-8frhk/1'],
  'disease:tomato': ['tomato_diseases-ksz6z/1'],
  'disease:palay': ['rice_diseases-qcvnv/1'],
};

function loadRoboflowKey() {
  if (process.env.ROBOFLOW_API_KEY) return process.env.ROBOFLOW_API_KEY.trim();
  try {
    return fs.readFileSync(path.join(__dirname, 'roboflow.key'), 'utf8').trim();
  } catch {
    return '';
  }
}

const ROBOFLOW_KEY = loadRoboflowKey();

function resolveModels(stage, crop) {
  if (stage === 'disease') return MODELS[`disease:${crop}`] || null;
  return MODELS[stage] || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload_too_large'), { code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleInfer(req, res) {
  const started = Date.now();

  if (!ROBOFLOW_KEY) {
    return json(res, 503, {
      error: 'model_not_configured',
      message: 'ROBOFLOW_API_KEY is not set. Put the key in tools/roboflow.key or the environment.',
    });
  }

  // Same contract as the Edge Function: a bearer token must be present. It is
  // not verified here — this server is loopback/LAN only — but it stops a
  // stray device on the network from using the proxy as a free inference API.
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return json(res, 401, { error: 'unauthenticated', message: 'Missing bearer token.' });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err.code === 'too_large') {
      return json(res, 413, { error: 'bad_request', message: 'Image payload is too large.' });
    }
    return json(res, 400, { error: 'bad_request', message: 'Could not read the request body.' });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: 'bad_request', message: 'Body must be JSON.' });
  }

  const stage = payload.stage || '';
  const crop = payload.crop;
  const image = payload.image || '';

  if (!MODELS[stage] && stage !== 'disease') {
    return json(res, 400, {
      error: 'bad_request',
      message: 'stage must be shape_gate, texture_gate, or disease.',
    });
  }
  if (stage === 'disease' && crop !== 'tomato' && crop !== 'palay') {
    return json(res, 400, { error: 'bad_request', message: 'crop must be tomato or palay.' });
  }
  if (typeof image !== 'string' || image.length < 512) {
    return json(res, 400, { error: 'bad_request', message: 'Image payload is missing.' });
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 256))) {
    return json(res, 400, { error: 'bad_request', message: 'Image must be base64.' });
  }

  const models = resolveModels(stage, crop);
  if (!models || !models.length) {
    return json(res, 503, {
      error: 'model_not_configured',
      message: `No model is configured for ${stage}${crop ? '/' + crop : ''}.`,
    });
  }

  let upstream = null;
  let used = models[0];
  for (const model of models) {
    const [project, version] = model.split('/');
    const endpoint =
      `https://classify.roboflow.com/${project}/${version}` +
      `?api_key=${encodeURIComponent(ROBOFLOW_KEY)}&confidence=0&overlap=0`;
    try {
      const res2 = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: image,
        signal: AbortSignal.timeout(ROBOFLOW_TIMEOUT_MS),
      });
      upstream = res2;
      used = model;
      // A 404 means "this slug does not hold the artifact" — try the next one.
      if (res2.status !== 404 && res2.status !== 405) break;
    } catch {
      upstream = null;
    }
  }

  if (!upstream) {
    return json(res, 502, {
      error: 'upstream_unreachable',
      message: 'The inference service did not respond.',
    });
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return json(res, 502, { error: 'upstream_auth', message: 'The Roboflow key was rejected.' });
  }
  if (!upstream.ok) {
    return json(res, 502, {
      error: 'upstream_error',
      message: `Inference service returned ${upstream.status} for ${used}.`,
    });
  }

  let body;
  try {
    body = await upstream.json();
  } catch {
    return json(res, 502, {
      error: 'upstream_bad_payload',
      message: 'Inference service returned unreadable data.',
    });
  }

  const predictions = (body.predictions || [])
    .filter((p) => typeof p.class === 'string' && typeof p.confidence === 'number')
    .map((p) => ({ label: p.class, confidence: p.confidence }))
    .sort((a, b) => b.confidence - a.confidence);

  if (!predictions.length) {
    return json(res, 422, {
      error: 'no_predictions',
      message: 'The model returned no classes for this image.',
    });
  }

  const [usedProject, usedVersion] = used.split('/');

  json(res, 200, {
    model_id: usedProject,
    model_version: usedVersion,
    predictions,
    latency_ms: Date.now() - started,
  });
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(url.parse(req.url).pathname || '/');
  } catch {
    return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain' });
  }

  if (pathname === '/api/infer') {
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'method_not_allowed', message: 'Use POST.' });
    }
    handleInfer(req, res).catch(() => {
      if (!res.headersSent) {
        json(res, 500, { error: 'server_error', message: 'The inference proxy failed.' });
      }
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain' });
  }

  serveStatic(req, res, pathname);
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log(`\n  AgriSuri dev server`);
  console.log(`  local   http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const ip of lanAddresses()) console.log(`  phone   http://${ip}:${PORT}`);
    console.log('\n  Phone must be on the same Wi-Fi. If it cannot connect, allow');
    console.log('  Node through Windows Firewall for private networks.');
  } else {
    console.log('  (this machine only - use `npm run serve:lan` for phone access)');
  }

  console.log(
    ROBOFLOW_KEY
      ? '\n  inference  /api/infer -> Roboflow (key loaded)'
      : '\n  inference  DISABLED - no Roboflow key. Add tools/roboflow.key',
  );
  console.log('\n  Ctrl+C to stop.\n');
});
