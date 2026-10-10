# SkySentry Detection Benchmark Protocol

These rules apply to **every** change to SkySentry's detection system, in every session, by every
person or AI assistant. Their purpose: show honest, measurable improvement across versions, and
never claim a gain that is noise or leakage.

If anything here conflicts with a request, stop and ask the detection lead (Vivan) before acting.

---

## 1. Frozen test sets

- Test sets are **frozen**. Never train on, tune on, edit, add to, or remove from them.
- `benchmarks/test_sets.json` lists every test file with its **SHA-256 checksum**. Every benchmark
  run verifies all checksums first and **refuses to run** if any file is missing, added, or changed.
- If a test file is broken or unreadable: **stop and ask**. Do not fix, replace, or skip it.
- The manifest itself is only ever changed with explicit approval, and the change is logged in
  `benchmarks/CHANGELOG.md` with the reason. Results from before and after a manifest change are
  not comparable and must be labelled as such on every chart.

## 2. The three tiers

### Tier 1: Dataset test split
- The **Mendeley dataset's own test folder**, used as published
  (Mendeley Data `6ghdz52pd7`, version 5, `Dataset.zip`, SHA-256 `5bf5b257…c51c`).
- A **fixed held-out slice of DADS** (Hugging Face `geronimobasso/drone-audio-detection-samples`,
  pinned revision in `data/dads/REVISION`), chosen once with a fixed random seed (recorded in
  `test_sets.json`), with the exact file list saved. The slice never changes.
- **DADS is stored sorted by label, and drone clips (~0.6 s) are cut from longer recordings in
  order.** Neighbouring rows are therefore likely the same recording. The test slice is made of
  **whole contiguous shard blocks held apart from training**, never randomly scattered rows, so
  pieces of one recording can't land in both train and test. It must contain both classes.

### Tier 2: Field set (`test_media/`)
- Our own footage and recordings, split once into **`tune`** and **`holdout`** halves (split
  recorded in `test_sets.json`). Byte-identical duplicates count once (matched by SHA-256), and
  clips from the same recording session go in the same half.
- **Privacy: the repo is public.** Only the **sky segments** of each clip are benchmarked (start/end
  times stored in the manifest). Frames showing people are never saved to `benchmarks/`
  (error galleries, reports, charts). `test_media/` itself is git-ignored.
- Tier 2 is frozen only once there are enough clips to be meaningful (target 15–20 unique clips:
  birds, empty sky, distractors, drone). Until then, versions run on tiers 1 and 3, and this is
  stated on every report.
- Thresholds and any other settings are tuned **only on `tune`**.
- **`holdout` runs only when Vivan says "final run"** (`benchmark.py --final`, plus a confirmation
  checkbox in the testbench). Never peek at holdout results to make a decision.

### Tier 3: Stress set
- **Audio:** drone audio mixed with ESC-50 **wind (16), rain (10), traffic** at **+10, +5, 0, −5, −10 dB SNR**.
  ESC-50 has no traffic category, so **traffic = engine (44)**. The mixes are generated once with a
  fixed seed and then frozen like any other test file.
- **Audio look-alikes (false-alarm tests):** ESC-50 **helicopter (40)** and **airplane (47)**, which
  must not trigger a drone alert at an airport, and **chirping birds (14)** and **crow (9)** as
  bird-only audio.
- ESC-50 must be the complete, CRC-verified archive (all 40 clips per category). A partially
  downloaded copy is never frozen.
- **Images:** tagged by **target size** (box area / image area: small < 1%, medium 1–10%,
  large > 10%) and by **condition** (clear sky, cloudy, backlit/sunny, cluttered background).
  Tags are stored in the manifest, not inferred at run time.
- **False-alarm material:** bird-only images, and long bird-only/ambient audio (for false alarms per hour).

## 3. Versions: one change at a time

- Versions are numbered **v0, v1, v2, …**. v0 is the baseline.
- **Exactly one change per version.** If a change needs two parts (e.g. new weights *and* a new
  threshold), it is two versions.
