This is the file for Vivan. Refer to AI.md for reference.

## Rocks and debris are no longer called birds (debris check)

**The problem.** The engine decides "bird" mostly from the wingbeat: a bird's outline pulses at a
steady rhythm. A thrown rock or a strip of debris that tumbles end over end *also* pulses at a steady
rhythm, so it was called a bird. Worse, a handful of thrown gravel moving together was counted as a
"flock of 5 birds" and raised **red**. Reproduced before fixing: a thrown rock was labelled bird in 5/5
random runs, a gravel shower became a red "flock" in 5/5, spinning debris was a bird in 5/5.

**The fix: two physics checks** (`detection/src/debris.js`), run on every track next to the wingbeat check.

1. **Gravity arc: does it fall like a thrown object?** Gravity bends a thrown object's path into a
   parabola. We fit a parabola to the last ~1.2 s of the path and measure the pull:
   `pull = downward acceleration ÷ the object's own length` (per s²). Gravity on a 5–30 cm rock gives
   30–200+. A bird is much bigger and flies on its own power: even a sharp turn stays under ~25.
   Dividing by size means it works at any distance without calibrating the camera.
   All three must hold: the path fits a clean arc, the pull points down, and it's stronger than 25.
   → the track becomes **debris**: shown on screen with the reason, but it never raises the risk level,
   never joins a flock, and the beacon never points at it.
2. **Spin: does it turn end over end?** We follow the angle of the object's long axis. A tumbling object
   keeps turning one way (we require half a turn or more, ≥70% of steps the same way). A bird's body stays
   lined up with its flight and its wings beat back and forth. A spinning object's size pulse is the spin,
   not wings → it stays **unknown** (yellow, so Gemini can still look), never "bird".

Also: a group only counts as "birds by numbers alone" once each member's path has been checked and
cleared, so thrown gravel can't become a flock in the half-second before the check has enough data.

**Order of trust** when labelling a track: Gemini/human verdict → physics (debris, spin) → steady + drone
sound = drone → wingbeat = bird → COCO-SSD second opinion.

**Settings** (`config.js` → `debris`, also in the tuning registry): `minPull` 25 (raise if diving birds get
called debris; lower if rocks still get called birds), `maxFitRatio` 0.35, `minTurnDeg` 180.

**How it was checked.** New synthetic scenes with physically consistent rocks (an ~8 px, ~12 cm rock seen
from ~10 m falls at ~420 px/s²): `rock_throw`, `debris_shower`, `spinning_debris`, plus guards that must stay
birds: `bird_descending` (gliding down) and `bird_circling` (path curves the whole time).
13 scenes × 10 seeds: 129/130 pass. The one miss is the old `bag` scene on seed 5, which was already
called a bird before this change (a plastic bag drifting with an accidental rhythm; not ballistic, not spinning).
All 45 earlier engine tests still pass; new unit tests cover both checks.

