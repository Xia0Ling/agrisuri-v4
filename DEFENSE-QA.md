# AgriSuri — Model Accuracy and Defense Notes

Measured on this machine, 24 Oct 2026, against the exact models the app ships.

---

## 0. Explain it simply (for a demo, or if the panel asks you to dumb it down)

**What the app does:** the farmer takes a photo of one leaf. The app guesses  
which disease it has, and shows how sure it is.

**Three steps happen before any answer appears:**

1. *Is this even a plant?* — a small checker says yes or no.
2. *Does it look like a leaf?* — a second checker says yes or no.
3. *Which disease?* — the model gives every disease a score from 0 to 1, and the  
   highest score wins.

**The only formula you need:**

```
accuracy = (number of correct answers ÷ total number of photos) × 100
```

Example: 109 correct out of 112 photos → 109 ÷ 112 = 0.973 → **97.3%**.

**Two more, in one line each:pu**

- **Top-3** = the right answer was one of the model's top three guesses.
- **End-to-end** = the photo passed both checkers *and* the disease was right.  
  That is 107 ÷ 112 = **95.5%** — the number that matches what the farmer sees.

**Why two numbers exist:** 97.3% is the disease model alone. 95.5% is the whole  
app, including the two checkers that can say "no" before the model speaks.

**What a score of 0.93 means:** the model gave that disease 93% of its total  
belief across all 8 answers. It is not a 93% chance of being right — a model can  
be confidently wrong.

**Why the offline number is lower:** the offline "is it a leaf" checker said  
"not a leaf" 14 times on real leaves. The disease model never got to answer. The  
checker needs more photos of sick leaves so it learns they are still leaves.

---

## 1. Overall accuracy — both models

Test set: **120 photos** = 112 disease photos (14 classes × 8) + 8 non-leaf negatives.

| Measure | Online (Roboflow) | Offline (Teachable Machine) |
|---|---|---|
| Disease top-1 | **97.3%** — 109/112 | **98.2%** — 110/112 |
| Disease top-3 | 100% — 112/112 | — |
| **End-to-end (what the farmer sees)** | **95.5%** — 107/112 | **86.6%** — 97/112 |
| Non-leaf photos refused | 100% — 8/8 | 100% — 8/8 |

**Formulas used above**

```
top-1      = correct ÷ total × 100                  = 109 ÷ 112 × 100 = 97.3%
top-3      = (true answer in top 3 guesses) ÷ total × 100 = 112 ÷ 112 × 100 = 100%
end-to-end = (passed both gates AND class correct) ÷ total × 100
           = 107 ÷ 112 × 100 = 95.5%
refused    = negatives refused ÷ total negatives × 100 = 8 ÷ 8 × 100 = 100%
```

**Say the end-to-end number out loud, not the top-1.** Top-1 is the model in
isolation. End-to-end is the product: gate + model + decision.

## 2. How each number is computed

**Top-1 accuracy** — the predicted class equals the true class.

```
top-1 = (images where predicted == true) / (total images) × 100
      = 109 / 112 × 100 = 97.32%
```

**Top-3 accuracy** — the true class is anywhere in the model's three highest  
scores. Used to show the model is close even when it is wrong.

```
top-3 = (images where true ∈ top 3) / total × 100
```

**End-to-end accuracy** — the photo passed both gates *and* the disease class was  
correct. A photo rejected by a gate counts as a failure even if the model would  
have been right, because the farmer never saw an answer.

```
end-to-end = (gate passed AND predicted == true) / total × 100
           = 107 / 112 × 100 = 95.54%
```

**Negative rejection rate** — of the 8 non-leaf photos, how many the gates  
refused.

```
rejection = refused negatives / total negatives × 100 = 8 / 8 × 100 = 100%
```

**Per-class precision / recall** — if a judge asks for more than accuracy:

```
precision = TP / (TP + FP)      recall = TP / (TP + FN)
F1 = 2 × (precision × recall) / (precision + recall)
```

**Confidence** is the softmax score of the winning class, 0–1. It is *not* a  
probability that the answer is correct — a model can be confidently wrong, and  
this one was: `tomato_septoria` was answered as `tomato_late_blight` with high  
confidence.

---

## 3. Method

