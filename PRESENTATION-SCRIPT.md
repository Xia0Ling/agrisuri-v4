# Presentation script — 5 minutes, plain words

Built for a high-school audience. Every technical term is either replaced with a
plain one or explained the first time it appears.

**Total: ~4:20 spoken, 40 seconds of buffer.** Word counts are for a normal
speaking pace (~140 words per minute). Do not read faster to fit more in — cut
instead.

If your Canva deck still has 24 slides, the duplicate build steps (the same four
objectives across five slides, the same four steps across five slides) should be
one slide each. The script below assumes nine.

---

## 1 · Title — 10 seconds

**On screen:** project title, names, school.

**Say:**

> Good morning. We built AgriSuri — a system that identifies crop diseases from a
> single photo of a leaf, and works even when the phone has no internet.

**Don't** read the full title slide. They can read.

---

## 2 · The problem — 25 seconds

**On screen:** rice and tomato photos.

**Say:**

> Rice and tomato are two of the main crops here in Nueva Ecija. When a plant
> gets sick, the damage starts on the lower leaves — the ones nobody looks at.
> By the time someone who knows what to look for arrives, the disease has
> usually spread.
>
> There is one more problem. Most farming apps need internet. In the field,
> there often isn't any.

**Plain words to use:** say "the lower leaves" not "the lower canopy". Say
"someone who knows what to look for" instead of "an agricultural extension
worker" — then use the real term once, later.

---

## 3 · Objectives — 20 seconds

**On screen:** four objective cards.

**Say:**

> We had four goals. One: identify the disease from a photo. Two: make it work
> both online and offline. Three: measure how accurate it actually is. And four:
> let the results reach the local agriculture office, not just the farmer.

**One breath per objective.** Do not explain them yet — slide 4 does that.

---

## 4 · How it works — 50 seconds (the most important slide)

**On screen:** the four-layer diagram.

**Say:**

> Before the AI guesses anything, three checkpoints decide whether the photo is
> even worth answering.
>
> First, quality. Is it bright enough? Is it sharp? If it's blurry, we ask for
> another photo. Nothing is saved.
>
> Second, shape. Is this a plant at all, or is it a hand, a tool, or the sky?
>
> Third, texture. Is this a leaf surface, or is it a wall or a floor? A green
> painted wall can fool a shape check, but it has no veins.
>
> Only then does the fourth layer — the disease model — give an answer. If any
> checkpoint fails, the scan stops there. We would rather say "take another
> photo" than guess.

**Why this slide wins:** it shows you thought about failure, not just success.
Most school projects stop at "the AI tells you the disease".

**Terms:** a "layer" here just means a step. "Model" means the AI — it has looked
at thousands of labelled leaf photos and learned the patterns.

---

## 5 · Online and offline — 30 seconds

**On screen:** two paths.

**Say:**

> The system has two ways to run. Online, the photo goes to our server, and the
> server asks a much bigger AI in the cloud. That one is the most accurate.
>
> Offline, a smaller copy of the AI is already downloaded on the phone. It is
> less accurate, but it needs no signal at all.
>
> The app tries the cloud first. If there is no connection, it uses the phone's
> copy automatically. The farmer does not have to choose.

---

## 6 · How we measured — 45 seconds

**On screen:** the formula and the test set.

**Say:**

> A number only means something if you say how you got it.
>
> We took one hundred twenty photos — eight for each of the fourteen disease
> classes, plus eight photos that were not leaves at all. We resized them exactly
> the way the app does, so we measured the same thing the app actually sends.
>
> Accuracy is simple: correct answers divided by total photos, times one hundred.
> The model got one hundred nine out of one hundred twelve right on its first
> guess. That is ninety-seven point three percent.
>
> With the three checkpoints switched on, it drops to ninety-five point five —
> because a few good photos get rejected along the way. That drop is the price of
> not guessing.

