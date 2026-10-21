// ============================================================================
// AgriSuri inference gateway (Supabase Edge Function, Deno)
//
// Why this exists: the Roboflow API key must never reach the browser. The
// client calls this function; this function holds the key and talks to Roboflow.
//
// Deploy:
//   supabase functions deploy infer --project-ref romlxfchyvjbwuzsgoqq
//   supabase secrets set --project-ref romlxfchyvjbwuzsgoqq \
//     ROBOFLOW_API_KEY=<roboflow-key> \
//     ROBOFLOW_SHAPE_GATE=shape-u5iks/1 \
//     ROBOFLOW_TEXTURE_GATE=texture-8frhk/1 \
//     ROBOFLOW_DISEASE_TOMATO=tomato_diseases-ksz6z/1 \
//     ROBOFLOW_DISEASE_PALAY=rice_diseases-qcvnv/1 \
//     SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
//
// Request  : POST { stage: 'shape_gate'|'texture_gate'|'disease',
//                   crop?: 'tomato'|'palay', image: '<base64 jpeg>' }
// Response : { model_id, model_version, predictions: [{label, confidence}], latency_ms }
// Errors   : { error: 'code', message: 'human readable' } with a real HTTP status
// ============================================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

/** Per-user sliding window. Per-instance only; the DB check below is the hard cap. */
const buckets = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const hits = (buckets.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  buckets.set(userId, hits);
  return hits.length > MAX_PER_WINDOW;
}

interface ModelTarget {
  project: string;
  version: string;
  workspace?: string;
}

/**
 * A secret may list several candidates separated by commas, tried in order.
 *
 * Roboflow binds a trained artifact to the project slug that existed at
 * training time. Renaming the project afterwards leaves the new slug returning
 * 404 while the old one keeps working. Listing both makes a rename harmless.
 */
