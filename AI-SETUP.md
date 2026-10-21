# AI setup — three-layer detection

This is the operational guide for connecting the models. The code is already
wired; this file is what you do outside the repo.

---

## How a scan flows

```
farmer picks crop (tomato | palay)
        │
        ├── Upload photo (device gallery / files)
        └── Take photo  → phone: native camera app
                        → desktop: in-page live preview with a guide box
        │
        ▼
0. Quality      brightness · clipping · focus · detail      → retake if bad
1. Framing      is the leaf under the guide?                → retake if off-centre
2. Layer 1      shape: plant / leaf vs everything else      → reject if not a plant
3. Layer 2      texture: leaf surface vs wall/floor/fabric  → reject if not a leaf
4. Layer 3      disease classifier for the chosen crop      → result
```

Rules that are enforced in code, not just copy:

- A retake never counts as a scan. Nothing is saved, no model is called.
- A rejection never reaches the next layer.
- Low-confidence disease results are shown as "uncertain" and are never saved.
- If a gate model is missing, the documented heuristic runs and the result
  payload records `provenance: heuristic_fallback`.

---

## Step 0 — Prerequisites

- Supabase project with `sql/schema.sql` applied. Project ref:
  `romlxfchyvjbwuzsgoqq` (from `script/config.js`).
- Supabase CLI **installed** — done on this machine, v2.121.0
  (`npm i -g supabase` if it ever needs reinstalling).
- Supabase CLI **logged in** — `supabase login`. Opens a browser once and stores
  a token in `~/.supabase/access-token`. This is not the anon key and has nothing
  to do with the running app; it only authorises deploys.
- Roboflow account (free tier is enough for the pilot).
- Training images — see Step 1. A phone and a real leaf are only needed for the
  field test at the end.

Verify the login took:

```bash
supabase projects list
```

If it prints your project, you are set. `supabase link` is **not** required —
every command below takes `--project-ref` instead, which skips the database
password prompt.

---

## Step 1 — Collect photos

Shoot in the same conditions the app will see: daylight, one leaf, phone at
20–40 cm, no flash. If you cannot shoot your own yet, use the public sources
below — but read the warning about backgrounds first.

| Layer | Images | Classes | Notes |
|---|---|---|---|
| 1. Shape | 300–600 | `plant`, `not_plant` | 60% leaves/whole plants, 40% negatives: hand, soil, sky, tool, wall, person, shadow |
| 2. Texture | 400–800 | `leaf_texture`, `wall`, `floor`, `fabric`, `paper` | All shot at leaf distance. `leaf_texture` must include veins, disease spots, both leaf sides |
| 3a. Tomato disease | 200–400 per class | see table below | Balanced. Include `tomato_healthy` |
| 3b. Palay disease | 200–400 per class | see table below | Balanced. Include `palay_healthy` |

### Where to get the images

| Source | Use it for | Coverage | Caveat |
|---|---|---|---|
| **PlantVillage** (`plantvillage.psu.edu`, Kaggle mirrors ~54k images) | tomato layer 3 | 8 of your 8 tomato classes | **Lab background.** Nearly every image is a leaf on a uniform grey/white surface |
| **Mendeley — Rice Leaf Disease Image Samples** (`data.mendeley.com/datasets/fwcj7stb8r/1`) | palay layer 3 | 5,932 images: bacterial blight 1,584 · blast 1,440 · brown spot 1,600 · tungro 1,308 | No `healthy`, no sheath blight. Field photos, mixed framing |
| **Kaggle — Rice Leaf Diseases** (`kaggle.com/datasets/vbookshelf/rice-leaf-diseases`) | palay layer 3 supplement | 3 classes, ~120 images | Too small to train on alone; useful as a test set |
| **Roboflow Universe** (`universe.roboflow.com`) | all layers, especially layer 1/2 negatives | thousands of forked datasets | Check each dataset's licence before commercial use |
| **DTD — Describable Textures Dataset** | layer 2 negatives | `brick`, `marble`, `paper`, `woven`, `wood`, `cobwebbed` | Research licence; texture crops, not full scenes |
| **IRRI Rice Knowledge Bank** | reference / validation only | excellent disease photography | **© IRRI. Do not scrape it for training.** Ask IRRI for permission or for the dataset behind their apps |

### The trap you must not fall into

PlantVillage is photographed on a lab bench. Train layer 1 or layer 2 on it and
the model learns **"grey background = leaf"**, not leaf shape or leaf texture.
In the field, a leaf held over concrete looks exactly like a PlantVillage
negative. This is the single most common reason these projects fail in the field.

Rules:

- **Layer 3** may use PlantVillage. It only needs disease texture.
- **Layers 1 and 2 must never be trained on whole PlantVillage frames.** Use
  tight 224×224 crops of the leaf interior instead, so no background survives.
