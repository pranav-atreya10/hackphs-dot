"""Record the keep/revert decision for a version (appends; never edits earlier rows).

    .venv/bin/python benchmarks/decide.py --version v1 --keep --reason "drone recall up, CI clear of v0"
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench.common import CHANGELOG, append_result, now_utc, read_results  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--keep", action="store_true")
    g.add_argument("--revert", action="store_true")
    ap.add_argument("--reason", required=True)
    args = ap.parse_args()

    rows = read_results()
    runs = [r for r in rows if r["row_type"] == "run" and r["version"] == args.version]
    if not runs:
        raise SystemExit(f"No benchmark run for {args.version} in results.csv.")
    if any(r["row_type"] == "decision" and r["version"] == args.version for r in rows):
        raise SystemExit(f"{args.version} already has a decision. Decisions are final; record a new version instead.")
    decision = "keep" if args.keep else "revert"
    ts = now_utc()
    append_result({"row_type": "decision", "version": args.version, "timestamp_utc": ts,
                   "decision": decision, "reason": args.reason, "hypothesis": runs[-1]["hypothesis"]})

    run = runs[-1]
    metrics = json.loads(run["metrics_json"])
    lines = [f"\n## {args.version} — {decision.upper()} ({ts})", "",
             f"**Hypothesis:** {run['hypothesis']}", "", f"**Decision:** {decision}. {args.reason}", "",
             f"Commit `{run['git_commit'][:10]}`. Headline numbers (95% CI):", ""]
    for mod, key, label in (("visual", "drone_recall", "Visual drone recall"), ("visual", "fa_rate", "Visual false-alarm rate"),
                            ("audio", "recall", "Audio drone recall"), ("audio", "fa_per_hour", "Audio false alarms / hour")):
        v = metrics.get(mod, {}).get(key)
        if v:
            lines.append(f"- {label}: {v['value']:.3f} [{v['lo']:.3f}, {v['hi']:.3f}]")
    new = not CHANGELOG.exists()
    with open(CHANGELOG, "a") as f:
        if new:
            f.write("# Detection changelog\n\nOne entry per version: hypothesis, decision, reason. Reverted versions stay.\n")
        f.write("\n".join(lines) + "\n")
    print(f"{args.version}: {decision} recorded in results.csv and CHANGELOG.md")


if __name__ == "__main__":
    main()
