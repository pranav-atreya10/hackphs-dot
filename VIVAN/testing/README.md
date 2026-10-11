# Detection engine testing: latest changes

Charts for the two latest detection-engine changes, from measured data (no simulated numbers).
Explanations of the changes themselves are in [`../VIVAN.md`](../VIVAN.md).

| Chart | Shows |
|---|---|
| `charts/01_debris_before_after.png` | Thrown rock, gravel shower, spinning debris: % of runs called "bird" and % that went red, before vs after the debris check |
| `charts/02_all_scenes_pass_rate.png` | Every synthetic scene, before vs after: no bird scene got worse |
| `charts/03_gravity_pull_debris_vs_birds.png` | The measurement behind the debris check: gravity pulls debris far harder (relative to its size) than birds pull themselves; threshold 25 |
| `charts/04_hum_heldout_before_after.png` | Browser mic "drone heard" rate per sound on held-out test audio, before vs after the 3 drone checks |
| `charts/05_hum_threshold_choice.png` | How the mic thresholds were picked: every setting tried on training audio, old vs chosen |

## Data and how it was made

- `data/engine_compare.json`: the old engine (main before the change) and the new engine run on the same 13
  synthetic scenes with the same 10 random seeds, in a browser (the engine is browser JavaScript).
- `data/hum_heldout_by_sound.csv`: the browser hum detector (exact Python port, checked against the browser
  version) on held-out test audio: DADS test files 3 and 36, ESC-50 folds 1-3.
- `data/hum_training_threshold_search.csv`: 180 threshold combinations on training audio only
  (DADS training files 2, 5, 10; ESC-50 folds 4-5). The chosen setting was fixed here before the held-out check.

Regenerate the charts: `.venv/bin/python VIVAN/testing/make_charts.py`

Limits: the visual results are synthetic scenes, not real footage of thrown objects.
