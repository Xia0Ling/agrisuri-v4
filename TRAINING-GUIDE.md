# Training guide — from zero to three working models

No camera needed. This is the whole path: get public images, build three
datasets, train three models on Roboflow, connect them to the app.

Read `AI-SETUP.md` for the contract (class names, thresholds, deployment).
This file is the hands-on sequence.

---

## Part 1 — Get the images

Four downloads. Do them in this order; each one has a job.

### 1.1 Tomato diseases — PlantVillage

Kaggle: `abdallahalidev/plantvillage-dataset` (or `emmarex/plantdisease`).
~54,000 images, already sorted into folders like `Tomato___Early_blight`.

You need only the `Tomato___*` folders. Covers all 8 of your tomato classes.

### 1.2 Palay diseases — Mendeley

`https://data.mendeley.com/datasets/fwcj7stb8r/1`

5,932 field photos: Bacterial blight 1,584 · Blast 1,440 · Brown spot 1,600 ·
Tungro 1,308. Real field conditions, which is why this one matters more than it
looks.

Gap: **no `healthy`, no `sheath blight`** in the Mendeley set. The raw "Rice leaf
disease classification" download in `dataset/palay_disease/` fills both — it has
10 classes including `healthy` and `sheath_blight`.

**Use its `Train` split only, and never its `Rice leaf augumention` folder.**
Those are transformed duplicates of the same photos. Training on augmented copies
and validating on originals leaks the answer and inflates accuracy to a number
that means nothing.

`tools/arrange_palay.py` builds the upload-ready set: 6 classes × 500, originals
only, verified readable, zero duplicate files.

### 1.3 Negatives for layer 1 — surfaces and hands

Search Roboflow Universe for `wall texture classification`, `floor texture`,
`hand gesture classification`. Fork one dataset per class into your workspace,
then download as images. You want 150–300 per class.

Alternatives if Universe is thin: **MINC** (Materials in Context, 23 material
classes — brick, concrete, wood, fabric, paper, metal) or any phone photo of a
wall you already have.

### 1.4 Negatives for layer 2 — texture close-ups

Same sources as 1.3. Layer 2 needs them at **leaf distance**, not as wide
scenes — the script centre-crops them to 224 px, so a wide shot of a room is
useless; a close shot of the wall is right.

---

## Part 2 — Build the datasets

The one rule that decides whether this works: **layers 1 and 2 must not be
trained on whole PlantVillage frames.** Those are shot on a lab bench. Train on
them and the model learns "grey background = leaf", which fails the moment a
farmer holds a leaf over soil.

`tools/prepare_datasets.py` does the cropping and folder mapping.

```bash
pip install pillow

# the layout used in this repo (training_images/)
python tools/prepare_datasets.py \
  --leaves training_images/tomato_leaf/color \
  --leaves training_images/rice_leaf \
  --negatives training_images/not_a_plant_or_leaf \
  --collapse-negatives not_leaf \
  --exclude .coco \
  --out dataset \
  --per-class 500
```

`--collapse-negatives` is deliberate. The gates are binary — `evaluateTextureGate`
accepts a label matching `leaf|foliage|vein` and rejects everything else — so 47
separate texture classes would be wasted capacity. One `not_leaf` class is
enough and trains faster.

`--exclude .coco` skips the duplicate COCO export that ships beside the rice
class folders. Without it those 5,932 images are counted twice.

What it writes:

```
dataset/
  disease/tomato_early_blight/...      full images, 640 px max
  disease/tomato_healthy/...
  disease/palay_blast/...
  shape/plant/...                      whole leaf frames
  shape/not_plant/...                  whole negative frames
  texture/leaf_texture/...             224 px interior patches, background-free
  texture/not_leaf/...                 224 px patches, same scale
```

Built from the current `training_images/`: 7,873 images, 152 MB, 500 per class
except `tomato_mosaic` at 373 (that is all PlantVillage has).

| Project | Classes | Count |
|---|---|---|
| `tomato-disease` | 8 | 500 each, 373 mosaic |
| `palay-disease` | 4 | 500 each |
| `leaf-shape` | 2 | 500 each |
| `leaf-texture` | 2 | 500 each |

It prints a count per class and lists any folder it could not map to a
`diseases.code`. Check that list — a typo in a folder name silently drops a whole
class.

Patch filter: a leaf patch is kept only if it has structure (`stddev ≥ 12`) and
colour (`saturation ≥ 40`). Grey bench background fails both. Negatives are
trusted and only centre-cropped — a plain painted wall is a valid negative even
though it is flat and grey.

