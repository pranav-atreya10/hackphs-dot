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
