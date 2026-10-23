/* ============================================================================
 * Auth page.
 *
 * Security model:
 *   - Farmers self-register; the barangay is validated by a database trigger.
 *   - Staff never self-register silently. "Developer mode" reveals an Admin /
 *     DA Officer form that requires an access code. The code is verified
 *     server-side against a SHA-256 hash in `staff_keys`, and the trigger
 *     decides the role. Nothing here can grant a role on its own.
 *   - The claimed role must match the key that was entered.
 * ========================================================================== */

const HOME_FOR = { farmer: 'index.html', da: 'dashboard.html', admin: 'dashboard.html' };

let mode = 'login';
let devMode = false;
let staffRole = 'admin';

const el = (id) => document.getElementById(id);

/* Each staff role has its own one-time key, so the field must say which one. */
const ROLE_LABEL = { admin: 'auth.keyForAdmin', da: 'auth.keyForDa' };
const ROLE_PROMPT = { admin: 'auth.keyPromptAdmin', da: 'auth.keyPromptDa' };

/* ---------------------------------------------------------------------------
 * Toast
 * ------------------------------------------------------------------------ */

let toastTimer;
function showToast(message, kind) {
  const node = el('toast-msg');
  node.textContent = message;
  node.className = `toast show ${kind === 'error' ? 'toast--error' : kind === 'success' ? 'toast--success' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = 'toast'; }, kind === 'error' ? 5200 : 3400);
}

/* ---------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------ */

(async function boot() {
  document.documentElement.style.visibility = 'hidden';

  I18N.apply();
  paintLangLabel();

  await Promise.all([loadBarangays(), resumeSession()]);

  bindEvents();
  render();
  document.documentElement.style.visibility = 'visible';
})();

function paintLangLabel() {
  el('lang-label').textContent = I18N.lang === 'en' ? 'FIL' : 'EN';
}

async function resumeSession() {
  try {
    const { data } = await db.auth.getSession();
    if (!data.session) return;

    const { data: profile } = await db
      .from('profiles')
      .select('role, is_active')
      .eq('id', data.session.user.id)
      .single();

    if (!profile) { await db.auth.signOut({ scope: 'local' }); return; }

    if (!profile.is_active) {
      await db.auth.signOut({ scope: 'local' });
      showToast(t('auth.inactive'), 'error');
      return;
    }

    location.replace(HOME_FOR[profile.role] || 'index.html');
  } catch (e) {
    /* Offline or Supabase unreachable: stay on the form. */
  }
}

async function loadBarangays() {
  const select = el('input-brgy');
  try {
    const { data, error } = await db
      .from('barangays')
      .select('id, name, jurisdictions(name)')
      .order('name');
    if (error) throw error;
    if (!data || !data.length) throw new Error('empty');

    select.innerHTML = `<option value="">${t('auth.chooseBrgy')}</option>` +
      data.map((b) => `<option value="${b.id}">${b.name}</option>`).join('');
    select.disabled = false;
  } catch (e) {
    select.innerHTML = `<option value="">${t('auth.noBarangays')}</option>`;
    select.disabled = true;
  }
}

/* ---------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------ */

function render() {
  const registering = mode === 'register';
  const staff = devMode;

  el('tab-login').classList.toggle('active', mode === 'login');
  el('tab-register').classList.toggle('active', registering);

  el('switcher-role').classList.toggle('hidden', !(devMode && registering));
  el('tab-admin').classList.toggle('active', staffRole === 'admin');
  el('tab-da').classList.toggle('active', staffRole === 'da');

  el('group-name').classList.toggle('hidden', !registering);
  el('group-confirm').classList.toggle('hidden', !registering);
  el('group-brgy').classList.toggle('hidden', !(registering && !staff));
  el('group-code').classList.toggle('hidden', !(registering && staff));
  el('group-terms').classList.toggle('hidden', !registering);

  el('input-name').required = registering;
  el('input-confirm').required = registering;
  el('input-brgy').required = registering && !staff;
  el('input-code').required = registering && staff;

  // The key is issued per role, so the label follows the selected tab.
  el('label-code').textContent = staff
    ? t(ROLE_LABEL[staffRole] || 'auth.accessCode')
    : t('auth.accessCode');

  el('input-password').setAttribute('autocomplete', registering ? 'new-password' : 'current-password');

  const key = registering ? (staff ? 'auth.submitStaff' : 'auth.submitRegister') : 'auth.submitLogin';
  el('submit-label').setAttribute('data-i18n', key);
  el('submit-label').textContent = t(key);

  el('dev-toggle').classList.toggle('is-on', devMode);
  el('dev-toggle').setAttribute('aria-pressed', String(devMode));
  el('dev-label').textContent = devMode ? t('auth.devModeOn') : t('auth.devMode');
}

/**
 * Selecting a role means "I hold the key for this role". Put the cursor in the
 * field and say which key is expected, rather than leaving the user to guess.
 * The field is cleared because an Admin key is not a DA key.
 */
function promptStaffKey() {
  const input = el('input-code');
  input.value = '';
  input.focus();
  showToast(t(ROLE_PROMPT[staffRole] || 'auth.keyPromptAdmin'));
}

function bindEvents() {
  el('tab-login').onclick = () => { mode = 'login'; render(); };
  el('tab-register').onclick = () => { mode = 'register'; render(); };

  el('tab-admin').onclick = () => { staffRole = 'admin'; render(); promptStaffKey(); };
  el('tab-da').onclick = () => { staffRole = 'da'; render(); promptStaffKey(); };

  document.querySelectorAll('.toggle-password-btn').forEach((btn) => {
    btn.onclick = () => togglePassword(btn.dataset.toggle, btn);
  });

  el('terms-link').onclick = (e) => {
    e.preventDefault();
    // Read-only view: closing it does not tick the box for them.
    Terms.show({ blocking: false });
  };

  el('btn-clear').onclick = () => {
    el('auth-form').reset();
    document.querySelectorAll('.password-wrapper input').forEach((i) => { i.type = 'password'; });
    showToast(t('auth.cleared'));
  };

  el('dev-toggle').onclick = () => {
    devMode = !devMode;
    if (devMode) mode = 'register';
    else { mode = 'login'; staffRole = 'admin'; }
    render();
    if (devMode) promptStaffKey();
  };

  el('lang-btn').onclick = () => {
    I18N.toggle();
    paintLangLabel();
    render();
    loadBarangays();
  };

  el('auth-form').onsubmit = handleSubmit;
}

function togglePassword(inputId, btn) {
  const input = el(inputId);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  btn.querySelector('svg').innerHTML = show
    ? '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path><path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path><line x1="2" y1="2" x2="22" y2="22"></line>'
    : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
}

/* ---------------------------------------------------------------------------
 * Submit
 * ------------------------------------------------------------------------ */

function busy(on) {
  const btn = el('btn-submit');
  btn.disabled = on;
  btn.classList.toggle('is-busy', on);
}

async function handleSubmit(e) {
  e.preventDefault();

  if (!navigator.onLine) { showToast(t('auth.offline'), 'error'); return; }

  const email = el('input-email').value.trim();
  const password = el('input-password').value;

  if (!email || !password) { showToast(t('auth.needEmail'), 'error'); return; }
  if (password.length < 8) { showToast(t('auth.shortPassword'), 'error'); return; }

  busy(true);
  try {
    if (mode === 'register') await register(email, password);
    else await login(email, password);
  } catch (err) {
    showToast(friendlyError(err), 'error');
  } finally {
    busy(false);
  }
}

async function register(email, password) {
  if (password !== el('input-confirm').value) throw new Error(t('auth.mismatch'));

  const fullName = el('input-name').value.trim();
  if (fullName.length < 2) throw new Error(t('auth.needName'));

  if (!el('input-terms').checked) throw new Error(t('auth.needTerms'));

  const meta = { full_name: fullName };

  if (devMode) {
    const code = el('input-code').value.trim().toUpperCase();
    if (!code) throw new Error(t('auth.needCode'));

    // Pre-flight so the user gets a real reason instead of "database error".
    const { data: check, error } = await db.rpc('check_access_code', {
      p_code: code,
      p_role: staffRole,
    });
    if (error) throw error;
    if (!check || !check.valid) throw new Error(t('auth.badCode'));

    meta.access_code = code;
    meta.role = staffRole;
  } else {
    const brgy = el('input-brgy').value;
    if (!brgy) throw new Error(t('auth.needBrgy'));
    meta.barangay_id = brgy;
  }

  const { data, error } = await db.auth.signUp({ email, password, options: { data: meta } });
  if (error) throw error;

  if (!data.session) {
    showToast(t('auth.confirmEmail'), 'success');
    mode = 'login';
    devMode = false;
    render();
    return;
  }

  // The account exists and is signed in, so the acceptance can be stored now.
  // If email confirmation is on there is no session yet; the gate in guard.js
  // asks again at first login.
  try {
    await db.rpc('accept_terms', { p_version: TERMS_VERSION });
  } catch (e) {
    console.warn('[AgriSuri] terms not recorded:', e && e.message);
  }

  await routeAfterLogin(data.user.id);
}

async function login(email, password) {
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  if (error) throw error;

  const { data: profile } = await db
    .from('profiles')
    .select('role, is_active')
    .eq('id', data.user.id)
    .single();

  if (!profile) {
    await db.auth.signOut({ scope: 'local' });
    throw new Error(t('auth.noProfile'));
  }
  if (!profile.is_active) {
    await db.auth.signOut({ scope: 'local' });
    throw new Error(t('auth.inactive'));
  }

  location.replace(HOME_FOR[profile.role] || 'index.html');
}

async function routeAfterLogin(userId) {
  const { data: profile } = await db.from('profiles').select('role').eq('id', userId).single();
  location.replace(HOME_FOR[profile ? profile.role : 'farmer'] || 'index.html');
}

function friendlyError(err) {
  const msg = (err && err.message) || 'Unknown error';

  if (/invalid login credentials/i.test(msg)) return t('auth.badCredentials');
  if (/email not confirmed/i.test(msg)) return t('auth.confirmEmail');
  if (/user already registered|already been registered/i.test(msg)) return t('auth.alreadyRegistered');
  if (/password should be at least/i.test(msg)) return t('auth.shortPassword');
  if (/unable to validate email|invalid email/i.test(msg)) return t('auth.needEmail');
  if (/rate limit|too many/i.test(msg)) return t('auth.tooMany');
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return t('auth.network');
  if (/farmer account limit/i.test(msg)) return t('auth.farmerCap');
  if (/admin account limit/i.test(msg)) return t('auth.adminCap');
  if (/da officer account limit/i.test(msg)) return t('auth.officerCap');
  if (/invalid access code|check_access_code/i.test(msg)) return t('auth.badCode');
  if (/database error saving new user/i.test(msg)) return t('auth.dbError');

  return msg;
}
