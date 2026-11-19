"""Compare two eval_audio_holdout.py results with significance flags (CIs overlap = "not significant").

    python3 benchmarks/compare_audio.py benchmarks/audio_holdout/v0.json benchmarks/audio_holdout/v3.json
"""
import json
import sys


def main(a_path, b_path):
    a, b = json.load(open(a_path)), json.load(open(b_path))
    na, nb = a_path.split("/")[-1][:-5], b_path.split("/")[-1][:-5]

    def row(name, x, y, higher_better):
        (xl, xh), (yl, yh) = x["ci"], y["ci"]
        sig = not (xl <= yh and yl <= xh)
        verdict = "not significant" if not sig else ("better" if (y["value"] > x["value"]) == higher_better else "WORSE")
        print(f"{name:32s} {na} {x['value']:.3f} [{xl:.3f}-{xh:.3f}]   {nb} {y['value']:.3f} [{yl:.3f}-{yh:.3f}]   {verdict}")

    row("DADS drone recall", a["dads_test"]["drone_recall"], b["dads_test"]["drone_recall"], True)
    row("DADS false-alarm rate", a["dads_test"]["false_alarm_rate"], b["dads_test"]["false_alarm_rate"], False)
    for k in a["esc50_false_alarms"]:
        row(f"ESC-50 false alarms: {k}", a["esc50_false_alarms"][k], b["esc50_false_alarms"][k], False)
    for k in a["stress_recall"]:
        row(f"drone recall in noise {k}", a["stress_recall"][k], b["stress_recall"][k], True)


if __name__ == "__main__":
    main(*sys.argv[1:3])
