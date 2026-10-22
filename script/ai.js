/* ============================================================================
 * Scan pipeline.
 *
 * Order is fixed and enforced here, not in the UI:
 *   prepare -> quality -> crop validation -> disease inference -> normalise
 *
 * Disease inference is never reached when crop validation fails. Nothing is
 * invented: if no model is configured the pipeline reports `unconfigured` and
 * the UI shows setup instructions instead of a fake diagnosis.
 * ========================================================================== */

const ScanPipeline = (() => {
  const tmModels = new Map();
  let tmRuntime = null;

  const gatewayReady = () => !!(AI_CONFIG.gatewayUrl && AI_CONFIG.gatewayUrl.trim());

  const TM_URLS = {
    shape: () => AI_CONFIG.tmShapeGate,
    texture: () => AI_CONFIG.tmTextureGate,
    tomato: () => AI_CONFIG.tmDiseaseTomato,
    palay: () => AI_CONFIG.tmDiseasePalay,
  };
  const tmUrl = (which) => {
    const read = TM_URLS[which];
    const v = read ? read() : '';
    return v && v.trim() ? v.trim() : '';
  };
  const tmReady = (which) => !!tmUrl(which);

  const canRunDisease = (crop) => gatewayReady() || tmReady(crop);
  const canRunGate = () => gatewayReady() || tmReady('shape') || tmReady('texture');

  /**
   * TensorFlow.js plus the Teachable Machine wrapper are ~1 MB. Loading them on
   * every page view would slow the farmer app down for a feature most sessions
   * never touch, so they are injected on first use.
   */
  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = false;
      el.onload = resolve;
      el.onerror = () => reject(coded('offline_unavailable', 'Could not load the offline model runtime.'));
      document.head.appendChild(el);
    });
  }

  function loadTmRuntime() {
    if (typeof tmImage !== 'undefined') return Promise.resolve();
    if (tmRuntime) return tmRuntime;

    tmRuntime = (async () => {
      await injectScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@1.3.1/dist/tf.min.js');
      await injectScript('https://cdn.jsdelivr.net/npm/@teachablemachine/image@0.8/dist/teachablemachine-image.min.js');
      if (typeof tmImage === 'undefined') {
        throw coded('offline_unavailable', 'The offline model runtime did not initialise.');
      }
    })();

    tmRuntime.catch(() => { tmRuntime = null; });
    return tmRuntime;
  }

  /* ------------------------------------------------------------------ *
   * Providers
   * ------------------------------------------------------------------ */

  async function gatewayInfer(stage, canvas, crop) {
    const base64 = canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
    const session = await Store.session();
    if (!session) throw coded('unauthenticated', 'Your session expired. Sign in again.');

    const body = JSON.stringify({ stage, crop, image: base64 });

    const attempt = async () =>
      fetch(AI_CONFIG.gatewayUrl.replace(/\/$/, ''), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_KEY,
        },
        body,
      });

    let res;
    try {
      res = await attempt();
      // One retry for transient failures only.
      if (res.status >= 500 && res.status !== 503) {
        await new Promise((r) => setTimeout(r, 450));
        res = await attempt();
      }
    } catch (err) {
      throw coded('network', 'Could not reach the inference service. Check your connection.');
    }

    let payload = {};
    try { payload = await res.json(); } catch (e) { /* handled below */ }

    if (!res.ok) {
      throw coded(payload.error || 'inference_failed', payload.message || `Inference failed (${res.status}).`);
    }

    return {
      predictions: (payload.predictions || []).map((p) => ({ label: p.label, confidence: p.confidence })),
      modelId: payload.model_id,
      modelVersion: payload.model_version,
      mode: 'online',
    };
  }

  async function tmInfer(which, canvas) {
    await loadTmRuntime();
    if (typeof tmImage === 'undefined') {
      throw coded('offline_unavailable', 'The offline model runtime did not load.');
    }

    const url = tmUrl(which);
    const base = url.endsWith('/') ? url : `${url}/`;

    let model = tmModels.get(base);
    if (!model) {
      model = await tmImage.load(`${base}model.json`, `${base}metadata.json`);
      tmModels.set(base, model);
    }

    const raw = await model.predict(canvas);
    return {
      // TM classes are not guaranteed to match `diseases.code`; the rice model
      // says `rice_*` where the database says `palay_*`.
      predictions: raw.map((p) => ({
        label: Core.normalizeLabel(p.className),
        confidence: p.probability,
      })),
      modelId: `teachable-machine:${base}`,
      modelVersion: 'local',
      mode: 'offline',
    };
  }

  /**
   * Run one gate layer: gateway first, Teachable Machine second. Returns null
   * when neither is configured, so the caller chooses the documented fallback.
   */
  async function runGate(which, prepared, cropCode, threshold) {
    const stage = which === 'shape' ? 'shape_gate' : 'texture_gate';
    let raw = null;

    if (gatewayReady()) {
      try {
        raw = await gatewayInfer(stage, prepared.analysis, cropCode);
      } catch (err) {
        // A missing model or a dead network is not fatal for a gate: the
        // offline model or the heuristic can still answer.
        if (err.code !== 'model_not_configured' && err.code !== 'network') throw err;
      }
    }

    if (!raw && tmReady(which)) raw = await tmInfer(which, prepared.analysis);
    if (!raw) return null;

    return which === 'shape'
      ? Core.evaluateModelGate(raw.predictions, threshold)
      : Core.evaluateTextureGate(raw.predictions, threshold);
  }

  /* ------------------------------------------------------------------ *
   * Label matching
   * ------------------------------------------------------------------ */
  const norm = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]/g, '');

  /**
   * A trained model does not always use our crop code as its class prefix. The
   * palay classifier was trained with `rice_*` classes, which would never match
   * `palay_*` rows — the result would render a raw label with no guidance.
   * Normalise the prefix once, so a single lookup path covers both spellings.
   */
  const CROP_PREFIX_ALIAS = { rice: 'palay' };

  function cropPrefixAlias(label) {
    const m = /^(rice|palay)[_\s-]/i.exec(label);
    if (!m) return null;
    const want = CROP_PREFIX_ALIAS[m[1].toLowerCase()];
    return want ? want + label.slice(m[1].length) : null;
  }

  /**
   * Map a model class label onto a reference disease row.
   * Matches on code, on full name, and on the leading name segment, because
   * model exports vary ("tomato_early_blight", "Early Blight", "Early_Blight").
   */
  function resolveDisease(label, cropCode, refs) {
    const raw = String(label || '');
    const pool = (refs || []).filter((d) => !cropCode || d.crop_code === cropCode);

    const targets = [norm(raw)];
    const alias = cropPrefixAlias(raw);
    if (alias) targets.push(norm(alias));

    for (const target of targets) {
      if (!target) continue;
      const hit =
        pool.find((d) => norm(d.code) === target) ||
        pool.find((d) => norm(d.code) === norm(cropCode + target)) ||
        pool.find((d) => norm(d.name) === target) ||
        pool.find((d) => norm(d.name).startsWith(target) && target.length >= 4) ||
        pool.find((d) => target.startsWith(norm(d.code)));
      if (hit) return hit;
    }

    return null;
  }

  /* ------------------------------------------------------------------ *
   * Pipeline
   * ------------------------------------------------------------------ */

  /**
   * @param {File}   file
   * @param {string} cropCode  'tomato' | 'palay' — declared by the user
   * @param {(stage:string, detail?:object)=>void} onStage
   */
  async function run(file, cropCode, onStage) {
    const emit = (s, d) => { try { onStage && onStage(s, d); } catch (e) { /* UI error must not break the run */ } };

    emit('prepare');
    const prepared = await ImageQuality.prepare(file);
    const metrics = ImageQuality.measure(prepared.analysis);

    /* 1. Quality ------------------------------------------------------- */
    emit('quality', metrics);
    const quality = Core.evaluateQuality(metrics);
    if (!quality.ok) {
      return {
        status: 'retake',
        reason: quality.issues[0],
        issues: quality.issues,
        quality: { ok: false, metrics },
        prepared,
      };
    }

    /* 2. Framing ------------------------------------------------------- *
     * A leaf that is present but off-centre is a bad photo, not a wrong
     * subject. Ask for a retake before spending a model call on it.       */
    const framing = Core.evaluateFraming(metrics);
    if (!framing.ok) {
      return {
        status: 'retake',
        reason: framing.reason,
        issues: [framing.reason],
        quality: { ok: true, metrics },
        prepared,
      };
    }

    /* 3. Layer 1 — shape: is this a plant or leaf at all? ---------------- */
    emit('shape');
    let shape;
    try {
      shape = await runGate('shape', prepared, cropCode, AI_CONFIG.shapeThreshold);
    } catch (err) {
      if (err.code !== 'offline_unavailable') throw err;
    }

    if (!shape) {
      // Documented heuristic: four independent signals, hard floors, and an
      // explicit provenance flag so the UI can say it is not a trained model.
      shape = { ...Core.evaluateCropGate(metrics, 0.55), provenance: 'heuristic_fallback' };
    }

    if (!shape.pass) {
      return {
        status: 'rejected',
        reason: 'not_a_crop',
        quality: { ok: true, metrics },
        gate: shape,
        shape,
        prepared,
      };
    }

    /* 4. Layer 2 — texture: leaf surface, not a wall or a floor ---------- */
    emit('texture');
    let texture;
    try {
      texture = await runGate('texture', prepared, cropCode, AI_CONFIG.textureThreshold);
    } catch (err) {
      if (err.code !== 'offline_unavailable') throw err;
    }

    if (!texture) {
      texture = { ...Core.evaluateTextureHeuristic(metrics, AI_CONFIG.textureThreshold), provenance: 'heuristic_fallback' };
    }

    if (!texture.pass) {
      return {
        status: 'rejected',
        reason: 'not_leaf_texture',
        quality: { ok: true, metrics },
        gate: texture,
        shape,
        texture,
        prepared,
      };
    }

    /* 5. Layer 3 — disease inference ------------------------------------ */
    if (!canRunDisease(cropCode)) {
      return {
        status: 'unconfigured',
        reason: 'model_not_configured',
        quality: { ok: true, metrics },
        gate: shape,
        shape,
        texture,
        prepared,
      };
    }

    emit('disease');
    const refs = await Store.diseases();

    let raw;
    try {
      if (gatewayReady()) raw = await gatewayInfer('disease', prepared.analysis, cropCode);
      else raw = await tmInfer(cropCode, prepared.analysis);
    } catch (err) {
      /* A dead connection is the whole reason the on-device model exists.
       * Falling back only on `model_not_configured` meant that with a gateway
       * URL set, an offline scan failed outright instead of using the local
       * model — the opposite of the documented order. */
      const canFallBack =
        (err.code === 'model_not_configured' || err.code === 'network') && tmReady(cropCode);
      if (!canFallBack) throw err;
      raw = await tmInfer(cropCode, prepared.analysis);
    }

    if (!raw.predictions.length) {
      throw coded('no_predictions', 'The model returned no result for this photo. Try again with a clearer shot.');
    }

    /* 6. Normalise ----------------------------------------------------- */
    const distribution = Core.normalizePercentages(raw.predictions);
    if (!distribution.length) {
      throw coded('no_predictions', 'The model returned no usable result for this photo.');
    }

    const top = distribution[0];
    const band = Core.confidenceBand(top.raw, AI_CONFIG);
    const matched = resolveDisease(top.label, cropCode, refs);

    const predictions = distribution.map((p) => {
      const ref = resolveDisease(p.label, cropCode, refs);
      return {
        label: ref ? ref.name : p.label,
        rawLabel: p.label,
        code: ref ? ref.code : null,
        raw: p.raw,
        pct: p.pct,
        rank: p.rank,
      };
    });

    /* Uncertain results are reported, never saved as a diagnosis. */
    if (band === 'low') {
      return {
        status: 'uncertain',
        reason: 'low_confidence',
        quality: { ok: true, metrics },
        gate: shape,
        shape,
        texture,
        crop: cropCode,
        predictions,
        top: predictions[0],
        topConfidence: top.raw,
        band,
        model: { id: raw.modelId, version: raw.modelVersion, mode: raw.mode },
        prepared,
      };
    }

    return {
      status: 'ok',
      quality: { ok: true, metrics },
      gate: shape,
      shape,
      texture,
      crop: cropCode,
      predictions,
      top: predictions[0],
      topConfidence: top.raw,
      band,
      disease: matched,
      isHealthy: matched ? matched.is_healthy : false,
      model: { id: raw.modelId, version: raw.modelVersion, mode: raw.mode },
      prepared,
    };
  }

  function coded(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  return { run, gatewayReady, tmReady, canRunDisease, canRunGate, resolveDisease };
})();
