# HANDOFF: SkySentry local bird / drone classifier ("Shreyansh Local Ai Model")

Read this whole file before doing anything. It is written for the next AI assistant (or person)
continuing this work. **Section 0 is the latest status (2026-11-19, 13:50 ET) and overrides older
sections where they disagree.** Sections 1-7 describe v1.

## 00. NEWEST STATUS (2026-11-19, 15:15 ET) — read this before section 0

**Current best model: v4.1** = `runs/v4_1/best.pt` (SkyNetLite, 472,579 params), already exported to
`skysentry_classifier.json` (JS parity 1e-6, PASS). Trained from v4 for 4 epochs on 10 sources:
Mendeley, Svanström (x3), AOD-4, DUT Anti-UAV, DCSkyCam, IBERBIRDS, Klim/Skagen (x3), Open Images (18,665 crops),
athkot synthetic, Cranfield synthetic (`train_v4.py --weights klim_skagen:3,svanstrom:3`). FBD-SV-2024 is TEST ONLY.
Lineage: v3 -> v4 (`runs/v4/best.pt`, 6 epochs, 9-10 sources, Open Images only 75 crops) -> v4.1.

### v4.1 results (groups never trained on; FBD-SV never trained on at all). 1 crop -> vote of 5 frames
| Test | Birds | Drones | False alarms |
|---|---|---|---|
| Svanström real size | 93.6% -> **96.1%** | 94.4% -> **96.0%** | 6.1% -> **1.0%** |
| Svanström shrunk 13 px | 90.0% -> 93.4% | 91.7% -> 94.0% | 10.1% -> 3.0% |
| Svanström shrunk 10 px | 86.5% -> 89.5% | 90.1% -> 92.7% | 10.7% -> 3.0% |
| Svanström shrunk 7 px | 69.0% -> 65.8% | 85.9% -> 88.4% | 9.9% -> 2.6% |
| **FBD-SV (never-seen source)** | 81.5% -> **91.0%** | n/a | 15.1% -> **2.1%** |
| YouTube planes/helicopters | | | 25.7% -> 8.7% |
| Klim/Skagen | 95.7% | | 7.1% |
| IBERBIRDS | 99.0% | | 0.5% |
| AOD-4 | 93.9% | | 3.4% |
| DUT Anti-UAV | | 86.1% (v4: 92.8%) | 6.5% |
| Open Images | 86.2% | | 19.9% |
Files: `results/v4_1/all_tests.md`, `results/v4_1/voting_5.md` (and the same for `results/v4/`).
"Vote of 5" = average the model's probabilities over 5 consecutive crops of one tracked object (`eval_voting.py`);
in the app this means classifying each track several times and voting. **This is the single biggest win**:
the app integration should do it (cache per track id, re-check every ~0.3-0.5 s, label = vote of last 5).

### Against the user's targets (>= 95% everywhere, especially never-seen sources and small objects)
MET with voting: Svanström real-size birds and drones, false alarms on several sets.
NOT met: FBD-SV birds 91%; 7 px birds (~66-69%); 10-13 px 89-94%; DUT drones 86%; Open Images false alarms 20%;
planes/helicopters 9% false alarms even with voting. Be honest about this with the user.

### v5 MobileNetV3 Large checkpoint & ONNX (Svanström authors-only research run)
- **Packaged weights**:
  - `runs/v5/best.pt` (`mobilenet_v3_large`, `17,031,299` bytes, SHA-256 `2dfc6316ea3077d534ce7d9c4a289d0a7c3e12c06d78c7d5178734b6cec30a6b`)
  - `runs/v5/best.onnx` (self-contained opset-17 ONNX, `16,813,521` bytes, SHA-256 `b5623ed44fff65d8d26c350728f371065ad1dd038e8aef4f0904577fba766c6a`, dynamic batch `crop96_normalised -> logits`; `validate_v5_onnx.py` synthetic CPU logit parity max abs error `7.15e-07` at batch 1 and `8.87e-07` at batch 3)
  - Provenance & SELECT reports: `runs/v5/run.json`, `runs/v5/history.json`, `results/v5/select_comparison.json`, `results/v5/voting_5_select.json`