**Limits.** A bird diving with folded wings could in principle pass the gravity test (it's falling);
the size-relative pull keeps most real birds out, but it's a known edge case. Debris that drifts slowly
without spinning (a bag in the wind) is not covered by either test. All checks here are on synthetic
scenes; real clips of thrown objects would be the next test.

## Fewer false "drone heard" alarms from the browser mic

**The problem.** Without a trained audio model, the website listens with `HumDetector`: "a strong, steady
tone = drone". Planes, helicopters, car engines, cows and washing machines are steady tones too. On the
held-out test sounds it raised "drone heard" on 62% of airplanes, 62% of engines, 46% of helicopters and 36%
of ordinary outdoor recordings, and a sound on its own goes straight to red.

**The fix: three extra checks per reading** (`detection/src/audio.js`). A reading counts as drone only if:
1. **Clear tone:** the strongest peak is at least 30 dB above the background.
2. **Drone pitch:** that peak is 180 Hz or higher (small props spin fast; rotors, engines and planes hum lower).
3. **Short overtone ladder:** at most 5 strong overtones. Engines and rotors make long ladders.
`hum.last` says why the last reading was accepted or rejected (e.g. "pitch too low for a drone").

**How the numbers were chosen.** Following the benchmark rules: thresholds picked on training audio only
(DADS training files 2, 5, 10 and ESC-50 folds 4–5), then checked once on the held-out test audio
(DADS files 3 and 36, ESC-50 folds 1–3):

| Held-out test audio | "drone heard" before | after |
|---|---|---|
| Drone recordings (400 clips) | 97.8% | 94.5% |
| All non-drone sounds (1,400 clips) | 29% | 4% |
| Airplane / engine / helicopter | 62% / 62% / 46% | 4% / 0% / 4% |
| Ordinary outdoor recordings | 36% | 2% |

**Limits.** Drone recall drops about 3 points. Door knocks, church bells and wind still trigger it 20–33% of
the time. A very loud, close drone with many strong overtones could be rejected by check 3. The trained audio
model (benchmarks v0) is far better than any hand-made rule; the browser should use it when it can.

## Optional trained bird verification
Tower now checks sufficiently large, stable tracked crops with COCO-SSD, using locally served TensorFlow/model assets. It adds bird evidence without inventing a drone class and keeps the motion pipeline active when disabled or unavailable. Tests verify label fusion and reject stale/invalid labels. No frozen dataset, training weights or held-out test manifest was changed. Synthetic startup regressions are separate from the benchmark protocol and do not establish drone recall or false-alarm rate.

## Fewer bags called "birds" (beat-repeat check)

**The problem.** The engine calls something a bird when its outline pulses at a steady rhythm (a wingbeat).
A plastic bag tumbling in the wind changes size randomly, but sometimes its wobble lines up by chance to look
like one beat. In a stress test (the `bag` scene, 20 random seeds), the bag was labelled "bird" in 5/20 runs
at 30 fps and 2/20 at 15 fps.

**The fix** (`detection/src/wingbeat.js`, setting `wingbeat.minRepeat` = 0.3). A real wingbeat keeps going, so the
size signal also matches itself **two beats later**, not just one. A chance wobble usually only lines up once.
If the match two beats later is below 0.3, the reading is not counted as flapping (`vetoed: 'beat_does_not_repeat'`).
If the window is too short to hold two beats, the check is skipped. `minRepeat: -1` turns it off.

**How the number was chosen.** Tried 0, 0.1 … 0.5 on seeds 1–20 only (tuning), then checked 0.3 once on fresh
seeds 101–140 that were never used for tuning:

| Fresh seeds 101–140 (13 scenes × 40) | before | after |
|---|---|---|
| Bag wrongly called "bird", 30 fps (laptop preset) | 14/40 | 10/40 |
| Bag wrongly called "bird", 15 fps (phone preset) | 14/40 | 9/40 |
| Real birds not recognised (5 bird scenes) | 0 | 0 |
| Missed hazards | 0 | 0 |
| False alarms (15 fps; same 2 runs before and after) | 2 | 2 |

**Limits.** Synthetic scenes only; this is **not** a benchmark version (the real test sets in `data/` were not
available here), so it says nothing yet about drone recall or false-alarm rate on real clips. 28→19 of 80 bag runs
is a real-looking drop but **not statistically significant** on its own. Bags are still called birds about 1 in 4 times.
Not yet copied into the website (`npm run sync-web`), because that changes app code.

## Bird-count forecaster (are birds gathering?)

**What it does** (`detection/src/forecast.js`, settings in `config.js` → `forecast`). Every half second it counts the
birds in view, fits a trend line over the last 20 s, and predicts the count 15 s ahead.
- **Rising** (at least 6 more birds a minute, clearly above zero, 2+ more birds, arriving at 2+ separate moments)
  → at least **yellow**, reason "Bird numbers rising: 3 now, ~8 in 15 s".
- Rising by 3+ birds **and** the forecast reaches a flock (5+, `risk.flockRed`) → **red**, before the flock exists.
- The engine state and every event now carry `forecast: { trend, birds_now, per_min, predicted, horizon_sec }`
  (`trend` is rising / steady / falling / learning / off).

**Edge cases handled.**
- Recognising a bird takes a second or two, so birds already in view would look like they were "arriving" one by one.
  Each bird is counted from when its track was **first seen**, and the first 1.5 s after start-up is the baseline.
  (Without this, 4 birds flying *out* of view went red.)
- A track lost for a moment stays counted for 2 s, so it isn't "a bird left, a bird arrived".
- A group arriving together is a flock (handled by the flock rule), not a trend.

**Checked on synthetic scenes:** `birds_gathering` (4 gulls arriving ~2.5 s apart, never a flock of 5) goes red at ~9 s
in 12/12 runs; `birds_leaving` stays yellow in 12/12; all other scenes unchanged (150/150 at 15 fps). 5 new unit tests.
Synthetic only: real gathering clips are the next test.

## Rare cases: 15 new test scenes, and dense flocks (murmurations)

**New scenes** (`synthetic.js`, marked `edge: true`): a drone hovering still (with and without sound), a gull close
to the camera, a hawk gliding without flapping, a fast swift, two birds crossing paths, a sudden auto-exposure jump,
a grainy low-light flock, a drone next to a flock, an insect near the lens, a bird flying toward the camera, a
murmuration, dark fast storm clouds, and a camera swaying on a pole (with a flock, and with empty sky). Scenes can now
set their own sensor noise, exposure, cloud strength/speed and camera jitter.

**What they found.** All passed at 30 and 15 fps except two:
1. **Murmuration (30 starlings packed together) only reached yellow: a missed hazard.** Their outlines merge into one
   blob that looks like one steady unknown object.
2. **Dark, fast storm clouds raise a false yellow** (never red). Still open, see below.

**Fix for 1: count dark cores inside a blob** (`blobs.js` → `countCores`, `engine.js` → `updateDense`, settings in
`config.js` → `flocks.dense*`). Each packed bird is still a darker spot with lighter gaps around it; a plane, drone or
single bird is one solid shape. Measured over all scenes: the murmuration reads ~27 cores (truth 30), everything else
reads 1. Cloud edges briefly read 5–13, so a blob only counts as a dense flock when, over the last second, it was seen
every frame, 80% of its counts were 5+, and its size changed less than 2x. Then it is a bird flock of that many birds
(size feeds the risk rule and the forecaster). Result: murmuration red in 16/16 runs (~1.6 s); storm clouds never red;
no other scene changed (150/150 at 15 fps and 30 fps, apart from the two known issues).

**Tried and removed:** a "spreading like a cloud" rule (tracks that grow steadily >4x in 1 s). It didn't remove the
storm-cloud yellow, because the yellow is raised the moment a cloud edge is first tracked, before any check has data.
Waiting 0.5 s before an unknown raises yellow did remove it, but it also stopped thrown rocks from ever showing yellow, so
that was removed too. **Open issue:** storm clouds → brief false yellow (`knownIssue` on the scene, skipped by the
"every scene passes" test, still checked never to go red).

## Auto-tuning the engine settings (tools/autotune.mjs)

**What it does.** Tries each of 20 detection settings a little higher and lower, one at a time, on the synthetic
scenes (seeds 1–3), and keeps a change only if the total score improves by more than 1 point without adding a single
miss, false alarm or wrong label. Then it compares defaults vs tuned once on fresh seeds 101–110 at 30 fps (laptop)
and 15 fps (phone preset). Rule-defining settings (`risk.flockRed`, `risk.etaRedSec`) and ones the synthetic scenes
can't judge (audio, COCO, corridor) are not tuned. Rerun: `node VIVAN/detection/tools/autotune.mjs`. The full
report is `tuning/autotune-2026-11-19.json`.

**Result: one change, `motion.threshold` 16 → 20** (every other setting was already at its best on these scenes):

| Fresh seeds 101–110 (30 scenes × 10) | 16 (before) | 20 (after) |
|---|---|---|
| False alarms, 30 fps | 2 | **0** |
| False alarms, 15 fps phone preset | 7 | **1** |
| Missed hazards | 0 | 0 |
| Wrong labels (the bag) | 2 / 2 | 2 / 2 |

The false alarms were storm-cloud edges. **Trade-off:** the camera is slightly less sensitive to very faint objects.
The grainy-camera and distant-flock scenes still pass, and on noisy cameras the threshold already rises by itself
(`noiseK`), but real faint, far-away birds are the thing to watch. If they're missed, the `distant_birds` preset sets 12.

**Known issues, now marked in `synthetic.js`:** the bag is labelled "bird" about 1 run in 4 (risk is still right),
and storm clouds give a rare false yellow. The "every scene passes" test still demands the right risk level for the bag.

## Drone-sound model: 3 retraining experiments (v1–v3), and portable formats

Retrained the sound model on the real recordings (DADS, pinned revision `981b832`) with ESC-50 sounds from folds 4–5
only, and scored every version on data never used for training: DADS shards 3/36, ESC-50 folds 1–3, and drone clips
with wind/rain/engine noise mixed in. Full tables and decisions are in `benchmarks/CHANGELOG.md`.

| | v0 (live) | v1 noise mixed in | v2 look-alike sounds as "no drone" | v3 both |
|---|---|---|---|---|
| Drone recall, clean | 99.6% | 99.6% | 98.7% (worse) | 99.6% |
| False alarms on everyday sounds | 3.7% | 12.3% (worse) | **1.2% (better)** | 7.5% (worse) |
| Drone recall, noise as loud as the drone | 60% | 98% (better) | 52% | **98% (better)** |

**None beats v0 on both headline metrics, so v0 stays on the website** (recommended; Vivan decides). v2 trades about 1%
of clean drone recall for 3× fewer false alarms; v3 hears drones through loud noise but false-alarms on helicopters.
All three are saved in `models/audio/candidates/` as browser JSON + ONNX + model card. To switch, copy one to
`VIVAN/detection/models/`, change the file name in `PRANAV/public/js/camera.js`, and run the sync.

**Portable formats.** Every sound model now exists as the browser JSON, an ONNX file (open standard; onnxruntime runs
it in Python, C++, phones and browsers) and a `.card.json` saying exactly how to feed it, all checked to give the same
answers. The scorer reads the browser JSON directly, and proved v0's JSON matches the original. The dataset
download needed Hugging Face added to the session's network (the official ESC-50 archive on GitHub was blocked, so a
complete Hugging Face mirror was used: all 2,000 clips).

**Not done:** the audio test sets are still not frozen in `test_sets.json` (that changes the manifest and needs your
approval), so these are held-out checks, not official `benchmark.py` versions.
