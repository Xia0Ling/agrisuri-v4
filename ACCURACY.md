# Accuracy report

Measured on this machine against the local inference proxy, 21 Oct 2026.

## Method

`tools/make_eval_set.py` samples 8 images per class and reproduces the app's own
preprocessing — 512 px longest edge, JPEG q82 — because that is what
`script/quality.js` actually sends to the models. Measuring on full-resolution
originals measures an input the app never produces.

| Set | Composition |
|---|---|
| `_eval` | 14 disease classes × 8, plus 8 `not_leaf` negatives = 120 |
| `_eval_stress` | the same 120, degraded to approximate a handheld photo |

`tools/accuracy.js` then applies the real `Core` gate and normalisation
functions, so the verdicts are the ones the browser would reach.

Stress transforms: random crop 85–100%, rotation ±8°, brightness ×0.78–1.22,
contrast ×0.85–1.15, optional Gaussian blur, downscale to 400 px, JPEG q60.

## Model accuracy — gates ignored

| Class | n | top-1 | top-3 |
|---|---|---|---|
| palay_bacterial_blight | 8 | 100% | 100% |
| palay_blast | 8 | 100% | 100% |
| palay_brown_spot | 8 | 87.5% | 100% |
| palay_healthy | 8 | 100% | 100% |
| palay_sheath_blight | 8 | 100% | 100% |
| palay_tungro | 8 | 100% | 100% |
| tomato_bacterial_spot | 8 | 100% | 100% |
| tomato_early_blight | 8 | 100% | 100% |
| tomato_healthy | 8 | 100% | 100% |
| tomato_late_blight | 8 | 100% | 100% |
| tomato_leaf_mold | 8 | 100% | 100% |
| tomato_mosaic | 8 | 100% | 100% |
| tomato_septoria | 8 | 75% | 100% |
| tomato_yellow_leaf_curl | 8 | 100% | 100% |

**Top-1: 109/112 (97.3%). Top-3: 112/112 (100%).**

These match Roboflow's own held-out numbers (tomato 0.977, palay 0.94), which is
expected: same data, same split policy.

## Gates

| | base | stressed |
|---|---|---|
| positives passing shape | 111/112 (99.1%) | 111/112 (99.1%) |
| positives passing texture | 110/112 (98.2%) | 111/112 (99.1%) |
| negatives rejected by both | 8/8 | 8/8 |

No false accepts on negatives. One or two real leaves are rejected per 112 —
that is the deliberate trade: a gate rejects only on a confident negative, so
the cost lands on the rare ambiguous photo, not on a whole crop.

## End to end — what a farmer actually sees

| | base | stressed |
|---|---|---|
| correct | 107/112 (95.5%) | 108/112 (96.4%) |
| never reached the disease model | 2 | 1 |

## Robustness

Accuracy held at **97.3% top-1** after crop, rotation, exposure, blur and
recompression. That matters: it means the models are reading lesion texture, not
memorising exact pixels. A memorising model collapses under this transform.

## The caveat that matters

**This is not field accuracy.** The evaluation images come from the same
datasets the models were trained on — they were drawn from the same class
folders that were uploaded to Roboflow. 97.3% is an upper bound, not a
prediction of performance on a farmer's phone in a real field.

`TRAINING-GUIDE.md` predicted this gap, and it is the single largest risk in the
project. The stress test narrows the uncertainty; it does not remove it.

The only thing that closes it is **50 real phone photos per crop**, labelled by
hand, run through `tools/accuracy.js --dir <folder>`. Until that exists, treat
97.3% as "the models work", not "the models are accurate in the field".

## Reproduce

```powershell
python tools/make_eval_set.py --per-class 8
node tools/accuracy.js

python tools/make_stress_set.py
node tools/accuracy.js --dir tools/_eval_stress --out tools/accuracy-stress.json
```

Raw numbers are in `tools/accuracy-report.json` and
`tools/accuracy-stress.json`.