- The **hypothesis is written before running**, and passed as `benchmark.py --hypothesis "..."`.
  It names the metric expected to move and in which direction.
- After running, `decide.py --keep` or `--revert` records the **decision and a reason**.
- **Reverted versions stay in the log** and on the charts (visually distinct). Nothing is deleted.
- "Current best" = the most recent **kept** version.

## 4. Records are append-only

- `benchmarks/results.csv` is **append-only**: new rows only, never edited or removed.
  Decisions are recorded as new rows of type `decision`, not by editing old rows.
- Each version's outputs live in `benchmarks/vN/` and are **never overwritten**. Re-running a
  version requires a new version number.
- Every run records, for reproducibility:
  - git commit hash (and whether the working tree was dirty, which is allowed only for v0)
  - SHA-256 of every model weight file used
  - every threshold and setting
  - hardware (CPU, GPU/accelerator, RAM, OS) and library versions
  - the random seeds used

## 5. Metrics and significance

- **Headline metrics: drone recall and false-alarm rate.** Everything else is supporting detail.
- **Every metric is reported with a 95% bootstrap confidence interval**:
  1,000 resamples of the test items with replacement, percentile method (2.5th–97.5th), fixed seed.
  The resampling unit is the item (image, clip, or recording), never individual boxes or windows,
  so correlated predictions aren't counted as independent evidence.
- **Significance rule:** if a version's CI **overlaps** the current best's CI for a metric, that
  change is flagged **"not significant"** for that metric, on every table, chart, and report.
  (Overlapping CIs is a deliberately conservative test: it would rather miss a small real gain
  than claim a fake one.)
- A version may only be described as an improvement for a metric where it is **significant**.

## 6. Leakage checks

If a result looks suspiciously good (e.g. a jump much larger than the change could plausibly
cause, or near-perfect scores), **check for test-set leakage before reporting it**:
- **Images:** perceptual hash (pHash) of every train and test image. Pairs with Hamming
  distance ≤ 6 are near-duplicates.
- **Audio:** fingerprint each clip (e.g. log-mel embedding); pairs with cosine similarity
  ≥ 0.97 are near-duplicates. Exact duplicates are found by SHA-256.
- Also check **source overlap**: frames from the same video, or clips from the same recording
  session, in both train and test.
- Report the leakage-check result with the number. If leakage is found, stop and ask.

## 7. When to stop and ask

Stop and ask Vivan before:
- deleting anything
- downloading anything other than ESC-50
- changing the frozen test sets or their manifest
- touching SkySentry app code (the testbench and benchmarks are separate from the app)
- running the `holdout` half (only on "final run")
- reporting a result that failed or skipped the leakage check

## 8. Folder layout

```
benchmarks/
  BENCHMARK_PROTOCOL.md   this file
  test_sets.json          frozen manifest + checksums + seeds + splits + tags
  results.csv             append-only, one row per run / decision
  CHANGELOG.md            hypothesis, decision, and reason per version
  SUMMARY.md              one-page overview across versions (for the pitch)
  charts/                 PNG (300 dpi) + SVG, regenerated from results.csv + predictions
  vN/
    predictions.parquet   raw per-item predictions (metrics recomputable without rerunning models)
    metrics.json          every metric with its CI
    run.json              commit, weight hashes, thresholds, hardware, seeds, hypothesis
    errors/               20 worst false positives + 20 worst false negatives per model, tagged
    report.html           readable single-page report
testbench/                standalone Streamlit app, separate from the SkySentry app
```

## 9. The iteration loop

Every time, without needing a reminder:
1. State the hypothesis.
2. Make **exactly one** change.
3. Run `benchmark.py --version vN --hypothesis "..."`.
4. Show a before/after comparison against the current best, with significance flags.
5. Ask Vivan: keep or revert?
6. Run `decide.py` with the decision and reason.
7. Regenerate charts (`make_charts.py`) and reports (`report.py`).
