"""Check local metadata for an independent native-frame evaluation; never read media or score models."""

import argparse
import json
from collections import Counter
from pathlib import Path


def _id(value, field):
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{field} requires a nonempty canonical ID")
    return value


def check_intake(metadata):
    """Count annotated birds and recording groups by native longest box side."""
    if not isinstance(metadata, dict):
        raise ValueError("intake metadata must be an object")
    used = metadata.get("used_source_groups")
    if not isinstance(used, list) or not used:
        raise ValueError("used_source_groups must list the known development recording groups")
    used_groups = {_id(group, "used_source_groups") for group in used}
    frames = metadata.get("frames")
    if not isinstance(frames, list) or not frames:
        raise ValueError("frames must be a nonempty list")

    frame_ids = set()
    groups = set()
    by_size = {name: Counter() for name in ("<7", "7-15", ">15")}
    for i, frame in enumerate(frames):
        field = f"frames[{i}]"
        if not isinstance(frame, dict) or frame.get("geometry") != "native":
            raise ValueError(f"{field} must have native geometry (no resized, cropped or synthetic proxies)")
        group = _id(frame.get("source_group"), f"{field}.source_group")
        frame_id = _id(frame.get("frame_id"), f"{field}.frame_id")
        if group in used_groups:
            raise ValueError(f"{field} has source-group overlap: {group!r}")
        if (group, frame_id) in frame_ids:
            raise ValueError(f"{field} duplicates a frame within source group {group!r}")
        frame_ids.add((group, frame_id))
        groups.add(group)

        size = frame.get("frame_size")
        if not isinstance(size, list) or len(size) != 2 or any(type(v) is not int or v <= 0 for v in size):
            raise ValueError(f"{field}.frame_size must be [width, height] in positive integer pixels")
        width, height = size
        boxes = frame.get("bird_boxes_xyxy")
        if not isinstance(boxes, list):
            raise ValueError(f"{field}.bird_boxes_xyxy must be a list (empty for a verified bird-free frame)")
        for j, box in enumerate(boxes):
            if not isinstance(box, list) or len(box) != 4 or any(type(v) not in (int, float) for v in box):
                raise ValueError(f"{field}.bird_boxes_xyxy[{j}] must be a numeric [x1, y1, x2, y2] box")
            x1, y1, x2, y2 = box
            if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
                raise ValueError(f"{field}.bird_boxes_xyxy[{j}] must have positive area within the native frame")
            longest = max(x2 - x1, y2 - y1)
            stratum = "<7" if longest < 7 else ">15" if longest > 15 else "7-15"
            by_size[stratum][group] += 1

    return {
        "native_frames": len(frames),
        "source_groups": len(groups),
        "bird_boxes_by_native_size_px": {
            name: {"bird_boxes": sum(counts.values()), "source_groups": len(counts)}
            for name, counts in by_size.items()
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("metadata", type=Path, help="Local JSON file; prints coverage counts, not metrics")
    args = parser.parse_args()
    try:
        summary = check_intake(json.loads(args.metadata.read_text(encoding="utf-8")))
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