- **Training & SELECT results**: fine-tuned from TorchVision `MobileNet_V3_Large_Weights.IMAGENET1K_V2` (`0.23.0+cu126`) for 8 epochs (728 steps, seed 44) on CC0 Svanström authors-only TRAIN/SELECT (153/35 clips) with aircraft-balanced `other` loss. Native single-crop SELECT balanced accuracy: **95.71%** (95% clip-bootstrap CI `91.86%-98.62%`; bird recall `94.96%`, drone recall `93.68%`, labelled aircraft false positives `2.47%` vs `12.35%` unweighted baseline). Five-crop probability voting across 691 non-overlapping native SELECT windows: **97.81%** bird recall (`134/137`), **95.40%** drone recall (`332/348`), **1.46%** labelled aircraft called bird/drone (`3/206`).
- **Scope & licence disclosure**: development SELECT on Svanström only — not yet trained on the full 10-source corpus or scored on unseen FBD-SV. `runs/v4_1/best.pt` (`skysentry_classifier.{js,json}`) remains the full 10-source browser classifier verified on unseen FBD-SV (`91.0%` bird recall, `2.1%` false alarms with 5-frame voting). Check TorchVision `IMAGENET1K_V2` pretrained weight terms before commercial deployment.

### Next steps, in order (what most likely closes the gap)
1. **Bigger pretrained model on a GPU**: `train_v5_mobilenet.py --arch mobilenet_v3_large` (4.2M params, 16.8 MB,
   within the user's 20 MB limit; ImageNet-pretrained). Too slow on this 2-core CPU (~40 crops/s); on an RTX 3060
   or Colab T4 roughly 1-3 min per epoch (estimate). Needs the crop .npy files (rebuild with prepare_* and
   sources/*.py). Evaluate it like v4 (adapt eval_v4/eval_voting to load the MobileNet via build(arch); they
   currently load SkyNetLite). Browser: export ONNX (`--export`) and use onnxruntime-web.
   Licence note: ImageNet-pretrained weights; check terms before commercial use.
2. Hard negatives: planes / helicopters / kites are the main false alarms. More helicopter & airplane crops
   (DCSkyCam "not_helicopter" needs hand sorting; AOD-4 had many).
3. Real small birds: AirBirds (airport cameras, median 5 px birds, CC BY-NC-SA: test-only, or ask the authors),
   and the team's own field footage. 7 px birds will likely need motion + multi-frame evidence, not one crop.
4. DUT drones dropped 92.8% -> 86.1% from v4 to v4.1 (weights favoured birds): try drone sources x2.
5. One change per version; keep using the unseen-source tests (FBD-SV) as the headline.

### Session end (2026-11-19, 16:30 ET)
Nothing was trained after v4.1. Nothing is running. The only change since 15:15 is the Gemini re-check below.
To continue, pick from "Next steps" above. Priority: v5 on the user's RTX 3060 (`train_v5_mobilenet.py`),
and add multi-frame voting to the app's tracking (approved; see APPROVALS and the wiring plan below).

### APPROVALS (16:31 ET): the user says ALL approvals are given, including Vivan's OK
This overrides every earlier "ask Vivan first" / "needs Vivan's OK" in this file and in DATASETS.md /
FLOCKS.md / WEB_RUNTIME.md: changing app code in PRANAV/ and the detection engine in VIVAN/ is approved, and
so are downloads. Still follow the benchmark protocol's honesty rules (frozen test sets, report CIs, one change
per version), and still a branch + PR per change (AI.md).

### How to wire the model into the app (with multi-frame voting)
Where it plugs in today: `PRANAV/public/js/visual-ai.js`, class `VisualBirdVerifier` (created in
`PRANAV/public/js/tower.js`). Every ~0.9 s it picks ONE tracked object (`chooseBirdCandidate`, skips objects
under 24 px), runs COCO-SSD on its box (`verifier.classifyBox(video, bbox)`), optionally asks Gemini, and
applies the label to the live track in one of two ways:
  - local / fallback engine: `c.t.engine.applyLabel(trackId, label, score, source)`
  - server bot: `socket.emit('tower:label', { cameraId, trackId, label, score, bbox, frameT, source })`
    (the server only trusts `source: 'coco'` today: add the new source name on the server side, in PRANAV/server.js
    / bot.js, so it is accepted).
Plan:
  1. Copy `skysentry_classifier.js` + `skysentry_classifier.json` (v4.1) into `PRANAV/public/ai-models/`
     (the model folder's name has spaces, so it cannot be served directly).
  2. In `visual-ai.js`, replace COCO-SSD with `loadClassifier('/ai-models/skysentry_classifier.json')`.
     Instead of one object per tick, run `classifyBoxes(video, boxes)` on EVERY live track of a feed (the
     tracker's `state.tracks[].bbox`, normalised 0..1; not the flock / event crop) every ~0.3-0.5 s, ideally in a
     Web Worker (60 crops ~1 s in plain JS on a slow CPU; see WEB_RUNTIME.md).
  3. Keep the last 5 probability vectors per (cameraId, trackId); label = argmax of their average; apply it with
     the same two calls above (source e.g. 'skysentry-v4.1'), only when it changes or every few seconds.
     Drop a track's history when the track disappears. Minimum box size can go down from 24 px (the model was
     trained on 7 px+ objects), but expect lower accuracy under ~10 px.
  4. Keep Gemini only as an optional switch (off by default: it sends airport images to Google).
  5. Test with `npm test` in PRANAV, plus a demo clip on /tower.html; measured gain from voting is in
     `results/v4_1/voting_5.md` (never-seen birds 81.5% -> 91.0%, false alarms 15.1% -> 2.1%).
  6. `npm run sync-web` copies VIVAN/detection into PRANAV/public/detection: if you change the engine, change
     VIVAN/ first. After the folder rename these are detection-engine/ and server-and-website/.
Optional, also approved now: `flight_forecast.js` (30-60 s corridor forecast) can be wired the same way, fed with
`state.tracks` positions every frame.

### Gemini comparison: NOT done (re-checked 15:46 ET: both models still return quota errors)
`gemini_compare.py` is ready (same crops, forced bird/drone/other answer, `GEMINI_API_KEY` from env only).
The user's key is FREE TIER: 20 requests per model, so it returned HTTP 429 "quota exceeded". Needs billing
enabled (840 calls; likely well under $1, check pricing). The key was pasted in chat: the user was told to rotate it.
Never write the key to any file.

### v4 data sources (all in `sources/`, outputs in `data/shreyansh_crops_v4/<source>_{train,select,test}_*`)
dut_anti_uav.py, aod4.py (drops YouTube `yt-*` and 4,942 frames copied from Svanström), dcskycam.py,
iberbirds.py, klim_skagen.py, openimages.py (+ openimages_attribution.csv, CC BY 2.0 credits), synth.py
(athkot + Cranfield `multi_drone_no_birds_40m_small.zip`; masks paired by the FIRST number in Mask####.png_####.png),
fbdsv2024_testonly.py (non-commercial licence -> test only). Each verifies checksums and pHash-checks against the
frozen Mendeley test + Svanström test frames (`sources/common.py`). Raw downloads are deleted after cropping.

## 0. LATEST STATUS (read first)

### User's targets (Shreyansh)
- >= 95% correct for birds of **7 px and up**, **99-100%** for birds **over 15 px**, measured on footage
  the model has NEVER seen (live airport feeds will be unseen). Low false alarms. Wants >= 10 data sources.
- Speed matters to the user; keep them updated with plain-English progress.

### Versions so far (all 472,579-parameter SkyNetLite, `model.py`)
| Version | What changed | Checkpoint |
|---|---|---|
| v1 | Mendeley only, 12 epochs | `runs/v1/best.pt` |
| v2 | one-step crops (crop mismatch fixed), realistic "tiny" versions (whole frame shrunk), stronger motion blur, 20 epochs (`prepare_v2.py`, `train_v2.py`) | `runs/v2/best.pt` |
| v3 | fine-tuned from v2 on Mendeley + **Svanström** (CC0 real sky videos: birds, drones, planes, helicopters) (`prepare_svanstrom.py`, `train_v3.py`) | `runs/v3/best.pt` **(current best)** |
| v4 | NOT TRAINED YET: fine-tune v3 on 10+ sources (`train_v4.py`, `eval_v4.py`, `sources/*.py`) | - |

### The key lesson: test on footage from a DIFFERENT source
- v2 scored 95.8% on Mendeley-style holdout but only **1.5% bird recall on unseen Svanström clips** (it
  called real distant birds "other" 57% / "drone" 41%). Mendeley's train/valid/test come from the same 42
  Pexels videos, so its scores are inflated. Never quote Mendeley scores as real-world accuracy.
- Mendeley VALID is unusable (1,565/1,740 images near-duplicate the frozen TEST); `make_split.py` makes
  a holdout from TRAIN instead.

### v3 results on Svanström TEST clips (whole clips never trained on; `results/v3/`)
| Size | Birds | Drones | False alarms (sky, planes, helicopters) |
|---|---|---|---|
| over 15 px (real) | 93.6% (CI 89.6-96.8) | 95.2% (89.0-99.0) | 11.1% (5.6-16.3) |
| 13 px (frame shrunk) | 90.8% | 91.1% | 13.7% |
| 10 px (shrunk) | 88.2% | 88.2% | 15.1% |
| 7 px (shrunk) | 65.5% | 80.8% | 14.0% |
YouTube planes/helicopters (test-only, user approved using them for testing) called bird/drone: 35%.
Mendeley frozen test (optimistic): bird 99.7%, drone 100%, false alarms 5.9%.
**Targets NOT met yet.** Biggest gaps: false alarms on planes/helicopters, 7-10 px birds.
`results/v3_all/all_tests.md` = v3 on every test set (baseline for v4).
Svanström real birds are 23-39 px, so the 7-15 px range is only tested by shrinking frames
(`prepare_svanstrom_shrunk.py`); real small-bird data (Klim/Skagen, AirBirds) is needed.

### v4 in progress when this session ended
- `sources/common.py`: shared CropWriter (train = [jittered, jittered, tiny] versions; select/test = centre
  crop; background squares; 80/10/10 split by group via `split_part`; `leak_check` = pHash <= 6 vs the
  Mendeley frozen test + Svanström test frames, cache `data/shreyansh_crops_v4/svan_test_phash.npy`).
- 4 agents were writing `sources/<name>.py` and producing `data/shreyansh_crops_v4/<name>_{train,select,test}_*`:
  dut_anti_uav (Apache-2.0, drones), aod4 (CC BY, drop `yt-*` images), klim_skagen (CC BY, small birds),
  iberbirds (CC BY, birds), dcskycam (CC BY, helicopter crops -> other), synth_athkot (CC BY, synthetic),
  synth_cranfield (CC BY, one zip), openimages (CC BY; birds + planes/kites/balloons as other; attribution CSV),
  fbdsv2024_testonly (non-commercial licence -> TEST ONLY, the "never-seen source" test).
  **Check which `*_info.json` files exist in data/shreyansh_crops_v4/**; rerun any missing `sources/<name>.py`.
  URLs, licences and caveats: `DATASETS.md`.
- Then: `python3 train_v4.py --name v4 --init runs/v3/best.pt --epochs 8` (~45 min on 2 CPU cores;
  bf16 + channels_last already on; resumable), then `python3 eval_v4.py --checkpoint runs/v4/best.pt --out results/v4`
  and compare with `results/v3_all/`. Report every row with its CI, especially fbdsv2024_testonly.
- After v4: try v5 = same as v4 but ~1.5-2.5M parameters (only change), keep it only if it beats v4 on the
  unseen-source tests. Then: more real small-bird data, hard negatives (planes/helicopters), multi-frame voting.

### Other work done this session
- `flight_forecast.js` + `test_flight_forecast.mjs` (9/9 checks pass): 30-60 s flight-path forecast per
  track (300 simulated futures with turns / speed changes / drone hovering), P(enter runway corridor within
  30 s / 60 s), ETA percentiles, predicted positions, clash check with scheduled departures/arrivals.
  On 300 synthetic turning birds: Brier 0.019 vs 0.064 (30 s) and 0.044 vs 0.097 (60 s) for the engine's
  straight-line ETA. Synthetic only; one camera cannot judge distance (multi-camera fixes that).
  Not wired into Vivan's engine (his code; needs his OK).
- `rename-folders.sh` (in `../local-bird-drone-model-tools/` in the workspace; a copy is in this folder):
  PRANAV->server-and-website, VIVAN->detection-engine, ATHARV->film-and-ios-app,
  SHREYANSH->ai-voice-solana-pipeline, this folder->local-bird-drone-model; fixes all paths. Tested on a
  copy: all 91 server tests pass. After merging: change DigitalOcean Source Directory PRANAV ->
  server-and-website. Not applied to the real repo (no push access).
- Gemini bird judge accuracy was never measured anywhere in the repo; comparing needs the user's key.
- GitHub push access was denied; everything is delivered as a zip. Data is NOT in the zip (re-download;
  scripts verify checksums).

## 1. What this is and why

SkySentry (repo `pranav-atreya10/hackphs-dot`) is an airport bird/drone detection web app. The live
pipeline is: camera frames -> Vivan's motion tracker (`VIVAN/detection/src/`, copied into
`PRANAV/public/detection`) finds moving objects and gives each a box -> a second-opinion check decides
what the object is -> alerts go to the tower dashboard.

Today that second-opinion check uses **Gemini** (an external Google service: snapshots leave the
airport) plus COCO-SSD in the browser (`PRANAV/public/js/visual-ai.js`). The goal of this folder is
**our own small model that runs fully inside the browser**, so nothing leaves the airport:

- input: a 64x64 crop cut around a tracker box (rule in `crops.py`)
- output: `bird`, `drone` or `other` (planes, insects, leaves, clouds, sky, buildings ...)
- size: the user asked for 400-500 thousand parameters. `model.py` (SkyNetLite) has **472,579**.
- runs in plain JavaScript with no ML library, like the team's existing drone-sound model
  (`VIVAN/detection/src/audio_model.js`, exported by `benchmarks/export_audio_web.py`).

The user (Shreyansh) wants it to handle: very tiny distant birds, fast-moving birds, birds crossing
paths, flocks of 50-60 birds, and birds and drones in the same scene. They asked for 99% accuracy.
**No model can be guaranteed 99%; report the real measured number with its 95% confidence interval
on the frozen test set, never a rounded-up or cherry-picked one.**

## 2. Team rules you must follow (from the repo)

- `CLAUDE.md` and `benchmarks/BENCHMARK_PROTOCOL.md` (Vivan's protocol). Key points:
  - The Mendeley **test** split is FROZEN (`benchmarks/test_sets.json`, SHA-256 per file). Never
    train on it, tune on it, edit it, add to it or remove from it. Only evaluate on it.
  - Choose epochs / thresholds / settings using the **valid** split only.
  - One change per version, hypothesis written first, keep/revert decision with a reason after.
  - Headline metrics: drone recall and false-alarm rate, each with a 95% bootstrap CI
    (1,000 resamples of the manifest's `group`s). CI overlap with the current best = "not significant".
  - Suspiciously good result -> check for train/test leakage before reporting.
  - Ask Vivan before: downloading datasets other than ESC-50, touching SkySentry app code (PRANAV/),
    running the field-footage holdout. (The user gave permission for the Mendeley download.)
- `AI.md`: a branch and a PR for every change; explain each change in the owner's notes file
  (Shreyansh's work -> add an explanation section; there is a `SHREYANSH/` folder for his notes).

## 3. Data

- Mendeley Data `6ghdz52pd7` v5 `Dataset.zip` (1,128,956,760 bytes, SHA-256
  `5bf5b257071176713664659db6e7e31ebc4c331d94e0c3f369461c1e7ecac51c`, verified).
  Download URL: `https://data.mendeley.com/public-files/datasets/6ghdz52pd7/files/20ed32e1-7e9e-4177-a15d-87fae70770cf/file_downloaded`
  Unzip into `data/mendeley/` so images are at `data/mendeley/Dataset/{train,valid,test}/images`.
  `data/` is git-ignored: never commit data.
- Classes come from FILE NAMES (B... = bird, D... = drone). The published label ids are wrong (both
  classes share id 0). Some label lines are polygons: convert to boxes with min/max.
- `python3 prepare_data.py` -> `data/shreyansh_crops/{train,valid}.npz` (~3 minutes on 2 cores).
  Result: train 94,087 crops (bird 23,582 / drone 35,154 / other 35,351), valid 5,252
  (bird 740 / drone 1,038 / other 3,474). "Other" = 2 background squares per image that touch no object.
- **WARNING: do not use the Mendeley VALID split for anything.** 1,565 of its 1,740 images are
  near-duplicates (pHash Hamming <= 6) of FROZEN TEST images and 11 are byte-identical. Picking epochs
  on it = peeking at the test set. `make_split.py` instead holds out ~12% of TRAIN images as
  `data/shreyansh_crops/holdout.npz` (fit: 82,709 crops / holdout: 11,248 crops) and drops the 26 train
  images within Hamming 12 of any test image. The holdout's closest image to the test set is Hamming 14.
  The list is in `split.json`.
- **Caveat for every Tier 1 number:** per `DATASETS.md`, Mendeley's train/valid/test were all cut from
  the same 42 Pexels stock videos. Test scores are therefore optimistic (same scenes, same birds and
  drones). Only the team's own field footage (Tier 2) is truly independent.
- More data: `DATASETS.md` (licences checked, download URLs tested). Best: Svanström drone dataset
  (CC0, drones + birds + planes + helicopters; skip its 49 YouTube clips), DUT Anti-UAV (Apache-2.0,
  drones), DCSkyCam (CC BY 4.0, sky-camera crops; hand-sort into bird/other). Ask Vivan before
  downloading (protocol section 7) and run the pHash leakage check against the test set first.

## 4. Files in this folder

| File | What it does | Status |
|---|---|---|
| `crops.py` | The one crop rule shared by training, testing and the browser | done |
| `model.py` | SkyNetLite, 472,579 params | done |
| `prepare_data.py` | Cuts training crops from train/valid | done, run |
| `make_split.py`, `split.json`, `valid_excluded.json` | Clean holdout from train (see section 3 warning); list of leaky valid images | done, run |
| `train.py` | Training with augmentation for tiny (shrink 6-24 px), fast (motion blur), jittered boxes, tilt, lighting, noise. Resumable: rerun the same command to continue | done |
| `runs/v1/` | `best.pt` (best epoch on valid), `last.pt`, `history.json` | see section 5 |
| `evaluate.py` | Frozen-test scoring with checksum check and grouped bootstrap CIs | see section 5 |
| `export_web.py`, `skysentry_classifier.js`, `test_parity.mjs`, `WEB_RUNTIME.md` | Export to JSON + plain-JS browser runner + parity test | see section 5 |
| `make_stress_set.py`, `eval_stress.py`, `engine_flock_probe.mjs`, `FLOCKS.md` | Synthetic flock / mixed / tiny / blurred scene tests + audit of Vivan's tracker for 50-60 birds, crossing paths, drone inside flock | see section 5 |
| `DATASETS.md` | Openly licensed extra datasets, reachability, leakage-check plan | see section 5 |

## 5. Current status and results

Model **v1** = `runs/v1/best.pt` (epoch 11 of 12, seed 42), exported to `skysentry_classifier.json`
(2.5 MB). Training: 12 epochs, batch 256, AdamW, OneCycle max lr 3e-3, class-weighted cross-entropy with
label smoothing 0.05, bfloat16 mixed precision + channels_last from epoch 8 on (an identical
training schedule, ~2.4x faster per epoch on this AMX-capable Xeon). Log: `runs_v1.log`, `runs/v1/history.json`.

**1. Clean holdout (from train, picks the epoch), balanced accuracy 94.95%:** bird 96.7%,
drone 95.9%, other 92.2% recall (epoch 11).

**2. Frozen Tier 1 test (Mendeley test split, `results/v1/report.md` + `metrics.json`; checksums verified):**

| Metric | Value (95% CI, 1,000 group resamples) |
|---|---|
| Drone recall | 100.0% (100.0-100.0) of 526 |
| Bird recall | 100.0% (100.0-100.0) of 378 |
| Birds called drones / drones called birds | 0.0% / 0.0% |
| False-alarm rate (background called bird/drone) | 4.1% (2.9-5.6) of 2,667 |
| Overall accuracy | 96.9% (95.8-97.8) |
| Balanced accuracy | 98.6% (98.1-99.0) |

**Read this before quoting those numbers:** perfect bird and drone recall is "suspiciously good"
(protocol section 6). The pHash check finds no near-duplicates between train and test, but train and test were
cut from the same 42 Pexels videos (DATASETS.md), so test crops show the same birds, drones and skies
the model trained on. The holdout (~95%) is likely closer to the truth, and field footage will be lower
still. **The 99% target is NOT met**: overall accuracy's CI upper bound is 97.8%, and the false-alarm rate
of 4.1% is the main reason. Bird and drone recall reach 100% only on this optimistic test set.
(A plumbing dry-run of evaluate.py was also run once on an epoch-5 checkpoint. It was not used for any
decision; epochs were chosen on the holdout only.)

**3. Synthetic stress scenes (`results/v1/stress.json`; sanity check only, see 5b):**

| Scene type | Bird recall | Drone recall | Birds called drone | Drones called bird |
|---|---|---|---|---|
| dense (50-60 birds) | 77.0% | n/a | 13.1% | n/a |
| mixed (birds + 1-3 drones) | 82.9% | 78.1% | 9.9% | 21.9% |
| drone inside flock | 81.5% | 78.3% | 9.1% | 21.7% |
| tiny birds (3-8 px) | **9.8%** | 83.3% | **48.3%** | 0% |
| motion-blurred birds | 43.0% called bird | | 24.6% | |

60 crops through the network take ~21 ms in PyTorch, or ~0.9 s in the plain-JS runtime (15 ms per crop).

**Biggest weaknesses, in priority order:**
1. **Tiny birds:** half are called drones. Fix: real small-bird examples (DATASETS.md); make
   the "far away" augmentation stronger and more frequent; cut one-step crops (the 5b crop mismatch).
2. **False alarms on background (4%):** add hard negatives (planes, insects, clouds, branches).
3. **Pasted drones inside flocks are called birds ~22% of the time:** more mixed and real drone
   data, and combine with motion and sound evidence (Vivan's engine) instead of one crop.
4. **Blurred birds:** stronger motion-blur augmentation.

## 5b. Findings from the checks (details in the named files)

- **Crop mismatch (WEB_RUNTIME.md):** training crops are cut at 80 px with extra context and then
  resampled to 64 (`prepare_data.py` + `train.py centre_view/augment`), while `evaluate.py`,
  `eval_stress.py` and the browser's default `cropMode: 'live'` cut 64 px directly with `crops.cut`.
  The pixels differ by 1.8-5.2 levels on average (out of 255). The JS crop itself is pixel-identical
  to `crops.cut`, and JS logits match PyTorch to ~1e-6. Fix for the next version: make training cut
  one-step `crops.cut` crops with jitter applied to the box *before* cutting (one change = one version).
- **Browser speed:** ~15-24 ms per crop in Node on a slow 2-core VM; 60 crops ~0.9-1.4 s, which would
  freeze the page for a big flock -> run it in a Web Worker and classify each track once (cache by
  track id, re-check about every second).
- **Vivan's engine with flocks, tiny / fast / crossing birds (FLOCKS.md, engine_flock_probe.mjs):**
  - no limit on tracks; 3-5 ms per frame at 10-100 birds. Each bird keeps its own track and box,
    and a flock is an extra group on top.
  - `maxBlobs: 200` (config.js:33) is all-or-nothing: above 200 pieces the frame is skipped.
  - birds closer than ~2 px merge, so 60 birds 8-10 px apart are counted as only 15-27.
  - a drone flying *with* a flock is relabelled "bird - flies with flock" (engine.js:490-493).
    This is the most important safety issue to raise with Vivan.
  - a hovering drone is tracked in only 6% of frames; objects moving faster than 24 px/frame are never
    tracked (config.js:46); crossing birds often swap IDs; a drone crossing a bird keeps its ID about half the time.
  - 2-4 px birds are mostly tracked (the `distant_birds` preset gets 20/20 at 2 px).
  - The event snapshot covers the whole flock box. The classifier must be run on each
    `state.tracks[].bbox`, not on the event crop.
  These are suggestions for Vivan; nothing in VIVAN/ was changed.
- **Stress set (`data/stress_flocks/`, 60 synthetic scenes, 3,129 pasted objects: 3,068 birds incl. 909
  motion-blurred, 61 drones; types dense / mixed / drone_in_flock / tiny):** built from Mendeley VALID
  cut-outs, and most of those are near-copies of test images. Scores on it are a sanity check, NOT
  independent evidence. Never train on it.
- **evaluate.py notes:** overall accuracy is dominated by "other" crops (75% of the 3,571 test crops),
  so read drone recall, bird recall and false-alarm rate first. The test set has only 8 small birds
  and 73 small drones (3 groups each), so small-object numbers have very wide CIs. Mendeley images
  are stretched 1920x1080 -> 640x640, unlike live frames.

## 6. How to reproduce from zero

```bash
cd hackphs-dot
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu   # or a GPU build
pip install numpy pillow
mkdir -p data/mendeley && cd data/mendeley
curl -L -o Dataset.zip "<download URL above>" && sha256sum Dataset.zip && unzip -q Dataset.zip && cd ../..
cd "Shreyansh Local Ai Model"
python3 prepare_data.py
pip install imagehash && python3 make_split.py
python3 train.py --name v1 --epochs 12 --minutes 100        # ~66 s per epoch on 2 AMX CPU cores; rerun to resume
python3 evaluate.py --checkpoint runs/v1/best.pt --out results/v1
python3 make_stress_set.py && python3 eval_stress.py --checkpoint runs/v1/best.pt --json results/v1/stress.json
python3 export_web.py --checkpoint runs/v1/best.pt --out skysentry_classifier.json
node test_parity.mjs skysentry_classifier.json
```

## 7. Next steps (in order)

1. If section 5 is pending: finish training and run `evaluate.py`; fill in section 5 honestly.
2. Look at the mistakes (which test crops fail: tiny? backlit? cluttered?). Fix one thing per
   version (v2, v3 ...), following the protocol. Ideas, one at a time:
   - more "other" examples that look like birds/drones (planes, insects, kites) from openly
     licensed datasets in `DATASETS.md`, after the leakage check against the Mendeley test images;
   - hard-negative mining: crops the model wrongly calls bird/drone added to "other";
   - longer training / different learning rate; slightly bigger input for tiny objects;
   - a short sequence of crops per track (wing-beat vs steady hover) instead of one crop.
3. Watch for a shortcut: bird and drone photos often have different backgrounds. The synthetic
   stress set (objects pasted on other backgrounds) checks whether the model learned the object
   or the background.
4. Wire into the app (needs Vivan's OK; it touches PRANAV/): in `PRANAV/public/js/visual-ai.js`,
   replace the COCO-SSD/Gemini second opinion with `skysentry_classifier.js` (`classifyBoxes` on the
   tracker boxes). Copy the JSON + JS into `PRANAV/public/ai-models/`. Keep Gemini only as an
   optional, switchable extra (an `AI_MODE=local` setting).
5. Real-world proof: record 15-20 field clips with the team's cameras (tiny birds, flocks, a drone),
   freeze them as Tier 2 per the protocol, and report results on those. That is what an airport will
   ask for.
6. Branch + PR, and explain everything in Shreyansh's notes file (AI.md rule).
