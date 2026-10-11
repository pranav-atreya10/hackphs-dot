"""Per-version HTML report + one-page SUMMARY.md across versions.

    .venv/bin/python benchmarks/report.py --version v1
"""

import argparse
import html
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench.common import BENCH, read_results  # noqa: E402
from bench.stats import significant  # noqa: E402

HEAD = [("visual", "drone_recall", "Visual drone recall", True, "{:.3f}"),
        ("visual", "fa_rate", "Visual false-alarm rate", False, "{:.3f}"),
        ("visual", "mAP50", "Visual mAP50", True, "{:.3f}"),
        ("visual", "drone_as_bird_rate", "Drones mistaken for birds", False, "{:.3f}"),
        ("audio", "recall", "Audio drone recall", True, "{:.3f}"),
        ("audio", "fa_per_hour", "Audio false alarms / hour", False, "{:.2f}"),
        ("audio", "roc_auc", "Audio ROC-AUC", True, "{:.3f}")]


def versions():
    rows = read_results()
    dec = {r["version"]: r for r in rows if r["row_type"] == "decision"}
    runs = [r for r in rows if r["row_type"] == "run"]
    for r in runs:
        r["metrics"] = json.loads(r["metrics_json"])
        r["decision_row"] = dec.get(r["version"])
    return runs


def best_before(runs, version):
    """Most recent KEPT version before `version`."""
    prior = []
    for r in runs:
        if r["version"] == version:
            break
        if r["decision_row"] and r["decision_row"]["decision"] == "keep":
            prior.append(r)
    return prior[-1] if prior else None


def delta_cell(new, old, higher, fmt):
    if not new or not old:
        return "<td class='muted'>—</td>"
    d = new["value"] - old["value"]
    sig = significant(new, old)
    better = (sig == "higher" and higher) or (sig == "lower" and not higher)
    worse = (sig == "lower" and higher) or (sig == "higher" and not higher)
    cls = "good" if better else "bad" if worse else "ns"
    icon = "▲" if d > 0 else "▼" if d < 0 else "="
    label = "significant" if cls in ("good", "bad") else "not significant"
    return f"<td class='{cls}'>{icon} {fmt.format(d) if d < 0 else '+' + fmt.format(d)}<br><small>{label}</small></td>"


