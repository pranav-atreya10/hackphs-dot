# CLAUDE.md

Team workflow rules (branches, PRs, explanations per person) are in `AI.md`.

## Benchmarking rules

Every change to SkySentry's detection system follows **`benchmarks/BENCHMARK_PROTOCOL.md`**.
Read it before touching detection code, models, thresholds, or anything in `benchmarks/` or `testbench/`.

The rules that must never be broken:
- **Test sets are frozen.** Never train on, tune on, edit, add to, or remove from them. Every run
  verifies `benchmarks/test_sets.json` checksums first. If a test file is broken, stop and ask.
- **Tune only on `test_media` "tune".** The "holdout" half runs only when Vivan says "final run".
- **One change per version**, with the hypothesis written before running and a keep/revert decision
  with a reason after. Reverted versions stay in the log.
- **`results.csv` is append-only; `benchmarks/vN/` is never overwritten.**
- Every run records git commit, model weight hashes, thresholds, hardware, and seeds.
- Headline metrics: **drone recall** and **false-alarm rate**. Every metric gets a 95% bootstrap CI
  (1,000 resamples); a CI overlapping the current best's is flagged **"not significant"**.
- Suspiciously good result? **Check for train/test leakage before reporting.**
- Ask before deleting anything, downloading anything other than ESC-50, changing the test sets, or
  touching SkySentry app code.
- Follow the iteration loop in section 9 of the protocol every time, without being reminded.
