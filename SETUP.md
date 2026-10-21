# AgriSuri — setup and operating notes

A crop-disease detection prototype for **Peñaranda, Nueva Ecija**. Static front
end, Supabase for auth/data/storage, and a server-side Edge Function that holds
the Roboflow key.

**No build step.** Everything is plain HTML/CSS/JS served as files.

---

## 1. What works right now

| Area | State |
| --- | --- |
| Landing page, auth, routing | Working |
| Farmer registration (max **10**), Admin (max **6**), DA Officer (max **5**) | Working once the schema is applied |
| Developer-mode staff registration with an access key | Working |
| Farmer dashboard, scan UI, history, analytics | Working |
| Staff console (Admin + DA Officer), charts, tables, account management, audit | Working |
| English ↔ Filipino toggle (farmer app + auth) | Working |
| Weather card (current, feels-like, high/low, next 6 hours) | Working, Open-Meteo |
| Image quality gate (brightness / clipping / focus / texture) | Working, measured from real pixels |
| Layer 1 — shape gate (plant or not) | Wired — model if configured, otherwise a documented heuristic |
| Layer 2 — texture gate (leaf surface or not) | Wired — model if configured, otherwise edge-density heuristic |
| **Layer 3 — disease inference** | **Not connected** — see step 5 |
| **Sample data for charts** | **On** — clearly badged, client-side only |

Nothing is written to the database by the sample-data mode, and no fake scan is
ever saved. Turn it off with `DEMO_DATA.enabled = false` in `script/config.js`
once real scans start arriving.

---

## 2. Database (required, do this first)

> **New here? Follow `START-HERE.md` instead.** It is a numbered walkthrough with
> a check after every step. This section is the summary.

The reference Supabase project still has the **v3** schema, whose `scans` table
has different columns. `schema.sql` refuses to run against it.

**Supabase note:** pgcrypto is installed in the `extensions` schema, not `public`.
Every function in `schema.sql` pins `set search_path = public, extensions`; if you
see `42883: function digest(text, unknown) does not exist`, you are running an
older copy of the file.

1. Confirm the v3 tables are empty:
   ```sql
   select count(*) from public.profiles;
   select count(*) from public.scans;
   ```
2. If both are `0`, run **`sql/reset.sql`** once. If not, export them first.
3. Run **`sql/schema.sql`** in the SQL editor. Idempotent, safe to re-run.
4. Check Storage → Buckets: `crop-images` should exist, private, 10 MB limit.

### Account limits

| Role | Maximum | Enforced by |
| --- | --- | --- |
| Farmer | 10 | `enforce_role_cap` trigger, under an advisory lock |
| Admin | 6 | same |
| DA Officer | 5 | same |

The limits are transaction-safe: two simultaneous sign-ups cannot both take the
last slot. The signup form shows a specific message when a slot is full.

---

## 3. Accounts

### Farmers
Self-register at `auth.html` with name, barangay and password. A barangay is
required by the form; the trigger validates that it exists.

### Staff (Admin / DA Officer)
Staff never self-register silently. On `auth.html`, click the **Developer mode**
button in the bottom-right corner. The form switches to a staff registration:

1. Pick **Admin Officer** or **DA Officer**.
2. Enter the access code.
3. Fill in name, email, password.

The role is decided by the database. The claimed role must match the key that
was entered, and only a SHA-256 hash of each key is stored — a leaked client
bundle reveals nothing.

**Default access keys** (change these before any real deployment):

| Role | Code |
| --- | --- |
| Admin Officer | `AGRI-ADMIN-2026` |
| DA Officer | `AGRI-OFFICER-2026` |

Rotate or disable a key with:

```sql
update public.staff_keys
   set key_hash = encode(digest('NEW-CODE-HERE', 'sha256'), 'hex')
 where role = 'admin';

-- or disable it entirely
update public.staff_keys set active = false where role = 'da';
```

A DA Officer registering with a key is assigned to the first jurisdiction
(Peñaranda). An admin can move them later from **Accounts → Role**.

### Bootstrap the very first admin
Sign up as a farmer, then:

```sql
update public.profiles set role = 'admin'
 where id = (select id from auth.users where email = 'you@example.com');
```

Sign out and back in. The Accounts section appears.

---

## 4. Run it locally

```bash
python -m http.server 5173
# open http://localhost:5173/landing.html
```

Opening the files with `file://` breaks the service worker and the camera flow.
Use a local server.

---

## 5. Connect the detection layers

Three layers run in a fixed order. Each one can reject the photo, and a rejection
never reaches the next layer:

| Layer | Question | Stage id | Rejection |
|---|---|---|---|
| 1. Shape | Is this a plant or a leaf at all? | `shape_gate` | `not_a_crop` |
| 2. Texture | Is the surface a leaf, not a wall/floor/fabric? | `texture_gate` | `not_leaf_texture` |
| 3. Disease | Which disease does this leaf have? | `disease` | `uncertain` if confidence is low |

Two supported paths. The client detects which is configured.

### Option A — server-side gateway (recommended)

```bash
supabase functions deploy infer
supabase secrets set \
  ROBOFLOW_API_KEY=rf_xxx \
  ROBOFLOW_SHAPE_GATE=your-workspace/leaf-shape/2 \
  ROBOFLOW_TEXTURE_GATE=your-workspace/leaf-texture/2 \
  ROBOFLOW_DISEASE_TOMATO=your-workspace/tomato-disease/5 \
  ROBOFLOW_DISEASE_PALAY=your-workspace/palay-disease/4
```