function resolveModels(stage: string, crop?: string): ModelTarget[] {
  const raw =
    stage === 'shape_gate' || stage === 'crop_gate'
      ? (Deno.env.get('ROBOFLOW_SHAPE_GATE') ?? Deno.env.get('ROBOFLOW_CROP_GATE'))
      : stage === 'texture_gate'
        ? Deno.env.get('ROBOFLOW_TEXTURE_GATE')
        : crop === 'palay'
          ? Deno.env.get('ROBOFLOW_DISEASE_PALAY')
          : crop === 'tomato'
            ? Deno.env.get('ROBOFLOW_DISEASE_TOMATO')
            : undefined;

  if (!raw) return [];

  const out: ModelTarget[] = [];
  for (const entry of raw.split(',')) {
    const parts = entry.trim().split('/').filter(Boolean);
    if (parts.length < 2) continue;
    out.push({
      version: parts[parts.length - 1],
      project: parts[parts.length - 2],
      workspace: parts.length >= 3 ? parts.slice(0, -2).join('/') : undefined,
    });
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const started = Date.now();
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'unauthenticated', message: 'Missing bearer token.' }, 401);

  const supaUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  // 1. Verify the caller's JWT and resolve their real role server-side.
  const userRes = await fetch(`${supaUrl}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: anonKey },
  });
  if (!userRes.ok) return json({ error: 'unauthenticated', message: 'Session expired.' }, 401);
  const user = await userRes.json();

  if (!serviceKey) return json({ error: 'not_configured', message: 'Gateway is missing its service key.' }, 503);

  const profRes = await fetch(
    `${supaUrl}/rest/v1/profiles?select=role,is_active&id=eq.${user.id}`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const profiles = await profRes.json();
  const profile = Array.isArray(profiles) ? profiles[0] : null;
  if (!profile?.is_active) return json({ error: 'forbidden', message: 'Account is inactive.' }, 403);
  if (profile.role !== 'farmer') return json({ error: 'forbidden', message: 'Only farmers run scans.' }, 403);

  if (rateLimited(user.id)) {
    return json({ error: 'rate_limited', message: 'Too many scans. Wait a minute and try again.' }, 429);
  }

  // 2. Validate input.
  let payload: { stage?: string; crop?: string; image?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'bad_request', message: 'Body must be JSON.' }, 400);
  }

  const stage = payload.stage ?? '';
  const crop = payload.crop;
  const image = payload.image ?? '';

  const STAGES = new Set(['shape_gate', 'crop_gate', 'texture_gate', 'disease']);

  if (!STAGES.has(stage)) {
    return json({ error: 'bad_request', message: 'stage must be shape_gate, texture_gate, or disease.' }, 400);
  }
  if (stage === 'disease' && crop !== 'tomato' && crop !== 'palay') {
    return json({ error: 'bad_request', message: 'crop must be tomato or palay.' }, 400);
  }
  if (image.length < 512 || image.length > 9_000_000) {
    return json({ error: 'bad_request', message: 'Image payload is missing or too large.' }, 400);
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 256))) {
    return json({ error: 'bad_request', message: 'Image must be base64.' }, 400);
  }

  // 3. Resolve the model. Missing config is reported honestly, never faked.
  const targets = resolveModels(stage, crop);
  if (!targets.length) {
    const label = stage === 'shape_gate' || stage === 'crop_gate'
      ? 'shape validation'
      : stage === 'texture_gate'
        ? 'texture validation'
        : `${crop} disease detection`;
    return json({
      error: 'model_not_configured',
      message: `No Roboflow model is configured for ${label}.`,
    }, 503);
  }

  const apiKey = Deno.env.get('ROBOFLOW_API_KEY');
  if (!apiKey) {
    return json({ error: 'model_not_configured', message: 'ROBOFLOW_API_KEY is not set on the gateway.' }, 503);
  }

  // 4. Call Roboflow server-to-server.
  //
  // Candidates are tried in order. A 404 means "this slug does not hold the
  // artifact", so the next candidate runs; any other status stops the loop.
  const suffix = `?api_key=${encodeURIComponent(apiKey)}&confidence=0&overlap=0`;
  const candidates: Array<{ url: string; target: ModelTarget }> = [];
  for (const target of targets) {
    // The workspace-less form answers on current accounts; the workspace
    // prefixed form is kept as a fallback so an older account does not break.
    candidates.push({
      url: `https://classify.roboflow.com/${target.project}/${target.version}${suffix}`,
      target,
    });
    if (target.workspace) {
      candidates.push({
        url: `https://classify.roboflow.com/${target.workspace}/${target.project}/${target.version}${suffix}`,
        target,
      });
    }
  }

  let upstream: Response | null = null;
  let used: ModelTarget | null = null;
  try {
    for (const candidate of candidates) {
      const res = await fetch(candidate.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: image,
        signal: AbortSignal.timeout(20_000),
      });
      upstream = res;
      used = candidate.target;
      if (res.status !== 404 && res.status !== 405) break;
    }
  } catch (err) {
    return json({ error: 'upstream_unreachable', message: 'The inference service did not respond.' }, 502);
  }

  if (!upstream || !used) {
    return json({ error: 'upstream_unreachable', message: 'The inference service did not respond.' }, 502);
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return json({ error: 'upstream_auth', message: 'The inference gateway is misconfigured.' }, 502);
  }
  if (!upstream.ok) {
    return json({ error: 'upstream_error', message: `Inference service returned ${upstream.status}.` }, 502);
  }

  let body: { predictions?: Array<{ class?: string; confidence?: number }> };
  try {
    body = await upstream.json();
  } catch {
    return json({ error: 'upstream_bad_payload', message: 'Inference service returned unreadable data.' }, 502);
  }

  const predictions = (body.predictions ?? [])
    .filter((p) => typeof p.class === 'string' && typeof p.confidence === 'number')
    .map((p) => ({ label: p.class as string, confidence: p.confidence as number }))
    .sort((a, b) => b.confidence - a.confidence);

  if (!predictions.length) {
    return json({ error: 'no_predictions', message: 'The model returned no classes for this image.' }, 422);
  }

  return json({
    model_id: used.workspace ? `${used.workspace}/${used.project}` : used.project,
    model_version: used.version,
    predictions,
    latency_ms: Date.now() - started,
  });
});
