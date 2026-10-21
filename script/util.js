/* ============================================================================
 * Shared UI utilities: DOM, formatting, toasts, modals, chart theming.
 * ========================================================================== */

const $ = (sel, scope) => (scope || document).querySelector(sel);
const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));

/** Escape untrusted text before it goes anywhere near innerHTML. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const nf = new Intl.NumberFormat('en-PH');
const fmtInt = (n) => nf.format(Number(n) || 0);

function fmtPct(v, digits) {
  if (v == null || !isFinite(v)) return '—';
  return `${(Number(v) * 100).toFixed(digits == null ? 0 : digits)}%`;
}

function fmtDelta(v) {
  if (v == null || !isFinite(v)) return { text: '—', dir: 'flat' };
  const dir = v > 0.5 ? 'up' : v < -0.5 ? 'down' : 'flat';
  return { text: `${v > 0 ? '+' : ''}${v.toFixed(1)}%`, dir };
}

function initials(name) {
  return (name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';
}

function fmtDate(value, opts) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-PH', opts || { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return '—';
  return d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function relativeTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return '—';
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(d);
}

const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------------------
 * Toasts
 * ------------------------------------------------------------------------ */

let toastHost = null;

function toast(message, type, timeout) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }

  const el = document.createElement('div');
  el.className = `toast toast--${type || 'info'}`;
  el.innerHTML = `<span class="toast__dot" aria-hidden="true"></span><span class="toast__msg">${esc(message)}</span>`;
  toastHost.appendChild(el);

  requestAnimationFrame(() => el.classList.add('is-in'));

  const life = timeout || (type === 'error' ? 6000 : 3800);
  setTimeout(() => {
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), 260);
  }, life);
}

/* ---------------------------------------------------------------------------
 * Modal
 * ------------------------------------------------------------------------ */

function openModal({ title, body, actions, wide }) {
  closeModal();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal ${wide ? 'modal--wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="modal__head">
        <h3>${esc(title)}</h3>
        <button class="modal__close" type="button" aria-label="Close">&times;</button>
      </header>
      <div class="modal__body"></div>
      <footer class="modal__foot"></footer>
    </div>`;

  const bodyEl = $('.modal__body', overlay);
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);

  const foot = $('.modal__foot', overlay);
  (actions || []).forEach((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${a.variant === 'primary' ? 'btn--primary' : a.variant === 'danger' ? 'btn--danger' : 'btn--ghost'}`;
    btn.textContent = a.label;
    btn.onclick = () => a.onClick && a.onClick(overlay);
    foot.appendChild(btn);
  });
  if (!(actions || []).length) foot.remove();

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('is-open'));

  $('.modal__close', overlay).onclick = closeModal;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', escClose);

  const focusable = overlay.querySelector('input, select, textarea, button.btn--primary');
  if (focusable) setTimeout(() => focusable.focus(), 60);

  return overlay;
}

function escClose(e) {
  if (e.key === 'Escape') closeModal();
}

function closeModal() {
  const el = $('#modal-overlay');
  if (!el) return;
  el.classList.remove('is-open');
  document.removeEventListener('keydown', escClose);
  setTimeout(() => el.remove(), 200);
}

function confirmDialog(title, message, confirmLabel) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p class="modal__text">${esc(message)}</p>`,
      actions: [
        { label: 'Cancel', variant: 'ghost', onClick: () => { closeModal(); resolve(false); } },
        { label: confirmLabel || 'Confirm', variant: 'danger', onClick: () => { closeModal(); resolve(true); } },
      ],
    });
  });
}

/* ---------------------------------------------------------------------------
 * Chart theming
 * ------------------------------------------------------------------------ */

const CHART = {
  green: '#0f7a3d',
  greenSoft: 'rgba(15, 122, 61, 0.12)',
  lime: '#8fbe2f',
  amber: '#d08a1e',
  red: '#c2453a',
  slate: '#6b7c70',
  grid: 'rgba(24, 44, 32, 0.08)',
  tick: '#5c6f62',
  palette: ['#0f7a3d', '#8fbe2f', '#2f8f83', '#d08a1e', '#c2453a', '#7c6bb0', '#3f7fbf', '#a3a86a'],
};

function applyChartDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = CHART.tick;
  Chart.defaults.animation.duration = prefersReducedMotion() ? 0 : 520;
  Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(18, 32, 24, 0.94)';
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
  Chart.defaults.plugins.tooltip.titleFont = { weight: '600', size: 12 };
  Chart.defaults.plugins.tooltip.displayColors = true;
  Chart.defaults.plugins.tooltip.boxPadding = 4;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
  Chart.defaults.plugins.legend.labels.padding = 14;
}

const chartRegistry = new Map();

function renderChart(canvasId, config) {
  if (typeof Chart === 'undefined') return null;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const existing = chartRegistry.get(canvasId);
  if (existing) existing.destroy();

  const chart = new Chart(canvas, config);
  chartRegistry.set(canvasId, chart);
  return chart;
}

function destroyChart(canvasId) {
  const c = chartRegistry.get(canvasId);
  if (c) { c.destroy(); chartRegistry.delete(canvasId); }
}

function axis(title) {
  return {
    grid: { color: CHART.grid, drawBorder: false },
    border: { display: false },
    ticks: { color: CHART.tick, maxRotation: 0, autoSkipPadding: 12 },
    title: title ? { display: true, text: title, color: CHART.tick, font: { size: 10, weight: '600' } } : undefined,
  };
}

/* ---------------------------------------------------------------------------
 * Misc
 * ------------------------------------------------------------------------ */

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms || 250); };
}

function animateCount(el, to, opts) {
  if (!el) return;
  const target = Number(to) || 0;
  const suffix = (opts && opts.suffix) || '';
  if (prefersReducedMotion() || target === 0) { el.textContent = fmtInt(target) + suffix; return; }

  const from = 0;
  const dur = 620;
  const start = performance.now();
  function step(now) {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmtInt(Math.round(from + (target - from) * eased)) + suffix;
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function setLoading(el, on) {
  if (!el) return;
  el.classList.toggle('is-loading', !!on);
}

function skeleton(rows) {
  return `<div class="skeleton-stack">${Array.from({ length: rows || 3 })
    .map(() => '<div class="skeleton"></div>').join('')}</div>`;
}

function emptyState(title, hint, actionHtml) {
  return `<div class="empty-state">
    <div class="empty-state__mark" aria-hidden="true">
      <svg viewBox="0 0 48 48" fill="none"><path d="M24 40c0-9 4-16 12-20-1 10-5 17-12 20Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M24 40C24 31 20 24 12 20c1 10 5 17 12 20Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M24 40V24" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </div>
    <p class="empty-state__title">${esc(title)}</p>
    ${hint ? `<p class="empty-state__hint">${esc(hint)}</p>` : ''}
    ${actionHtml || ''}
  </div>`;
}

/** Picks the largest slice, used for "most common" cards. */
function topEntry(list, key) {
  if (!list || !list.length) return null;
  return list.slice().sort((a, b) => (b[key || 'scans'] || 0) - (a[key || 'scans'] || 0))[0];
}
