"""Audit DCSkyCam hard-negative candidates for a data-only version after v5.

Run offline with Python 3:
  python dcskycam_curation.py metadata.csv group-pins.csv reviews.csv --groups-sha256 APPROVED_DIGEST

Use the unmodified upstream train/metadata.csv at REVISION. The published
`not_helicopter` bucket does not distinguish planes, kites, birds or clouds.
The source has no capture IDs; don't guess them from filenames, subtypes,
or the legacy loader's pixel clusters. Flight/capture records are required.

Group pins CSV: file_name,capture_group,partition
  Account for every upstream file. Use a traceable ID for the entire original
  recording or pass. Use `new_train` only with verified full group membership
  and no overlap with the existing corpus, selection or any benchmark
  (including false-positive examples). Otherwise use baseline_train, select,
  test, benchmark or unknown. Unmapped files must be unknown. If any member
  is not new_train, exclude the whole group.
  Supply the SHA-256 from the approved group inventory, not a new split.

Reviews CSV: file_name,label,reviewer
  After visually checking each pinned crop, use airplane, helicopter or kite
  (the flown object, not the bird) only for a single clear target.
  Omit uncertain crops or mark them unknown/mixed.
  A review does not override a conflicting or unrecognized upstream annotation.

This prints a candidate manifest with attribution, not training data. Before
building a separate corpus after v5, verify each candidate's upstream LFS hash
and audit source overlap and exact/near duplicates against existing splits per
the benchmark protocol. Stop on leakage. Keep experimental crops outside
data/shreyansh_crops_v4, which both baseline trainers auto-load.
"""
import argparse
import csv
import hashlib
import io
import json
import re
from collections import Counter
from pathlib import Path

DATASET = "https://huggingface.co/datasets/dcskycam/helicopter-classification"
REVISION = "36aa0e865a1f204fdd97a9c25458347ca95ceb9a"
METADATA_BLOB = "bdfbb02577528a08d0702ad094d2e8a434178d16"
LABELS = {"airplane", "helicopter", "kite"}
PARTITIONS = {"new_train", "baseline_train", "select", "test", "benchmark", "unknown"}
# The upstream helicopter bucket includes V22 tiltrotors; leave them out of this taxonomy.
HELI_SUBTYPES = {
    "AH6", "AS350", "AW139", "B206", "B412", "EC35", "EC45", "H60",
    "MD52", "MH65", "S76", "UH1N", "UH72", "VH3D", "VH92",
}


def read_rows(contents: bytes, header: str) -> dict[str, list[str]]:
    columns = header.split(",")
    reader = csv.reader(io.StringIO(contents.decode("utf-8-sig"), newline=""), strict=True)
    if next(reader, None) != columns:
        raise ValueError(f"Expected CSV header: {header}")
    rows = {}
    for row in reader:
        if len(row) != len(columns) or not re.fullmatch(r"[a-z0-9_]+-[0-9a-f]{8}\.jpeg", row[0]):
            raise ValueError(f"{header}, line {reader.line_num}: invalid filename or row width")
        name, *fields = row
        if name in rows:
            raise ValueError(f"{header}, line {reader.line_num}: duplicate file {name}")
        rows[name] = [field.strip() for field in fields]
    return rows


def agrees_with_upstream(name: str, bucket: str, subtype: str, label: str) -> bool:
    if bucket == "helicopter":
        return label == "helicopter" and subtype in HELI_SUBTYPES and name.startswith(subtype.lower() + "-")
    return (bucket == "not_helicopter" and subtype == "none"
            and name.startswith("not_helicopter-") and label in {"airplane", "kite"})


def curate(metadata: bytes, group_pins: bytes, reviews: bytes, expected_group_sha256: str) -> dict:
    if hashlib.sha1(f"blob {len(metadata)}\0".encode() + metadata).hexdigest() != METADATA_BLOB:
        raise ValueError(f"metadata.csv does not match the published blob at {REVISION}")
    group_sha256 = hashlib.sha256(group_pins).hexdigest()
    if group_sha256 != expected_group_sha256.lower():
        raise ValueError("Group pins do not match the approved SHA-256")

    upstream = read_rows(metadata, "file_name,helicopter_type,heli_subtype")
    pins = read_rows(group_pins, "file_name,capture_group,partition")
    vetted = read_rows(reviews, "file_name,label,reviewer")
    if pins.keys() != upstream.keys():
        raise ValueError("Group pins must account for every upstream file, and no other files")
    if vetted.keys() - upstream.keys():
        raise ValueError("Reviews reference files outside the pinned metadata")

    blocked_groups = set()
    for name, (group, partition) in pins.items():
        if partition not in PARTITIONS or (not group and partition != "unknown"):
            raise ValueError(f"{name}: invalid capture group or partition")
        if partition != "new_train":
            blocked_groups.add(group)

    dropped = Counter()
    candidates = []
    for name, (bucket, subtype) in sorted(upstream.items()):
        group, _ = pins[name]
        if not group or group in blocked_groups:
            dropped["group_not_new_train"] += 1
            continue
        label, reviewer = vetted.get(name, ("", ""))
        if label not in LABELS or not reviewer:
            dropped["missing_or_unvetted_label"] += 1
            continue
        if not agrees_with_upstream(name, bucket, subtype, label):
            dropped["upstream_label_conflict"] += 1
            continue
        candidates.append({"file_name": name, "capture_group": group, "label": label,
                           "reviewer": reviewer, "helicopter_type": bucket, "heli_subtype": subtype})

    return {
        "revision": REVISION,
        "metadata_git_blob": METADATA_BLOB,
        "groups_sha256": group_sha256,
        "reviews_sha256": hashlib.sha256(reviews).hexdigest(),
        "attribution": {
            "title": "DCSkyCam Helicopter Classification Dataset",
            "creator": "DCSkyCam contributors",
            "source": f"{DATASET}/tree/{REVISION}",
            "license": "CC-BY-4.0",
            "license_url": "https://creativecommons.org/licenses/by/4.0/",
            "changes": "Selected and relabelled crops for curation; image pixels unchanged.",
        },
        "split": "train",
        "model_class": {"id": 2, "label": "other"},
        "candidate_count": len(candidates),
        "by_label": dict(Counter(item["label"] for item in candidates)),
        "dropped": dict(dropped),
        "candidates": candidates,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("metadata", type=Path, help="unmodified upstream metadata.csv")
    parser.add_argument("group_pins", type=Path, help="approved capture inventory CSV")
    parser.add_argument("reviews", type=Path, help="crop-level reviews CSV")
    parser.add_argument("--groups-sha256", required=True, help="recorded digest of the approved group pins")
    args = parser.parse_args()
    try:
        manifest = curate(args.metadata.read_bytes(), args.group_pins.read_bytes(),
                          args.reviews.read_bytes(), args.groups_sha256)
    except (OSError, ValueError, csv.Error) as exc:
        parser.error(str(exc))
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