---

## Part 3 — Train on Roboflow

Three projects. Same procedure each time.

### 3.1 Create the project

`app.roboflow.com` → **Create New Project**

- Project Type: **Classification**
- Multi-label: **off** (each image has exactly one class)
- Name: `leaf-shape`, `leaf-texture`, `tomato-disease`, `palay-disease`

### 3.2 Upload

Easiest reliable method: open one class folder, select all images, drag them in,
and set the class name in the upload dialog. Repeat per class.

If you upload a `.zip`, Roboflow can use folder names as class names — try it,
then **verify the class counts on the dataset page** before training. A silent
mis-assignment here ruins the model and is invisible later.

Target counts:

| Project | Classes | Per class |
|---|---|---|
| `leaf-shape` | `plant`, `not_plant` | 400–600 |
| `leaf-texture` | `leaf_texture`, `wall`, `floor`, `paper`, `fabric` | 300–500 |
| `tomato-disease` | 8 codes from `diseases.code` | 200–400 |
| `palay-disease` | 5 codes you actually have | 300–600 |

### 3.3 Split and train

- Train/valid/test split: **70 / 20 / 10**. Let Roboflow pick randomly.
- Click **Train** → model **Fast** for the first run. It finishes in minutes and
  tells you whether the dataset is sane. Only switch to *Accurate* once the Fast
  run looks reasonable.

### 3.4 Read the result before moving on

Open the confusion matrix. What you are looking for:

- **`leaf-texture`**: `wall` predicted as `leaf_texture` = the app will accept
  walls. Fix by adding wall images, not by lowering the threshold.
- **`leaf-shape`**: `not_plant` → `plant` errors are the dangerous direction.
- **Disease models**: one class absorbing most others means class imbalance or
  mislabeled folders. Recheck the counts, don't retrain blindly.

### 3.5 Deploy the version

**Deploy** → note the model id and version. The secret format is
`workspace/project-slug/version`, e.g. `agrisuri/leaf-texture/2`. All three
parts are required — the gateway splits on the last `/`.

---

## Part 4 — Connect them

Follow `AI-SETUP.md` Step 5 and 6. Short version:

```powershell
supabase secrets set --project-ref romlxfchyvjbwuzsgoqq `
  ROBOFLOW_API_KEY=rf_xxx `
  ROBOFLOW_SHAPE_GATE=agrisuri/leaf-shape/1 `
  ROBOFLOW_TEXTURE_GATE=agrisuri/leaf-texture/1 `
  ROBOFLOW_DISEASE_TOMATO=agrisuri/tomato-disease/1 `
  ROBOFLOW_DISEASE_PALAY=agrisuri/palay-disease/1

supabase functions deploy infer --project-ref romlxfchyvjbwuzsgoqq
```

Then `AI_CONFIG.gatewayUrl` in `script/config.js`, reload, and check
**Scan → Model status**: each row should read *Configured*.

You can wire them one at a time. Configure only the texture gate and the app
still runs: shape falls back to the heuristic, disease stays unconfigured.

---

## Part 5 — What will still be wrong

Be honest with yourself about these before demo day.

1. **Layer 1 trained on lab images is the weakest link.** The heuristic
   (green hue + vegetation ratio) is arguably better at "is there a plant here"
   in daylight than a CNN trained on grey-background leaves. Ship the heuristic
   for layer 1, and train the model once you have 300+ real field photos.
2. **PlantVillage disease accuracy does not transfer.** Expect 95%+ on its own
   split and much lower on a farmer's phone photo. Budget 50 real photos as a
   field test set.
3. **Cross-dataset degradation is measured, not hypothetical.** A 2026 benchmark
   across three Bangladeshi rice datasets found models trained on one collection
   lose substantial accuracy on another.
4. **`palay_healthy` and `palay_sheath_blight` may be missing** from public data.
   A model that cannot output a class is fine; a model that guesses is not.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Script writes 0 disease images | folder names don't match any rule | run with `--crop tomato`/`--crop palay`; check the unmapped list |
| `texture/leaf_texture` mostly grey | saturation filter too low or images aren't close-ups | raise `MIN_SATURATION`; use close-up leaves |
| Roboflow shows one class only | upload assigned every image to the first class | re-upload per folder, verify counts |
| Gateway 404 on scan | wrong project slug/version in the secret | copy the exact id from Deploy |
| Every leaf rejected by layer 2 | texture model trained on whole frames | rebuild with the script, retrain |
| Disease names show as raw labels | classes don't match `diseases.code` | rename classes, bump version, update secret |
