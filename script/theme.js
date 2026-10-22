/* ============================================================================
 * Theme: light / midnight.
 *
 * Three rules this follows:
 *
 * 1. No flash. A tiny inline script in each page's <head> sets
 *    `data-theme` before the first paint, so a dark-mode user never sees a
 *    white frame. This file only handles the toggle.
 *
 * 2. The reveal is anchored to the button. The new theme expands as a circle
 *    from the control that was pressed, using the View Transitions API. Where
 *    that API is missing the switch is instant — no fake animation.
 *
 * 3. The stored choice wins; otherwise the OS preference decides. Changing the
 *    OS setting later only matters while the user has not chosen explicitly.
 * ========================================================================== */

const Theme = (() => {
  const KEY = 'agri_theme';
  const root = document.documentElement;

  const stored = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'dark' || v === 'light' ? v : null;
    } catch (e) {
      return null;
    }
  };

  const prefersDark = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const current = () => (root.dataset.theme === 'dark' ? 'dark' : 'light');

  function paint() {
    const dark = current() === 'dark';

    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(dark));
      btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      btn.setAttribute('title', dark ? 'Light theme' : 'Midnight theme');

      const sun = btn.querySelector('[data-theme-icon="sun"]');
      const moon = btn.querySelector('[data-theme-icon="moon"]');
      if (sun) sun.hidden = !dark;
      if (moon) moon.hidden = dark;
    });
  }

  function apply(mode) {
    root.dataset.theme = mode;
    root.style.colorScheme = mode;
    paint();
  }

  function commit(mode) {
    try {
      localStorage.setItem(KEY, mode);
    } catch (e) {
      /* Private mode: the choice lasts this session only. */
    }
    apply(mode);

    // Charts draw on a canvas and cannot inherit CSS variables, so pages that
    // own charts listen for this and rebuild them.
    document.dispatchEvent(new CustomEvent('agri:theme', { detail: { mode } }));
  }

  function toggle(event) {
    const next = current() === 'dark' ? 'light' : 'dark';
    const btn = event && event.currentTarget;

    if (!btn || typeof document.startViewTransition !== 'function') {
      commit(next);
      return;
    }

    const rect = btn.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    // Radius to the furthest corner, so the circle clears the viewport.
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

    root.style.setProperty('--theme-x', `${x}px`);
    root.style.setProperty('--theme-y', `${y}px`);
    root.style.setProperty('--theme-r', `${radius}px`);

    document.startViewTransition(() => commit(next));
  }

  function init() {
    apply(stored() || (prefersDark() ? 'dark' : 'light'));

    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.addEventListener('click', toggle);
    });

    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = (ev) => {
        if (!stored()) apply(ev.matches ? 'dark' : 'light');
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  init();

  return { toggle, current, apply: commit };
})();
