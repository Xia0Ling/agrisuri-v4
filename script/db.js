/* ============================================================================
 * Data access layer. Every call goes through RLS — the client never filters
 * data by role itself, because a filter in the browser is not security.
 * ========================================================================== */

const Store = (() => {
  let profileCache = null;
  let diseaseCache = null;
  let barangayCache = null;

  function reset() {
    profileCache = null;
    diseaseCache = null;
    barangayCache = null;
  }

  async function session() {
    const { data } = await db.auth.getSession();
    return data.session || null;
  }

  async function profile(force) {
    if (profileCache && !force) return profileCache;
    const s = await session();
    if (!s) return null;

    const BASE = 'id, full_name, role, jurisdiction_id, barangay_id, is_active, consent_training, created_at';

    let { data, error } = await db
      .from('profiles')
      .select('id, full_name, role, jurisdiction_id, barangay_id, is_active, consent_training, terms_version, terms_accepted_at, created_at')
      .eq('id', s.user.id)
      .single();

    /*
     * sql/terms.sql may not have been applied yet. Without this fallback the
     * query 400s, the guard finds no profile, and every account is bounced back
     * to the login page in a loop. Degrade to "no terms gate" instead.
     */
    if (error && /terms_version|terms_accepted_at/.test(error.message || '')) {
      ({ data, error } = await db.from('profiles').select(BASE).eq('id', s.user.id).single());
      if (data) data.terms_accepted_at = new Date().toISOString();
    }

    if (error || !data) return null;
    if (!data.is_active) return null;

    profileCache = { ...data, email: s.user.email || '' };
    return profileCache;
  }

  /*
   * `diseases` is static reference data — 14 rows that change only when the
   * seed changes. Keeping the last copy means an offline scan can still name a
   * disease and show its prevention text.
   *
   * This is what used to break offline scanning outright: the pipeline calls
   * Store.diseases() before inference starts, so a failed fetch threw and no
   * scan happened at all, even with the on-device models available.
   */
  const DISEASE_CACHE_KEY = 'agri_diseases';

  function readDiseaseCache() {
    try {
      const raw = localStorage.getItem(DISEASE_CACHE_KEY);
      const rows = raw ? JSON.parse(raw) : null;
      return Array.isArray(rows) && rows.length ? rows : null;
    } catch (e) {
      return null;
    }
  }

  function writeDiseaseCache(rows) {
    try {
      localStorage.setItem(DISEASE_CACHE_KEY, JSON.stringify(rows));
    } catch (e) {
      /* Quota or private mode: the in-memory copy still covers this session. */
    }
  }

  async function diseases() {
    if (diseaseCache) return diseaseCache;

    try {
      const { data, error } = await db
        .from('diseases')
        .select('id, crop_code, code, name, is_healthy, severity, symptoms, treatment, prevention, safety, source')
        .order('crop_code')
        .order('name');
      if (error) throw error;

      diseaseCache = data || [];
      if (diseaseCache.length) writeDiseaseCache(diseaseCache);
      return diseaseCache;
    } catch (err) {
      const cached = readDiseaseCache();
      if (cached) {
        diseaseCache = cached;
        return diseaseCache;
      }
      throw err;
    }
  }

  async function barangays() {
    if (barangayCache) return barangayCache;
    const { data, error } = await db
      .from('barangays')
      .select('id, name, jurisdiction_id, jurisdictions(name)')
      .order('name');
    if (error) throw error;
    barangayCache = data || [];
    return barangayCache;
  }

  async function jurisdictions() {
    const { data, error } = await db.from('jurisdictions').select('id, name, province').order('name');
    if (error) throw error;
    return data || [];
  }

  /* ---------------- scans ---------------- */

  async function uploadImage(file, userId) {
    const ext = (file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg');
    const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await db.storage
      .from('crop-images')
      .upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
    if (error) throw error;
    return path;
  }

  async function createScan(payload) {
    const { data, error } = await db.rpc('create_scan', {
      p_crop_code: payload.cropCode,
      p_status: payload.status,
      p_top_label: payload.topLabel ?? null,
      p_top_code: payload.topCode ?? null,
      p_top_confidence: payload.topConfidence ?? null,
      p_confidence_band: payload.confidenceBand ?? null,
      p_image_path: payload.imagePath ?? null,
      p_image_quality: payload.imageQuality ?? null,
      p_validation: payload.validation ?? null,
      p_model_id: payload.modelId ?? null,
      p_model_version: payload.modelVersion ?? null,
      p_inference_mode: payload.inferenceMode ?? null,
      p_normalized: payload.normalized ?? [],
      p_predictions: payload.predictions ?? [],
      p_lat: payload.lat ?? null,
      p_lng: payload.lng ?? null,
      p_location_source: payload.locationSource ?? 'none',
      p_barangay_id: payload.barangayId ?? null,
      p_consent_training: !!payload.consentTraining,
    });
    if (error) throw error;
    return data;
  }

  async function myScans(opts) {
    const o = opts || {};
    let q = db
      .from('scans')
      .select('id, crop_code, status, top_label, top_confidence, confidence_band, image_path, normalized, created_at, barangay_id, lat, lng, location_source, model_id, inference_mode')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (o.from) q = q.gte('created_at', o.from.toISOString());
    if (o.to) q = q.lt('created_at', o.to.toISOString());
    q = q.limit(o.limit || 200);

    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async function scanPredictions(scanIds) {
    if (!scanIds || !scanIds.length) return {};
    const { data, error } = await db
      .from('scan_predictions')
      .select('scan_id, label, raw_confidence, normalized_pct, rank, disease_id')
      .in('scan_id', scanIds)
      .order('rank');
    if (error) throw error;

    const grouped = {};
    for (const row of data || []) {
      (grouped[row.scan_id] = grouped[row.scan_id] || []).push(row);
    }
    return grouped;
  }

  async function deleteScan(id) {
    const { error } = await db.from('scans').delete().eq('id', id);
    if (error) throw error;
  }

  /**
   * Admin-only hard delete. Goes through an RPC so the action lands in
   * audit_events and the caller learns which photo to remove from storage.
   * Returns the image path, or null when the scan had no photo.
   */
  async function adminDeleteScan(id) {
    const { data, error } = await db.rpc('admin_delete_scan', { p_scan_id: id });
    if (error) throw error;
    return data || null;
  }

  async function signedUrl(path, expires) {
    if (!path) return null;
    const { data, error } = await db.storage.from('crop-images').createSignedUrl(path, expires || 3600);
    if (error) return null;
    return data.signedUrl;
  }

  async function signedUrls(paths, expires) {
    if (!paths || !paths.length) return {};
    const { data, error } = await db.storage.from('crop-images').createSignedUrls(paths, expires || 3600);
    if (error) return {};
    return Object.fromEntries((data || []).map((d) => [d.path, d.signedUrl]));
  }

  /* ---------------- analytics (RLS-scoped in SQL) ---------------- */

  async function summary(from, to, barangayId) {
    const { data, error } = await db.rpc('analytics_summary', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_barangay: barangayId || null,
    });
    if (error) throw error;
    return data || { scans: 0, farmers: 0, affected: 0, confirmed: 0, barangays: 0 };
  }

  async function series(from, to, bucket, barangayId) {
    const { data, error } = await db.rpc('analytics_series', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_bucket: bucket,
      p_barangay: barangayId || null,
    });
    if (error) throw error;
    return data || [];
  }

  async function diseaseBreakdown(from, to, barangayId, limit) {
    const { data, error } = await db.rpc('analytics_diseases', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_barangay: barangayId || null,
      p_limit: limit || 10,
    });
    if (error) throw error;
    return data || [];
  }

  async function cropBreakdown(from, to, barangayId) {
    const { data, error } = await db.rpc('analytics_crops', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_barangay: barangayId || null,
    });
    if (error) throw error;
    return data || [];
  }

  async function barangayBreakdown(from, to) {
    const { data, error } = await db.rpc('analytics_barangays', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
    });
    if (error) throw error;
    return data || [];
  }

  async function barangayDiseaseMatrix(from, to, limit) {
    const { data, error } = await db.rpc('analytics_barangay_disease', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_limit: limit || 8,
    });
    if (error) throw error;
    return data || [];
  }

  async function farmerStats(from, to) {
    const { data, error } = await db.rpc('analytics_farmers', {
      p_from: from ? from.toISOString() : null,
      p_to: to ? to.toISOString() : null,
    });
    if (error) throw error;
    return data || [];
  }

  /* ---------------- staff ---------------- */

  async function listProfiles(filter) {
    const f = filter || {};
    let q = db
      .from('profiles')
      .select('id, full_name, role, jurisdiction_id, barangay_id, is_active, consent_training, created_at', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (f.role) q = q.eq('role', f.role);
    if (f.search) q = q.ilike('full_name', `%${f.search}%`);
    if (f.limit) q = q.range(f.offset || 0, (f.offset || 0) + f.limit - 1);

    const { data, error, count } = await q;
    if (error) throw error;
    return { rows: data || [], count: count || 0 };
  }

  async function pagedScans(filter) {
    const f = filter || {};
    let q = db
      .from('scans')
      .select(
        'id, user_id, crop_code, status, top_label, top_confidence, confidence_band, image_path, created_at, barangay_id, jurisdiction_id, model_id, inference_mode, profiles(full_name), barangays(name)',
        { count: 'exact' },
      )
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (f.from) q = q.gte('created_at', f.from.toISOString());
    if (f.to) q = q.lt('created_at', f.to.toISOString());
    if (f.barangayId) q = q.eq('barangay_id', f.barangayId);
    if (f.crop) q = q.eq('crop_code', f.crop);
    if (f.status) q = q.eq('status', f.status);

    const limit = f.limit || 20;
    const offset = f.offset || 0;
    q = q.range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) throw error;
    return { rows: data || [], count: count || 0 };
  }

  async function setRole(targetId, role, jurisdictionId) {
    const { error } = await db.rpc('admin_set_role', {
      p_target: targetId,
      p_role: role,
      p_jurisdiction: jurisdictionId || null,
    });
    if (error) throw error;
  }

  async function setActive(targetId, active) {
    const { error } = await db.rpc('admin_set_active', { p_target: targetId, p_active: active });
    if (error) throw error;
  }

  async function createInvite(role, jurisdictionId, days) {
    const { data, error } = await db.rpc('admin_create_invite', {
      p_role: role,
      p_jurisdiction: jurisdictionId || null,
      p_days: days || 7,
    });
    if (error) throw error;
    return data;
  }

  async function auditEvents(limit) {
    const { data, error } = await db
      .from('audit_events')
      .select('id, actor_id, actor_role, action, target_type, target_id, meta, created_at, profiles(full_name)')
      .order('created_at', { ascending: false })
      .limit(limit || 50);
    if (error) throw error;
    return data || [];
  }

  async function accountCounts() {
    const [farmers, admins, officers] = await Promise.all([
      db.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'farmer'),
      db.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin'),
      db.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'da'),
    ]);
    return {
      farmers: farmers.count || 0,
      admins: admins.count || 0,
      officers: officers.count || 0,
    };
  }

  /* ------------------------------------------------------------------ *
   * Feedback on a diagnosis
   *
   * The farmer's verdict is the only ground truth this system has. It is
   * written per scan (upsert), so a farmer can change their mind.
   * ------------------------------------------------------------------ */

  async function saveFeedback({ scanId, verdict, correctedCode, note }) {
    if (!scanId) throw new Error('No scan to attach feedback to.');
    if (!['correct', 'wrong', 'unsure'].includes(verdict)) throw new Error('Invalid verdict.');

    const s = await session();
    if (!s) throw new Error('Not signed in.');

    const { error } = await db.from('scan_feedback').upsert(
      {
        scan_id: scanId,
        user_id: s.user.id,
        verdict,
        corrected_code: verdict === 'wrong' ? correctedCode || null : null,
        note: note ? String(note).slice(0, 500) : null,
      },
      { onConflict: 'scan_id' },
    );
    if (error) throw error;
  }

  /** Review queue and training set, in one query. RLS decides the scope. */
  async function feedback(limit, status) {
    let q = db
      .from('scan_feedback')
      .select(
        'scan_id, verdict, corrected_code, note, created_at, status, ' +
          'reviewed_by, reviewed_at, review_note, reject_class, ' +
          'scans(id, crop_code, top_label, top_confidence, image_path, created_at, ' +
          'user_id, barangay_id, jurisdiction_id, lat, lng)',
      )
      .order('created_at', { ascending: false })
      .limit(limit || 300);

    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  /** The Mail tab: what is waiting for a reviewer. */
  const feedbackPending = (limit) => feedback(limit, 'pending');

  /**
   * The Training tab: everything a reviewer has decided. Approved rows become
   * their disease class; rejected ones become `not_leaf` or
   * `not_supported_crop` — a rejected photo is a negative example, not waste.
   */
  async function feedbackTraining(limit) {
    const rows = await feedback(limit);
    return rows.filter((r) => r.status === 'approved' || r.status === 'rejected');
  }

  /**
   * Approve or reject a farmer's correction. The trigger stamps reviewed_by
   * and reviewed_at server-side, so the client cannot forge them.
   */
  async function reviewFeedback(scanId, status, note, rejectClass) {
    if (!['approved', 'rejected'].includes(status)) throw new Error('Invalid review status.');
    if (status === 'rejected' && !['not_leaf', 'not_supported_crop'].includes(rejectClass)) {
      throw new Error('A rejected photo needs a reason: not a leaf, or an unsupported crop.');
    }

    const { error } = await db
      .from('scan_feedback')
      .update({
        status,
        review_note: note ? String(note).slice(0, 500) : null,
        reject_class: status === 'rejected' ? rejectClass : null,
      })
      .eq('scan_id', scanId);
    if (error) throw error;
  }

  /** Record the user's acceptance of the terms, with the version they read. */
  async function acceptTerms(version) {
    const { error } = await db.rpc('accept_terms', { p_version: version });
    if (error) throw error;
  }

  /** Remove a stored photo. Used when a reviewer rejects a submission. */
  async function removeImage(path) {
    if (!path) return;
    const { error } = await db.storage.from('crop-images').remove([path]);
    if (error) throw error;
  }

  return {
    reset,
    session,
    profile,
    diseases,
    barangays,
    jurisdictions,
    uploadImage,
    createScan,
    myScans,
    scanPredictions,
    deleteScan,
    adminDeleteScan,
    signedUrl,
    signedUrls,
    summary,
    series,
    diseaseBreakdown,
    cropBreakdown,
    barangayBreakdown,
    barangayDiseaseMatrix,
    farmerStats,
    listProfiles,
    pagedScans,
    setRole,
    setActive,
    createInvite,
    auditEvents,
    accountCounts,
    saveFeedback,
    feedback,
    feedbackPending,
    feedbackTraining,
    reviewFeedback,
    removeImage,
    acceptTerms,
  };
})();