- Layer 1 negatives must come from real scenes: walls, floors, hands, soil, sky.
  Fork a Roboflow Universe classification dataset for each, or crop from COCO.

### Building layer 2 without a camera

Use `tools/prepare_datasets.py` — it cuts 224×224 interior patches from leaf
photos, filters out background, and writes one folder per class ready to zip and
upload. Full walkthrough in `TRAINING-GUIDE.md`.

`leaf_texture` positives = random 224×224 crops from the interior of leaf photos
(PlantVillage close-ups and the Mendeley rice images both work once cropped).
Negatives = same-size crops of brick, concrete, paper, fabric, wood.

Match the crop size to what the phone sees at 20–40 cm, not the full-resolution
original. A wall downscaled to 224 px looks nothing like a wall photographed at
leaf distance, and the model will learn the wrong cue.

### Filling the gaps

- `palay_healthy` and `palay_sheath_blight` are not in the Mendeley set. Search
  Roboflow Universe for `rice sheath blight`; if nothing usable exists, either
  drop the class from the model (it will never be predicted, which is honest) or
  collect ~100 photos yourself later.
- `tomato_healthy` is well covered by PlantVillage.

Layer 3 class names **must equal `diseases.code`** in `sql/schema.sql`:

```
tomato_healthy            tomato_early_blight      tomato_late_blight
tomato_leaf_mold          tomato_septoria          tomato_bacterial_spot
tomato_yellow_leaf_curl   tomato_mosaic

palay_healthy             palay_blast              palay_brown_spot
palay_bacterial_blight    palay_sheath_blight      palay_tungro
```

Label matching is tolerant (`Early Blight`, `early-blight`, `tomato_early_blight`
all resolve), but using the code exactly removes any ambiguity.

---

## Step 2 — Layer 1: shape model (Roboflow)

1. Roboflow → **Create Project** → type **Classification** (single-label).
2. Name it `leaf-shape`.
3. Upload the layer-1 images, assign `plant` / `not_plant`.
4. **Train** → start with *Fast*, switch to *Accurate* for the final version.
5. Check the confusion matrix. `not_plant` false negatives are the dangerous
   case: a wall must not be called a plant.
6. **Deploy** → note the project slug and version: `your-workspace/leaf-shape/3`.

The secret accepts `workspace/project/version` **or** `project/version`. The
gateway tries `classify.roboflow.com/{project}/{version}` first, then the
workspace-prefixed form, because the workspace-less route is the one that answers
on current accounts.

**Use the slug the trained model reports, not the project URL.** Renaming a
project after training does not move the model: the model keeps answering under
the old slug, and a secret built from the new URL returns 405. Check
`trainings[].modelIds` in `https://api.roboflow.com/{workspace}/{project}/{version}?api_key=…`
if a 405 confuses you.

---

## Step 3 — Layer 2: texture model (Roboflow)

Same procedure, project `leaf-texture`, classes `leaf_texture`, `wall`, `floor`,
`fabric`, `paper`.

Why this layer exists: a wall shot at an angle has a plant-like silhouette and
can pass layer 1. Colour is not a safe signal either — a green painted wall
beats a "is it green" test. Edge/vein structure is the discriminator.

Label contract used by `Core.evaluateTextureGate`:

- positive: label matches `leaf|leaves|foliage|plant|vegetation|vein`
- negative: label matches `wall|concrete|cement|brick|floor|ground|pavement|paper|fabric|cloth|metal|wood|skin|hand|background|not_leaf|non_leaf|other`

The negative test runs first, so `not_leaf` can never pass.

---

## Step 4 — Layer 3: disease models (Roboflow)

Two separate projects, one per crop: `tomato-disease` and `palay-disease`.
Use the class names from Step 1. Train, then note both model ids.

Keep `tomato_healthy` / `palay_healthy` in the class list. Without a healthy
class the model is forced to name a disease for every leaf.

---

## Step 5 — Deploy the gateway

The Roboflow key never reaches the browser. The Edge Function holds it.

```bash
# once
supabase login

# secrets first — the function reads them at request time
supabase secrets set --project-ref romlxfchyvjbwuzsgoqq \
  ROBOFLOW_API_KEY=rf_xxxxxxxxxxxx \
  ROBOFLOW_SHAPE_GATE=your-workspace/leaf-shape/3 \
  ROBOFLOW_TEXTURE_GATE=your-workspace/leaf-texture/2 \
  ROBOFLOW_DISEASE_TOMATO=your-workspace/tomato-disease/5 \
  ROBOFLOW_DISEASE_PALAY=your-workspace/palay-disease/4

# then the function
supabase functions deploy infer --project-ref romlxfchyvjbwuzsgoqq
```

PowerShell uses a backtick instead of `\` for line continuation:

```powershell
supabase secrets set --project-ref romlxfchyvjbwuzsgoqq `
  ROBOFLOW_API_KEY=rf_xxxxxxxxxxxx `
  ROBOFLOW_SHAPE_GATE=your-workspace/leaf-shape/3
