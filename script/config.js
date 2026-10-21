/* ============================================================================
 * AgriSuri — runtime configuration
 *
 * Only public values belong here. The Supabase anon/publishable key is safe in
 * the browser by design; Row Level Security is what protects the data.
 *
 * NEVER put a Roboflow API key, a service_role key, or a staff access code in
 * this file. Inference goes through the `infer` Edge Function, which holds the
 * Roboflow key server-side. Staff access codes are hashed in the database.
 * ========================================================================== */

const SUPABASE_URL = 'https://romlxfchyvjbwuzsgoqq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_5k_uHT-8X6Q6gyxo-6GxMw_X3mCpQ1D';

/*
 * Where inference runs.
 *
 * Production: the Supabase Edge Function holds the Roboflow key, because a
 * static site has nowhere to hide it. Local dev: `tools/serve.js` exposes the
 * same contract at `/api/infer` and reads the key from `tools/roboflow.key`.
 *
 * Loopback and private-range hosts get the local proxy; anything else gets the
 * deployed function. This is why the app needs no per-environment config file.
 */
const IS_LOCAL_DEV =
  typeof location !== 'undefined' &&
  /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
    location.hostname,
  );

const AI_CONFIG = {
  gatewayUrl: IS_LOCAL_DEV
    ? '/api/infer'
    : 'https://romlxfchyvjbwuzsgoqq.supabase.co/functions/v1/infer',

  /*
   * Offline path: public Teachable Machine model URLs (no key required).
   * Each URL must be the model folder — the runtime appends model.json and
   * metadata.json. Three layers, in this order:
   *   1. shape   — plant / leaf vs everything else
   *   2. texture — leaf surface vs wall, floor, paper, skin
   *   3. disease — per-crop disease classifier
   */
  tmShapeGate: '',
  tmTextureGate: '',
  tmDiseaseTomato: '',
  tmDiseasePalay: '',

  /* Layer 1 acceptance threshold on the model's top class. */
  shapeThreshold: 0.70,
  /* Layer 2 acceptance threshold. Higher: a wall can pass shape by accident. */
  textureThreshold: 0.60,

  /* Disease confidence bands. Raw model probabilities are NOT calibrated. */
  highConfidence: 0.75,
  mediumConfidence: 0.50,
};

const APP = {
  timezone: 'Asia/Manila',
  /*
   * Decode guard, not an upload size. The photo is always downscaled to
   * 1280 px before storage, so a large original costs memory, never bandwidth.
   * Modern phone cameras produce 8-20 MB JPEGs; 8 MB rejected most of them
   * before the scan even started.
   */
  maxUploadBytes: 25 * 1024 * 1024,
  /* Coordinates are rounded server-side to 3 decimals (~110 m). */
  coordPrecision: 3,
  /* The pilot municipality. Used for copy and the weather fallback. */
  municipality: 'Peñaranda',
  province: 'Nueva Ecija',
};

/* ============================================================================
 * Sample data (UI preview)
 *
 * No inference model is connected yet, and a fresh database has no scans. This
 * switch lets the interface be reviewed with realistic-looking numbers instead
 * of empty charts.
 *
 * It is honest by construction:
 *   - every affected card carries a visible "Sample data" badge;
 *   - sample results are never written to Supabase;
 *   - sample scans never appear in a real count.
 *
 * Set `enabled: false` once real scans start arriving.
 * ========================================================================== */
const DEMO_DATA = {
  enabled: true,
  badge: 'Sample data',
};

const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
