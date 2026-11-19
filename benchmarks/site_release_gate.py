"""Verify reviewed field evidence against a pre-approved airport pilot plan."""

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def number(value, lower=0, upper=sys.float_info.max):
    return type(value) in (float, int) and lower <= value <= upper


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def read_pinned(path, sha256):
    require(digest(sha256), "expected SHA-256 must be lowercase hex")
    raw = path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == sha256, f"SHA-256 mismatch: {path.name}")
    return json.loads(raw, object_pairs_hook=unique_keys)


def check(plan, evidence, *, site, release_sha256, installation_sha256, plan_sha256):
    for label, record in (("plan", plan), ("evidence", evidence)):
        require(isinstance(record, dict), f"{label} must be a JSON object")
        require(type(record.get("schema")) is int and record["schema"] == 1, f"unsupported {label} schema")
        require(record.get("site") == site and bool(site.strip()), f"{label} site mismatch")
        for field, expected in (("release_sha256", release_sha256), ("installation_sha256", installation_sha256)):
            require(digest(expected) and record.get(field) == expected, f"{label} {field} mismatch")
    require(digest(plan_sha256) and evidence.get("plan_sha256") == plan_sha256, "evidence plan mismatch")
    require(evidence.get("dataset_kind") == "independent_airport_field", "independent airport field data required")
    require(evidence.get("leakage_check") == "passed", "passing leakage audit required")
    require(digest(evidence.get("evidence_bundle_sha256")), "audited evidence bundle digest required")
    require(type(evidence.get("bootstrap_resamples")) is int and evidence["bootstrap_resamples"] == 1000,
            "1,000 bootstrap resamples required")

    requirements, observed = plan.get("strata"), evidence.get("strata")
    require(isinstance(requirements, dict) and requirements, "approved field strata required")
    require(isinstance(observed, dict) and observed.keys() == requirements.keys(), "field strata mismatch")
    metrics = ("drone_recall", "false_alarms_per_hour")
    for stratum, limits in requirements.items():
        require(bool(stratum.strip()), "empty stratum name")
        row = observed[stratum]
        for record in (limits, row):
            require(isinstance(record, dict) and record.keys() == set(metrics), f"{stratum}: both headline metrics required")
        for metric in metrics:
            label = f"{stratum}/{metric}"
            recall = metric == "drone_recall"
            upper = 1 if recall else sys.float_info.max
            policy, result = limits[metric], row[metric]
            require(isinstance(policy, dict) and isinstance(result, dict), f"{label}: missing policy or result")
            limit, min_sessions, min_exposure = (policy.get(k) for k in ("limit", "min_sessions", "min_exposure"))
            require(number(limit, upper=upper) and limit > 0, f"{label}: invalid acceptance limit")
            require(type(min_sessions) is int and min_sessions >= 2, f"{label}: invalid independent session floor")
            require(number(min_exposure) and min_exposure > 0, f"{label}: invalid exposure floor")
            sessions, exposure, count = (result.get(k) for k in ("sessions", "exposure", "count"))
            require(type(sessions) is int and sessions >= min_sessions, f"{label}: insufficient independent sessions")
            require(number(exposure) and exposure >= min_exposure, f"{label}: insufficient exposure")
            require(type(count) is int and number(count), f"{label}: invalid outcome count")
            if recall:
                require(type(exposure) is int and sessions <= exposure and count <= exposure,
                        f"{label}: invalid encounter counts")
            value, lo, hi = (result.get(k) for k in ("value", "lo", "hi"))
            require(all(number(x, upper=upper) for x in (value, lo, hi)) and lo <= value <= hi,
                    f"{label}: invalid 95% confidence interval")
            require(math.isclose(value, count / exposure, rel_tol=1e-9), f"{label}: inconsistent point estimate")
            if count == 0:
                require(hi > 0, f"{label}: zero outcomes require a nonzero upper confidence bound")
            if recall and count == exposure:
                require(lo < 1, f"{label}: perfect observed recall requires a lower bound below one")
            require(lo >= limit if recall else hi <= limit, f"{label}: confidence bound misses limit")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("site", "release-sha256", "installation-sha256", "plan-sha256", "evidence-sha256"):
        parser.add_argument(f"--{flag}", required=True)
    for flag in ("plan", "evidence"):
        parser.add_argument(f"--{flag}", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        plan = read_pinned(args.plan, args.plan_sha256)
        evidence = read_pinned(args.evidence, args.evidence_sha256)
        check(plan, evidence, site=args.site, release_sha256=args.release_sha256,
              installation_sha256=args.installation_sha256, plan_sha256=args.plan_sha256)
    except (OSError, ValueError, RecursionError) as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 1
    print("PASS: reviewed site evidence meets the pinned plan; this is not operational authorization.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