```

Verify a secret landed (values are not printed, only names):

```bash
supabase secrets list --project-ref romlxfchyvjbwuzsgoqq
```

No CLI available? Both steps have dashboard equivalents: **Edge Functions →
Deploy a new function → Via Editor** (paste `index.ts`), and **Project Settings →
Edge Functions → Secrets**. Same result.

---

## Step 6 — Point the client at it

`script/config.js`:

```js
const AI_CONFIG = {
  gatewayUrl: 'https://<your-project-ref>.supabase.co/functions/v1/infer',
  ...
};
```

Reload the app → **Scan → Model status** should show *Online gateway:
Configured*. If it shows *Not set*, the URL is empty or has a typo.

The URL is absolute and cross-origin, so it works unchanged from GitHub Pages,
Cloudflare Pages or localhost. See `DEPLOY.md` for hosting.

The function enforces: valid JWT, active farmer profile, 12 requests/minute,
image size limits. It returns `model_not_configured` honestly when a secret is
missing — it never fabricates a prediction.

---

## Step 7 — Tune the thresholds

In `script/config.js`:

```js
shapeThreshold: 0.70,    // layer 1
textureThreshold: 0.60,  // layer 2
```

- Real leaves rejected as "not a crop" → lower `shapeThreshold` to 0.60.
- Walls passing layer 1 → raise `shapeThreshold` to 0.80 (layer 2 is the net,
  not the primary control).
- Real leaves rejected as "not a leaf surface" → lower `textureThreshold` to 0.50.
- Fabric/paper passing → raise `textureThreshold` to 0.70.

Disease confidence bands are separate (`highConfidence` 0.75, `mediumConfidence`
0.50). Below 0.50 the result is labelled *uncertain* and cannot be saved.

---

## Step 8 — Offline alternative: Teachable Machine

Use this when the field has no reliable data connection. Trade-off: the models
download to the device (~1 MB runtime + model weights), and accuracy is usually
below a properly trained Roboflow model.

Create three **Image Project → Standard** models:

1. `leaf-shape` — classes `plant`, `not_plant`
2. `leaf-texture` — classes `leaf_texture`, `wall`, `floor`, `fabric`, `paper`
3. disease — one model per crop, class names = `diseases.code`

For each: **Export Model → TensorFlow.js → Upload**, then copy the shareable URL
(`https://teachablemachine.withgoogle.com/models/XXXXXXXX/`).

`script/config.js`:

```js
tmShapeGate: 'https://teachablemachine.withgoogle.com/models/AAAA/',
tmTextureGate: 'https://teachablemachine.withgoogle.com/models/BBBB/',
tmDiseaseTomato: 'https://teachablemachine.withgoogle.com/models/CCCC/',
tmDiseasePalay: 'https://teachablemachine.withgoogle.com/models/DDDD/',
```

The client tries the gateway first, then Teachable Machine, then the heuristic.
`Model status` lists each one separately, so you can see exactly what is live.

---

## Step 9 — Acceptance test

Run these on a phone, in daylight, before showing it to a farmer.

| # | Input | Expected |
|---|---|---|
| 1 | Leaf centred, sharp, even light | passes all layers, disease result |
| 2 | Same leaf at the frame edge | **retake**: "Move the leaf into the frame" — no model call, nothing saved |
| 3 | Blurry leaf | **retake**: blur copy |
| 4 | Photo of a wall | layer 2 rejects: "Not a leaf surface" |
| 5 | Photo of a hand / desk | layer 1 rejects: "Not a supported crop" |
| 6 | Leaf in deep shade | **retake**: too dark |
| 7 | Unplug the network, scan again | result comes from the offline path, or a clear error — never a fake diagnosis |
| 8 | Delete `ROBOFLOW_TEXTURE_GATE`, scan a leaf | passes with `provenance: heuristic_fallback`, Model status shows texture *Not set* |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `model_not_configured` | secret missing or malformed | needs `project/version`, or `workspace/project/version` |
| `upstream_error 405` | secret uses the current project URL, but the model answers under its pre-rename slug | read `trainings[].modelIds` and use that slug |
| `upstream_auth` | wrong Roboflow key | regenerate the key, `supabase secrets set` again |
| `upstream_error 404` | wrong project slug or version | open the model in Roboflow → Deploy → copy the exact id |
| Every leaf rejected at layer 2 | texture model trained on whole leaves, not close-ups | retrain on 20–40 cm crops |
| Every wall passes layer 2 | `wall` class too small in the dataset | add 100+ wall images, retrain |
| Disease names show as raw labels | class names don't match `diseases.code` | rename classes, retrain, bump version |
| `uncertain` on everything | model overfit / too few images | add images, retrain with *Accurate* |
