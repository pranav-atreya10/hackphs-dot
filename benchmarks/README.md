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
