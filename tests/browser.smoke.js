'use strict';

/**
 * Browser smoke test.
 *
 * Loads each page in headless Chrome and fails on any uncaught exception,
 * console error, or 404 for a local asset. It does not require a Supabase
 * session: the goal is to prove the pages boot, the scripts wire up, and
 * unauthenticated routes redirect instead of rendering a broken shell.
 *
 * Run:
 *   node tests/browser.smoke.js
 *
 * Requires puppeteer-core and a local Chrome/Edge. Set CHROME_PATH to override
 * the executable, or skip this file if neither is available.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(ROOT, url === '/' ? 'landing.html' : url);

    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async function main() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (e) {
    console.log('SKIP: puppeteer-core is not installed.');
    process.exit(0);
  }

  const executablePath = CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) {
    console.log('SKIP: no Chrome or Edge executable found.');
    process.exit(0);
  }

  const { server, port } = await serve();
  const base = `http://127.0.0.1:${port}`;

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      timeout: 30000,
    });
  } catch (err) {
    server.close();
    console.log(`SKIP: the browser could not start (${err.message.split('\n')[0]}).`);
    console.log('      Run this on a machine where Chrome can launch.');
    process.exit(0);
  }

  const results = [];

  async function visit(file, opts) {
    const page = await browser.newPage();
    await page.setViewport(opts && opts.mobile ? { width: 390, height: 844, deviceScaleFactor: 2 } : { width: 1440, height: 900 });

    const errors = [];
    const warnings = [];

    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      const t = msg.text();
      if (msg.type() === 'error') {
        // Third-party CDN noise is reported but not fatal on its own.
        errors.push(`console: ${t}`);
      } else if (msg.type() === 'warning') {
        warnings.push(t);
      }
    });
    page.on('requestfailed', (req) => {
      const url = req.url();
      if (url.startsWith(base)) errors.push(`local request failed: ${url.replace(base, '')}`);
    });

    let status = 0;
    page.on('response', (res) => {
      if (res.url().startsWith(base) && res.status() >= 400) {
        errors.push(`http ${res.status()}: ${res.url().replace(base, '')}`);
      }
      if (res.url() === base + '/' + file) status = res.status();
    });

    await page.goto(`${base}/${file}`, { waitUntil: 'networkidle2', timeout: 45000 }).catch((e) => {
      errors.push(`navigation: ${e.message}`);
    });

    await new Promise((r) => setTimeout(r, 900));

    const finalUrl = page.url().replace(base, '');
    const title = await page.title();

    if (opts && opts.shot) {
      const dir = path.join(ROOT, 'tests', '__screens__');
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, `${opts.shot}.png`), fullPage: false });
    }

    results.push({ file, status, finalUrl, title, errors, warnings });
    await page.close();
  }

  await visit('landing.html', { shot: 'landing-desktop' });
  await visit('landing.html', { shot: 'landing-mobile', mobile: true });
  await visit('auth.html', { shot: 'auth' });
  await visit('index.html', { shot: 'index-guard' });
  await visit('dashboard.html');

  await browser.close();
  server.close();

  let failed = false;
  for (const r of results) {
    const bad = r.errors.filter((e) => !/net::ERR|Failed to load resource: net::ERR/.test(e));
    const ok = bad.length === 0;
    if (!ok) failed = true;

    console.log(`\n${ok ? 'PASS' : 'FAIL'} ${r.file} -> ${r.finalUrl}  [${r.title}]`);
    for (const e of bad) console.log(`   ${e}`);
    if (r.warnings.length) {
      console.log(`   (${r.warnings.length} warnings, first: ${r.warnings[0].slice(0, 110)})`);
    }
  }

  console.log(failed ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
  process.exit(failed ? 1 : 0);
})();