- **Same preprocessing as the app**: 512 px longest edge, JPEG q82. Measuring on  
  full-resolution originals would measure an input the app never produces.
- **Same decision logic**: the harness loads `script/lib/core.js` — the identical  
  gate and normalisation functions the browser runs. The numbers are not a  
  re-implementation.
- **Offline** models are the four public Teachable Machine models the app loads  
  (shape, texture, tomato disease, palay disease), run at 224×224 with Teachable  
  Machine's own normalisation (`pixel / 127 − 1`).
- **Online** models are the Roboflow models behind the gateway.

Reproduce:

```
node tools/accuracy.js                                  # online
NODE_PATH=<workspace>/node_modules node tools/offline_accuracy.js   # offline
```

---

## 4. Accuracy per disease — both crops

Each class has 8 test photos.

| Disease | Crop | n | Online | | Offline | |
|---|---|---|---|---|---|---|
| Bacterial Spot | Tomato | 8 | 8/8 | 100.0% | 8/8 | 100.0% |
| Early Blight | Tomato | 8 | 8/8 | 100.0% | 8/8 | 100.0% |
| Late Blight | Tomato | 8 | 8/8 | 100.0% | 8/8 | 100.0% |
| Leaf Mold | Tomato | 8 | 8/8 | 100.0% | 7/8 | 87.5% |
| Mosaic Virus | Tomato | 8 | 8/8 | 100.0% | 8/8 | 100.0% |
| **Septoria Leaf Spot** | Tomato | 8 | **6/8** | **75.0%** | 8/8 | 100.0% |
| Yellow Leaf Curl | Tomato | 8 | 8/8 | 100.0% | 8/8 | 100.0% |
| Healthy (no disease) | Tomato | 8 | 8/8 | 100.0% | 8/8 | 100.0% |
| Bacterial Leaf Blight | Palay | 8 | 8/8 | 100.0% | 8/8 | 100.0% |
| **Rice Blast** | Palay | 8 | 8/8 | 100.0% | **7/8** | **87.5%** |
| **Brown Spot** | Palay | 8 | **7/8** | **87.5%** | 8/8 | 100.0% |
| Sheath Blight | Palay | 8 | 8/8 | 100.0% | 8/8 | 100.0% |
| Tungro | Palay | 8 | 8/8 | 100.0% | 8/8 | 100.0% |
| Healthy (no disease) | Palay | 8 | 8/8 | 100.0% | 8/8 | 100.0% |
| **All 14 classes** | | **112** | **109/112** | **97.3%** | **110/112** | **98.2%** |

**Formula used above**

```
per-class accuracy = correct for that class ÷ photos of that class × 100
overall top-1      = sum of correct ÷ sum of photos × 100
                   = (109) ÷ (112) × 100 = 97.3%   [online]
                   = (110) ÷ (112) × 100 = 98.2%   [offline]
```

Only three classes are below 100%, and they are not the same three on both
paths: online loses septoria (2) and brown spot (1); offline loses leaf mold (1)
and rice blast (1).

## 5. Why offline end-to-end is lower — measured, not guessed

The offline disease models are **better** than the online ones (98.2% vs 97.3%).  
The 86.6% comes from the gate in front of them:

| Failure cause                                 | Count        |
| --------------------------------------------- | ------------ |
| Texture gate said "not a leaf" on a real leaf | 14           |
| Shape gate said "not a plant"                 | 3            |
| Wrong disease class                           | 2            |
| **End-to-end correct**                        | **97 / 112** |

The texture model was trained to separate leaf surface from wall, floor, paper  
and skin. On a leaf covered in lesions it reads the lesions as non-leaf texture  
and refuses. Lowering the threshold does not help — the gate rejects on the  
**label**, not the score, so no threshold recovers those 14.

**This is the honest weakness of the offline path**, and the fix is data, not  
code: retrain the texture model with diseased leaves in the "leaf" class. Until  
then, the app should skip the texture gate when the disease model is confident.

---

## 6. The caveat to state before a judge asks

**The test photos come from the same corpus the models were trained on.**

`dataset/` holds ~6,900 training images (500 per class). `tools/_eval` samples 8  
per class from it and re-encodes them to 512 px. They are the same photographs,  
not held-out ones — zero byte-identical matches only because of re-encoding.

