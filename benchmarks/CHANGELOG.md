# Detection changelog

One entry per version: hypothesis, decision, reason. Reverted versions stay.

## Test-set change: dataset/visual re-frozen (2026-10-11T00:46:58Z)

Approved by Vivan: published Mendeley v5 labels put birds and drones in one class id (only 89 of ~380 bird boxes in test were class 1; all train/valid boxes class 0), so classes now come from file names (B=bird, D=drone) and the one doubly-annotated object (BT (21)) is merged. Near-duplicate consecutive frames (889 images -> ~176 groups) now carry a group id so bootstrap CIs resample groups. No results existed on the old freeze.
Old version archived: `benchmarks/test_sets_archive/dataset_visual_2026-10-11T004658Z.json`.

## audio v1 (held-out check, not an official benchmark version): noise augmentation

**Hypothesis (written before training, 2026-11-19).** v1 = v0 with exactly one change: half of the training windows
(drone and no-drone alike) get an ESC-50 sound from **folds 4–5 only** mixed in at −10…+20 dB (`train_audio.py
--noise_aug`, the planned "v3" augmentation). Same data, split, epochs (8), windows (12,000/class/epoch) and seed (0)
as v0. Expected: fewer false alarms on look-alike sounds (helicopter, airplane, engine) and higher drone recall in the
noisy stress mixes; clean drone recall may drop slightly.

**How it is judged.** `benchmarks/eval_audio_holdout.py` on data never used for training or tuning: DADS shards 3 and
36, ESC-50 folds 1–3, and drone + wind/rain/engine mixes at +10…−10 dB. 95% bootstrap CIs (1,000 resamples; DADS in
blocks of 25 consecutive clips). A difference counts only where the CIs don't overlap. This is not `benchmark.py`:
the audio test sets were never frozen in `test_sets.json`, and freezing them needs Vivan's approval.

**Result (eval_audio_holdout.py, 95% CIs; "significant" = CIs don't overlap).**

| Held-out metric | v0 | v1 | |
|---|---|---|---|
| DADS drone recall | 0.996 [0.995–0.998] | 0.996 [0.995–0.998] | not significant |
| DADS false-alarm rate | 0.001 [0.000–0.003] | 0.024 [0.015–0.035] | **worse, significant** |
| ESC-50 false alarms, all 1,200 clips | 0.037 [0.026–0.048] | 0.123 [0.105–0.142] | **worse, significant** |
| ESC-50 false alarms, helicopter | 0.000 | 0.208 [0.042–0.375] | **worse, significant** |
| Drone recall, noise at +5 / 0 / −5 / −10 dB | 0.86 / 0.60 / 0.40 / 0.25 | 0.99 / 0.98 / 0.92 / 0.72 | **better, significant (all four)** |

**Decision: revert (recommended, pending Vivan).** Noise robustness improved a lot, but the false-alarm rate (a headline
metric) got significantly worse, including helicopters, which are common at airports, and a sound-only drone alert goes
straight to red. Suspected cause: engine-like sounds were mixed into drone examples but rarely heard alone as "no drone".
v1 weights are kept locally (`models/audio/v1_audio.pt`, git-ignored) and not exported to the website.

## audio v2 and v3 (held-out check): look-alike sounds as "no drone" examples

**Hypothesis (written before training).** Adding the ESC-50 folds 4–5 clips on their own as extra no-drone training
examples (`--extra_negatives`) teaches the model that helicopters, planes and engines alone are not drones.
- **v2 = v0 + extra negatives** (one change from v0, the current best). Expected: false alarms on ESC-50 look-alikes
  down vs v0; noisy recall about the same as v0.
- **v3 = v1 + extra negatives** (one change from v1). Expected: keeps v1's noise robustness while bringing false alarms
  back down near v0.
Same data, split, epochs, windows and seed as v0. Judged the same way as v1.
