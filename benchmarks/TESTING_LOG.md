# SkySentry detection: testing log

Real events only. Benchmark results are added here (and in `results.csv`) as each version actually runs.
Illustrative example charts live in `benchmarks/demo/` and are NOT results.

## 2026-10-10: benchmark infrastructure

| Step | What happened | Outcome |
|---|---|---|
| Rules | `BENCHMARK_PROTOCOL.md` + `CLAUDE.md`: frozen checksummed test sets, one change per version, append-only results, 95% bootstrap CIs, overlap = "not significant", leakage checks | Done |
| Pipeline self-test | Full run (benchmark, decide, charts, report) on synthetic data in a scratch folder | **Passed**; a tampered test file and a re-run of a finished version were both **refused** as designed |
| Chart review | Rendered charts inspected by eye | Fixed a missing glyph, non-integer SNR ticks, a redundant legend label, a negative axis floor |

## 2026-10-10: dataset audit (before any model was benchmarked)

| Check | Finding | Action |
|---|---|---|
| Mendeley v5 download | SHA-256 matches the authors' published hash | Accepted |
| Mendeley labels | **Birds and drones share one class id**: all 58,937 train boxes and 1,782 valid boxes are class 0; only 89 of 378 test bird boxes were class 1 | Classes taken from file names (B = bird, D = drone); a model trained on the published labels would call every bird a drone. Aborted the first training run after 95 batches |
| Duplicate annotation | Test image `BT (21)`: one bird outlined twice | Merged (IoU ≥ 0.5) |
| Near-duplicates inside test | **889 test images = 176 groups** of consecutive video frames (largest group 55 frames) | CIs resample groups, not images (a per-image CI would be ~2.2× too narrow) |
| Train/test leakage (pHash) | 0 exact and 0 near-duplicates (Hamming ≤ 6); 33 test images within 8–12 bits of a train image | Clean at the protocol threshold; pHash isn't rotation-robust, noted as a caveat |
| Test-set balance | 378 bird / 526 drone boxes; **only 8 small birds and 73 small drones** | Small-target recall will have wide CIs; field clips needed |
| DADS layout | Sorted by label; drone clips (~0.6 s) cut from long recordings in order | Test set = whole held-out shards (3, 36); ~30 s block bootstrap |
| ESC-50 | No "traffic" class; first download cut off at 504 MB | Traffic = engine (44); complete archive required before freezing; folds 1–3 test-only |
| Field videos | 5 files = 3 unique (2 byte-identical pairs); faces in some segments | Duplicates removed; sky segments only; tier 2 frozen once 15–20 clips exist |

## Versions

| Version | Status |
|---|---|
| v0 | Training in progress: YOLO11n (labels from file names) epoch 2/40; audio CNN starts when DADS shards arrive. No results yet. |