So 97.3% and 98.2% are **training-set accuracy: an upper bound**. They prove the  
pipeline works end to end. They do not prove the model generalises to a new  
farmer's phone.

Say it like this:

> "These numbers are measured on images from our training corpus, so they are an  
> upper bound. What they validate is the whole pipeline — preprocessing, gates,  
> model, decision. A true generalisation number needs a held-out set of photos  
> taken by farmers in the field, and that is the next thing we will measure."

Judges respect that far more than a clean number defended too hard. If asked  
"so what is your real accuracy?", the answer is: **we don't know yet, and here is  
how we will find out.**

---

## 7. Likely questions, with answers

**Q: What is your accuracy?**  
97.3% top-1 online, 98.2% offline, and 95.5% / 86.6% end-to-end once the gates  
are included. End-to-end is the number that describes the product.

**Q: How did you get those percentages?**  
120 photos, 8 per class plus 8 non-leaf negatives, run through the same  
preprocessing and the same decision code the app uses. Top-1 = correct ÷ total.  
End-to-end additionally requires both gates to accept.

**Q: Did you test on training data?**  
Yes — and that makes these numbers an upper bound. They validate the pipeline,  
not generalisation. A held-out field set is the next measurement.

**Q: Why is offline lower if its model is more accurate?**  
The offline texture gate rejects 14 of 112 real leaves as "not a leaf". The  
disease model never gets to answer. That is a gate problem, not a model problem,  
and it is fixable by retraining the gate.

**Q: Why only tomato and palay?**  
Fourteen classes across the two crops with the most complete public datasets.  
Adding a crop means a new dataset, a new classifier and a new gate calibration —  
it is a data problem, not a code change. The architecture already supports it:  
one model per crop, selected automatically.

**Q: What happens if the photo isn't a leaf?**  
Two gates run first — shape, then texture. Both refused all 8 negative photos in  
testing. The farmer gets "this doesn't look like a leaf", not a disease guess.

**Q: What if the photo is blurry or dark?**  
A quality check runs before inference and asks for a retake. The gates also  
refuse low-confidence input. The app never invents an answer to look useful.

**Q: Does it replace an agriculturist?**  
No, and the terms make the farmer acknowledge that before using it: it is a  
guess, it can be wrong, and they agree to consult an expert before acting.

**Q: How does the system get better?**  
Every scan a farmer marks wrong enters a review queue. A DA officer or admin  
checks the barangay and the correction, then approves or rejects it. Approved  
corrections go to their disease class; rejected photos become negative examples  
("not a leaf", "not a supported crop"). Both export as a labelled dataset in the  
folder layout Roboflow and Teachable Machine accept.

**Q: Who can see a farmer's photos?**  
Only that farmer, their DA officer within their jurisdiction, and an admin.  
Enforced by row-level security in the database, not by hiding buttons. Verified:  
an unauthenticated request to the analytics function returns zero rows.

**Q: What if there's no internet?**  
The app runs fully offline: the models are downloaded to the device on first  
load, and scans queue locally until a connection returns. The offline path is  
the 86.6% one — that trade-off is stated in the app.

**Q: How fast is it?**  
Online inference is one round trip to the gateway. Offline runs on the phone's  
CPU with no network at all — slower per scan but works in a field with no signal,  
which is the point.

**Q: Why not use a bigger model?**  
Because it has to run on a farmer's phone, offline, for free. A larger model  
would be more accurate in a lab and unusable in a barangay.

**Q: What is your weakest class?**  
`tomato_septoria` online (75%) — confused with late blight and healthy, which  
look similar in the early stage. That is exactly the confusion a farmer cannot  
resolve alone, so the app reports confidence honestly instead of hiding it.


**Q: How many training images?**  
About 6,900: 500 per class across 14 classes, plus separate sets for the shape  
and texture gates.

**Q: What would you do with more time?**  
Three things, in order: a held-out field test set for a real generalisation  
number; retrain the offline texture gate with diseased leaves; and per-class  
confidence calibration so "80% confident" means the same thing for every disease.

---

## 8. If you don't know

Say: *"We haven't measured that yet."* Then say how you would measure it.

A judge is testing whether you understand your own system, not whether you have  
every number. Inventing a figure is the only unrecoverable mistake.
