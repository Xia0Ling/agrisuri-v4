/* ============================================================================
 * Idle lock for staff sessions.
 *
 * A DA officer's laptop is often left open on a desk in a barangay hall. After
 * five minutes with no pointer, key, touch or scroll, the screen is covered and
 * the only way back is to sign in again.
 *
 * The check is timestamp-based rather than a single setTimeout: browsers
 * throttle timers in background tabs, so a 5-minute timeout can fire minutes
 * late. Comparing wall-clock against the last activity is accurate even when
 * the tab was suspended.
 * ========================================================================== */

const Idle = (() => {
  const LIMIT = 5 * 60 * 1000;
  const TICK = 5000;
  const EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'];

  let lastActive = Date.now();
  let timer = null;
  let locked = false;

  const touch = () => {
    if (locked) return;
    lastActive = Date.now();
  };

  function overlay() {
    let el = document.getElementById('idle-lock');
    if (el) return el;

    el = document.createElement('div');
    el.id = 'idle-lock';
    el.className = 'idle-lock';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <div class="idle-lock__card">
        <svg viewBox="0 0 24 24" aria-hidden="true" class="idle-lock__icon">
          <rect x="4" y="10" width="16" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/>
          <path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        </svg>
        <h2>Session locked</h2>
        <p>Five minutes of inactivity ends this session. Sign in again to continue.</p>
        <button class="btn btn--primary" type="button" data-idle-login>Please log in again</button>
      </div>`;

    document.body.appendChild(el);
    el.querySelector('[data-idle-login]').addEventListener('click', leave);
    return el;
  }

  function lock() {
    if (locked) return;
    locked = true;
    clearInterval(timer);
    overlay().classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  async function leave() {
    try {
      // Local scope only: the session on the server is left alone, so a stray
      // lock cannot revoke access from another device.
      await db.auth.signOut({ scope: 'local' });
    } catch (e) {
      /* already gone */
    }
    localStorage.removeItem('agri_profile');
    location.replace('auth.html');
  }

  function check() {
    if (locked) return;
    if (Date.now() - lastActive >= LIMIT) lock();
  }

  function init() {
    EVENTS.forEach((name) => {
      // Passive: these fire often and must never block scrolling.
      window.addEventListener(name, touch, { passive: true });
    });

    document.addEventListener('visibilitychange', () => {
      // Returning to a tab that sat idle past the limit must lock immediately,
      // not wait for the next tick.
      if (document.visibilityState === 'visible') check();
    });

    timer = setInterval(check, TICK);
    check();
  }

  return { init, lock, check, LIMIT };
})();