**Terms:** "class" = one possible answer, like "early blight". "First guess" =
top-1. Say "first guess", it lands better than "top-1 accuracy".

---

## 7 · Results and the honest limit — 40 seconds

**On screen:** the bar chart, then the caveat.

**Say:**

> Here is the trade-off in one picture. The cloud model gets ninety-seven
> percent. The phone's smaller model gets less — and we know exactly what that
> costs.
>
> But I have to be honest about this number. The photos we tested on came from
> the same collection we trained on. So ninety-seven percent is the best case.
> It is not proof that it works on a real farm.
>
> What would prove it? Fifty real phone photos per crop, labelled by hand. That
> is the next step, and we are not going to claim it before we do it.

**This is the slide that earns respect.** Saying the limit yourself is stronger
than being caught.

---

## 8 · Who it helps — 25 seconds

**On screen:** stakeholders.

**Say:**

> For a farmer, it is a second opinion in ten seconds, for free.
>
> For the agriculture office, it is something they never had: a map of which
> barangay is reporting which disease, this month. Right now that information
> lives in notebooks.

**Only two stakeholders out loud.** Four is a list; two is a story.

---

## 9 · Close — 15 seconds

**On screen:** closing line.

**Say:**

> Two crops. One photo. No signal required. Thank you — we're ready for
> questions.

**Then stop talking.** Do not fill the silence.

---

# Terms, in words a high-school student understands

Use the right-hand column when you speak. Use the left only if a judge uses it
first.

| Term | What it actually means | Say this instead |
|---|---|---|
| Model / AI model | A program that learned patterns from thousands of labelled examples | "the AI, trained on labelled photos" |
| Inference | The model making a prediction on a new photo | "the AI's guess" |
| Class | One possible answer the model can give | "one possible answer" |
| Confidence | How sure the model is, from 0 to 1 | "how sure it is" |
| Threshold | The cut-off line for accepting an answer | "the cut-off line" |
| Top-1 accuracy | Percent where the first guess was correct | "how often its first guess was right" |
| End-to-end | The whole trip, photo to final answer | "from photo to answer" |
| Dataset | The collection of photos used for training and testing | "the photo collection" |
| Training vs testing | Learning from photos vs being graded on photos | "studying vs taking the exam" |
| Gate / checkpoint | A step that can stop the process early | "a checkpoint" |
| Gateway / server | A middle computer that holds the secret key and calls the AI | "our server, which does the calling for the phone" |
| Cloud | Someone else's computer, reached over the internet | "a bigger computer online" |
| Offline model | A small copy of the AI stored on the phone | "the phone's own copy" |
| RLS / row-level security | Rules in the database that decide who may read which rows | "the database itself decides who can see what" |
| PWA | A website that installs like an app | "a website that installs like an app" |

---

# Five questions you will probably get

Answer in one sentence, then stop. Long answers sound unsure.

**"How accurate is it?"**
> Ninety-seven percent on our test set — but that test set came from the same
> photos we trained on, so it's the best case, not field accuracy.

**"What if the photo is blurry?"**
> It's rejected before any AI runs. The farmer is asked to take another photo,
> and nothing is saved.

**"Why not just use one big model?"**
> Because a big model needs internet. The three checkpoints let the phone answer
> by itself, and they stop bad photos from wasting a guess.

**"Did you test it on real farms?"**
> Not yet. That's the next step: fifty real phone photos per crop, labelled by
> hand.

**"Who owns the photos?"**
> The farmer. They're stored privately, locations are rounded to about a hundred
> metres, and photos are never used for training unless the farmer turns that on.

---

# Memorize this, not the script

You will not remember 600 words under pressure. Memorize five anchors and three
numbers.

**Anchors:** problem → four checkpoints → two modes → how we measured → the
honest limit.

**Numbers:** 120 photos. 97.3 percent. 14 classes.

If you remember only those, you can rebuild every sentence on stage.