Then set `AI_CONFIG.gatewayUrl` in `script/config.js`.

The function verifies the caller's JWT, checks the profile is an active farmer,
rate-limits to 12 requests/minute, and reports `model_not_configured` honestly
when a secret is missing. `ROBOFLOW_CROP_GATE` is still accepted as a legacy
alias for the shape layer.

**Class labels must match the seed data.** Labels are matched against
`diseases.code` or `diseases.name`, ignoring case, spaces and punctuation, so
`tomato_early_blight`, `Early Blight` and `Early_Blight` all resolve.

For the two gates the label semantics matter more than the name:

- Shape model classes: `plant` / `not_plant` (or `leaf` / `not_leaf`).
- Texture model classes: `leaf_texture` / `wall`, `floor`, `fabric`, `paper`,
  `skin`, `background`. Anything matching `wall|floor|paper|fabric|metal|wood|
  skin|background|not_leaf` is treated as a negative.

### Option B — offline Teachable Machine

Export three models from Teachable Machine (Image Project, standard 224px):

1. **Shape** — classes `plant`, `not_plant`. Include leaves, whole plants, and
   negatives: hands, soil, sky, tools.
2. **Texture** — classes `leaf_texture`, `wall`, `floor`, `fabric`, `paper`.
   Shoot all of them at leaf distance, in the same lighting.
3. **Disease** — one model per crop (`tomato`, `palay`) using the same class
   names as `diseases.code`.

Upload each export and set the folder URLs in `script/config.js`:

```js
const AI_CONFIG = {
  tmShapeGate: 'https://teachablemachine.withgoogle.com/models/xxxx/',
  tmTextureGate: 'https://teachablemachine.withgoogle.com/models/yyyy/',
  tmDiseaseTomato: 'https://teachablemachine.withgoogle.com/models/zzzz/',
  tmDiseasePalay: 'https://teachablemachine.withgoogle.com/models/wwww/',
  shapeThreshold: 0.70,
  textureThreshold: 0.60,
};
```

Until a path is configured, the Scan tab shows **Model status: Not set** and a
completed scan returns a labelled sample result instead of a prediction. When
only the gates are missing, the documented heuristic stands in and the result
payload says `provenance: heuristic_fallback`.

---

## 6. Sample data

`script/demo.js` produces deterministic sample figures so the interface can be
reviewed before any real scans exist.

- Only used when the database returns **zero** scans for the period.
- Every affected card shows a **Sample data** badge; scan rows are marked too.
- Sample results are never saved, and the Save button is replaced by a note.
- Nothing in `demo.js` calls Supabase (there is a test for this).

Turn it off in `script/config.js`:

```js
const DEMO_DATA = { enabled: false, badge: 'Sample data' };
```

---

## 7. Language

`script/i18n.js` holds the English and Filipino dictionaries. The toggle is in
the farmer app's top bar and on the auth page. The choice is stored in
`localStorage` and survives reloads.

Static text uses `data-i18n="key"`; anything rendered from JavaScript calls
`t('key')`. Switching language re-applies the dictionary and fires `agri:lang`
so the pages re-render their dynamic sections.

The staff console is English only — it is an internal tool, not farmer-facing.

---

## 8. Tests

```bash
node --test tests/core.test.js tests/integrity.test.js   # no dependencies
node --test tests/dom.test.js                            # needs jsdom
node tests/browser.smoke.js                              # needs puppeteer-core + Chrome
```

- `core.test.js` — percentage normalisation (always sums to 100), quality
  thresholds, crop-gate decisions, timezone bucketing, zero-filled series.
- `integrity.test.js` — assets exist, no secrets in client code, element ids
  match, RLS/cap/jurisdiction policies present, account caps are 10/6/5, sample
  data never touches the database, responsive guard rails.
- `dom.test.js` — executes the real page scripts in jsdom: dashboards, weather,
  language toggle, developer-mode registration, DA scoping.

---

## 9. Security model

| Concern | Where it is enforced |
| --- | --- |
| Reading another farmer's scans | RLS `scans_select` — owner only |
| A DA Officer reading another municipality | RLS requires `jurisdiction_id = my_jurisdiction()` |
| Reading images outside scope | Storage policy joins `scans` on `image_path` + jurisdiction |
| Self-promotion to admin | Role must match a hashed access key or a one-time invite |
| Editing your own role | Column-level `UPDATE` grant excludes `role`, `jurisdiction_id`, `is_active` |
| 11th farmer / 7th admin / 6th officer | `enforce_role_cap` under an advisory lock |
| Forging audit entries | `INSERT` revoked; only security-definer RPCs write there |
| Precise farm location leaking | Coordinates rounded to 3 decimals (~110 m) server-side |
| Roboflow key leaking | Held only in the Edge Function environment |

Hiding a button is never the control. The DA Officer console hides the Accounts
and Audit sections, and the database would refuse those queries anyway.

---

## 10. Known limitations

- **No front-end framework.** Deliberately. A build step would break the service
  worker precache, plain static hosting and the jsdom test harness, for no
  functional gain.
- **Crop gate heuristic.** Without a trained gate model the gate combines
  vegetation fraction, centre-of-frame vegetation, green-hue share and texture
  density, with hard floors. The UI labels its provenance.
- **Staff console is English only.**
- **Training data** is stored but not used. `training_candidates` exists for a
  reviewed-labelling workflow; AI predictions are never treated as ground truth.
- **No offline writes while logged out.** The queue is per-user and flushes only
  when that user's session is valid.