def report(version):
    runs = versions()
    run = next((r for r in runs if r["version"] == version), None)
    if not run:
        raise SystemExit(f"No run for {version} in results.csv")
    v0 = runs[0]
    prev = best_before(runs, version)
    m = run["metrics"]
    d = run["decision_row"]
    meta = json.loads((BENCH / version / "run.json").read_text())
    rows = []
    for mod, key, label, higher, fmt in HEAD:
        v = m.get(mod, {}).get(key)
        if not v:
            continue
        rows.append(f"<tr><td>{label}<br><small class='muted'>{'higher' if higher else 'lower'} is better</small></td>"
                    f"<td class='num'><b>{fmt.format(v['value'])}</b><br><small>[{fmt.format(v['lo'])}, {fmt.format(v['hi'])}]</small></td>"
                    f"{delta_cell(v, v0['metrics'].get(mod, {}).get(key) if v0['version'] != version else None, higher, fmt)}"
                    f"{delta_cell(v, prev['metrics'].get(mod, {}).get(key) if prev else None, higher, fmt)}</tr>")
    charts = sorted((BENCH / "charts").glob("*.png")) if (BENCH / "charts").exists() else []
    errs_p = BENCH / version / "errors" / "index.json"
    errs = json.loads(errs_p.read_text()) if errs_p.exists() else {"visual": [], "audio": []}
    gallery = "".join(f"<figure><img src='errors/{html.escape(e['file'])}' loading='lazy'><figcaption>{html.escape(caption(e))}</figcaption></figure>"
                      for e in errs["visual"] + errs["audio"])
    rel = os.path.relpath(BENCH / "charts", BENCH / version)
    chart_html = "".join(f"<figure class='chart'><img src='{rel}/{c.name}'></figure>" for c in charts)
    warn = ""
    if meta.get("suspicious"):
        warn = f"<div class='warn'>⚠ Suspiciously large change: {html.escape('; '.join(meta['suspicious']))}. Check for leakage before reporting.</div>"
    tiers = ", ".join(meta.get("tiers_run", []))
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SkySentry {version} report</title><style>
:root{{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--line:#e1e0d9;--good:#006300;--bad:#d03b3b}}
body{{margin:0 auto;max-width:1100px;padding:24px 16px;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}}
h1{{font-size:28px;margin:0 0 4px}} h2{{font-size:20px;margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}}
.muted{{color:var(--muted)}} table{{border-collapse:collapse;width:100%}} td,th{{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}}
.num{{font-variant-numeric:tabular-nums}} .good{{color:var(--good)}} .bad{{color:var(--bad)}} .ns{{color:var(--ink2)}}
.pill{{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid var(--line);font-weight:600}}
.warn{{background:#fff4e5;border:1px solid #fab219;padding:10px;border-radius:8px;margin:12px 0}}
.gallery{{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}} figure{{margin:0}} img{{max-width:100%;border-radius:6px}}
figcaption{{font-size:13px;color:var(--ink2)}} .chart{{margin:12px 0}}
</style></head><body>
<h1>SkySentry detection — {version}</h1>
<div class="muted">{html.escape(run['timestamp_utc'])} · commit <code>{run['git_commit'][:10]}</code> · tiers: {tiers}{' · FINAL RUN (holdout)' if run['final_run'] == 'True' else ''}</div>
{warn}
<h2>Hypothesis</h2><p>{html.escape(run['hypothesis'])}</p>
<h2>Decision</h2><p><span class="pill">{html.escape(d['decision'].upper()) if d else 'PENDING'}</span> {html.escape(d['reason']) if d else 'Awaiting keep/revert.'}</p>
<h2>Headline numbers (95% bootstrap CI)</h2>
<table><tr><th>Metric</th><th>{version}</th><th>Δ vs v0</th><th>Δ vs previous best{f' ({prev["version"]})' if prev else ''}</th></tr>{''.join(rows)}</table>
<p class="muted">A change is called significant only when the two 95% CIs don't overlap.</p>
<h2>Charts</h2>{chart_html or '<p class="muted">Run make_charts.py.</p>'}
<h2>Error gallery (worst 20 false positives / negatives per model)</h2><div class="gallery">{gallery or '<p class="muted">No errors saved.</p>'}</div>
<h2>Reproducibility</h2><pre style="white-space:pre-wrap;font-size:13px">{html.escape(json.dumps({k: meta[k] for k in ('weights', 'config', 'hardware', 'manifest_sha256', 'n_test_files_verified', 'seeds')}, indent=1, default=str))}</pre>
</body></html>"""
    (BENCH / version / "report.html").write_text(page)
    print(f"wrote benchmarks/{version}/report.html")


def caption(e):
    bits = [e["kind"].upper(), e.get("class") or e.get("tier") or "", f"score {e.get('score', e.get('prob'))}"]
    for k in ("size", "condition", "noise_type"):
        if e.get(k):
            bits.append(str(e[k]))
    if e.get("snr_db") is not None:
        bits.append(f"{int(e['snr_db']):+d} dB")
    return " · ".join(b for b in bits if b)


def summary():
    runs = versions()
    lines = ["# SkySentry detection — benchmark summary", "",
             "Every number is a 95% bootstrap CI over frozen test sets (protocol: `benchmarks/BENCHMARK_PROTOCOL.md`).", "",
             "| Version | Decision | Hypothesis | Visual drone recall | Visual FA rate | Audio drone recall | Audio FA / hour |",
             "|---|---|---|---|---|---|---|"]
    for r in runs:
        m = r["metrics"]

        def cell(mod, key, fmt="{:.3f}"):
            v = m.get(mod, {}).get(key)
            return f"{fmt.format(v['value'])} [{fmt.format(v['lo'])}–{fmt.format(v['hi'])}]" if v else "—"
        dec = r["decision_row"]["decision"] if r["decision_row"] else "pending"
        lines.append(f"| {r['version']} | {dec} | {r['hypothesis'][:80]} | {cell('visual', 'drone_recall')} | {cell('visual', 'fa_rate')} "
                     f"| {cell('audio', 'recall')} | {cell('audio', 'fa_per_hour', '{:.2f}')} |")
    lines += ["", "Charts: `benchmarks/charts/`. Per-version detail: `benchmarks/vN/report.html`.", ""]
    (BENCH / "SUMMARY.md").write_text("\n".join(lines))
    print("wrote benchmarks/SUMMARY.md")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    a = ap.parse_args()
    report(a.version)
    summary()


if __name__ == "__main__":
    main()
