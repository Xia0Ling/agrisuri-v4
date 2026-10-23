/* ============================================================================
 * Route guard. The role check here decides which page renders; it is NOT the
 * security boundary — RLS is. A user who forges their way onto a page still
 * cannot read a single row they are not entitled to.
 * ========================================================================== */


const Guard = (() => {
  let current = null;
  let redirecting = false;

  function go(url) {
    if (redirecting) return;
    redirecting = true;
    location.replace(url);
  }

  /**
   * Resolve the signed-in profile and assert the role.
   * Returns the profile, or null after scheduling a redirect.
   */
  async function require(allowedRoles) {
    if (current) return allowedRoles.includes(current.role) ? current : bounce(current.role);

    const session = await Store.session();
    if (!session) {
      localStorage.removeItem('agri_profile');
      go('auth.html');
      return null;
    }

    let profile = null;
    try {
      profile = await Store.profile(true);
    } catch (err) {
      // Network failure: fall back to the last known profile for rendering only.
      // Any write attempt will be rejected by RLS with no valid JWT.
      profile = cachedProfile();
      if (profile) {
        toast('You are offline. Showing the last synced view.', 'warn');
      }
    }

    if (!profile) {
      localStorage.removeItem('agri_profile');
      go('auth.html');
      return null;
    }

    if (!allowedRoles.includes(profile.role)) return bounce(profile.role);

    current = profile;
    try {
      localStorage.setItem('agri_profile', JSON.stringify({
        id: profile.id, full_name: profile.full_name, role: profile.role,
        jurisdiction_id: profile.jurisdiction_id, barangay_id: profile.barangay_id,
      }));
    } catch (e) { /* storage full or blocked; not fatal */ }

    return profile;
  }

  function cachedProfile() {
    try {
      const raw = localStorage.getItem('agri_profile');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function bounce(role) {
    const target = HOME_FOR[role] || 'auth.html';
    if (!location.pathname.endsWith(target)) go(target);
    return null;
  }

  /**
   * The terms gate. Runs after the role check, before the page is usable.
   * A profile without terms_accepted_at is asked once; the answer is stored
   * server-side with the version, so a future rewrite can be re-presented
   * rather than silently inheriting consent for text nobody read.
   */
  async function ensureTerms(profile) {
    if (!profile) return true;

    // The terms are about acting on a diagnosis. Staff do not receive one, so
    // the gate is for farmers only — enforced here, not only at the call site.
    if (profile.role !== 'farmer') return true;

    if (profile.terms_accepted_at) return true;

    const accepted = await Terms.show({ blocking: true });
    if (!accepted) return false;

    try {
      await Store.acceptTerms(TERMS_VERSION);
      profile.terms_accepted_at = new Date().toISOString();
      profile.terms_version = TERMS_VERSION;
    } catch (e) {
      toast('Could not save your acceptance. You will be asked again next time.', 'error');
    }
    return true;
  }

  /** Called by the pages once they have rendered. */
  function reveal() {
    document.documentElement.style.visibility = 'visible';
  }

  async function logout() {
    const ok = await confirmDialog(
      'Log out?',
      'You will need your email and password to sign back in. Anything already saved stays saved.',
      'Log out',
    );
    if (!ok) return;

    try { await db.auth.signOut({ scope: 'local' }); } catch (e) { /* already gone */ }
    localStorage.removeItem('agri_profile');
    localStorage.removeItem('agri_weather');
    go('auth.html');
  }

  /* Session expiry: Supabase emits SIGNED_OUT when the refresh token dies. */
  db.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      current = null;
      localStorage.removeItem('agri_profile');
      if (!location.pathname.endsWith('auth.html')) go('auth.html');
    }
  });

  /* Bfcache restore after logout would otherwise show a stale protected page. */
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !localStorage.getItem('agri_profile')) go('auth.html');
  });

  /* Never leave the page invisible if boot fails. */
  setTimeout(() => {
    if (document.documentElement.style.visibility === 'hidden') reveal();
  }, 6000);

  return { require, ensureTerms, reveal, logout, cachedProfile };
})();
