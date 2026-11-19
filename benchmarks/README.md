# benchmarks/

Benchmarking for SkySentry's detection system. Separate from the SkySentry app.
Rules: [BENCHMARK_PROTOCOL.md](BENCHMARK_PROTOCOL.md). History: [TESTING_LOG.md](TESTING_LOG.md), [CHANGELOG.md](CHANGELOG.md).

## Layout

| Path | What it is |
|---|---|
| `BENCHMARK_PROTOCOL.md` | The rules every change follows |
| `TESTING_LOG.md` | Real testing events, dataset audit findings, chart index |
| `CHANGELOG.md` | Per-version hypothesis + keep/revert decision; test-set changes |
| `test_sets.json` | **Frozen** test-set manifest (SHA-256 per file); never edit by hand |
| `test_sets_archive/` | Earlier freezes, kept when a re-freeze is approved |
| `leakage_report.json` | Train/test near-duplicate check results |
| `results.csv` | Append-only: one row per benchmark run and per decision (appears after v0) |
| `v0/`, `v1/`, … | Each version's outputs: predictions, metrics, run record, errors, `report.html` |
| `charts/stages/` | Development-stage charts from real data (dataset audit, training) |
| `charts/` (top level) | Benchmark result charts from `make_charts.py` (after versions run) |
| `demo/` | **Illustrative** charts from simulated numbers (titled as such); not results |
| `bench/` | Shared library: metrics, bootstrap CIs, manifest checks, audio/visual inference |
| `train/` | Model training scripts (YOLO, audio CNN) |

## Commands, in order (run from the repo root)

| Step | Command |
|---|---|
| Set up | `python3 -m venv .venv && .venv/bin/pip install -r testbench/requirements.txt` |
| Pipeline self-test | `.venv/bin/python benchmarks/selftest.py` |
| Freeze test sets (once) | `.venv/bin/python benchmarks/freeze_test_sets.py visual\|audio\|stress …` |
| Leakage check | `.venv/bin/python benchmarks/leakage_check.py --images <train image dir>` |
| Train | `benchmarks/train/train_yolo.py …`, `benchmarks/train/train_audio.py …` |
| Benchmark a version | `.venv/bin/python benchmarks/benchmark.py --version vN --hypothesis "…"` |
| Record keep/revert | `.venv/bin/python benchmarks/decide.py --version vN --keep\|--revert --reason "…"` |
| Charts + report | `.venv/bin/python benchmarks/make_charts.py && .venv/bin/python benchmarks/report.py --version vN` |
| Stage charts | `.venv/bin/python benchmarks/stage_charts.py` |
| Testbench | `.venv/bin/streamlit run testbench/app.py --server.port 8502` |

Each version is defined by one config file, `models/versions/vN.json` (weights, thresholds, imgsz).
Datasets live in the git-ignored `data/`; field videos in the git-ignored `test_media/`.

## Airport pilot qualification

**Site qualification is blocked.** Dataset and stress results are not independent airport
performance evidence. A kept benchmark or a benchmark with `--final` does not qualify a site.

1. Before collecting or accessing the site holdout, have the detection lead and site safety
   owner approve a validation plan and pin its SHA-256 in protected release configuration.
   Define required conditions (e.g. weather, lighting, clutter), positive encounters and
   negative exposure (e.g. birds, aircraft, ambient conditions), ground truth, matching and
   alert deduplication rules, minimum exposure, confidence interval methods and limits.
2. With site permissions and the detection lead's separate **"final run"** authorization, use
   independent sessions not used in development. Audit duplicates and session leakage and
   observe the frozen-data rules. Record misses, false alarms, outages, alert timing, and
   exclusions; do not silently drop failed sessions. Compute 95% intervals with 1,000 seeded
   bootstrap resamples by independent recording session, not by frame. For sparse or perfect
   outcomes, also use conservative bounds appropriate to the exposure rather than accepting
   a degenerate bootstrap interval. Do not tune on the site holdout.
3. Keep raw material private. Have an independent reviewer audit the field bundle (session
   inventory, provenance, annotations, alerts, interval calculation, hashes, safety and leakage
   review) against the pre-approved plan and record its digest in the results. Only a trusted
   release approver may pin the reviewed results digest. Never take expected digests from the
   same untrusted submission. Pin the exact release artifact (code, models and settings) and
   installation (camera/microphone placement, geometry, firmware and hardware) too.

Run the read-only release check with externally approved values:

```
python benchmarks/site_release_gate.py --site SITE --release-sha256 RELEASE_HASH --installation-sha256 INSTALLATION_HASH --plan PLAN.json --plan-sha256 PLAN_HASH --evidence EVIDENCE.json --evidence-sha256 EVIDENCE_HASH
```

Missing or mismatched evidence, insufficient observations, or a failing confidence bound
returns a nonzero exit status. The checker verifies structure and consistency, not signers,
raw evidence, or statistical methodology. It is not wired to deployment and a pass is not
authorization for operational use.

Both JSON objects have `schema: 1`, `site`, `release_sha256`, `installation_sha256`, and
`strata` (an object keyed by approved condition names). Each stratum contains exactly
`drone_recall` and `false_alarms_per_hour`. In the plan each metric holds `limit`, `min_sessions`,
and `min_exposure`. In the evidence each metric holds `sessions`, `exposure`, `count`, `value`,
`lo`, and `hi`. Exposure is annotated drone encounters for recall, negative observation hours
for false alarms; count is detected encounters or deduplicated false alerts, respectively.
The recall lower bound must meet the approved minimum and the false-alarm upper bound must
meet the approved maximum. Evidence also holds `plan_sha256`, `evidence_bundle_sha256`,
`dataset_kind: "independent_airport_field"`, `leakage_check: "passed"` and
`bootstrap_resamples: 1000`. Neither plan nor evidence is shipped with this repository.
