#!/usr/bin/env python3
"""Create a blind 1-to-5 voice-rating sheet for at least five Nigerian listeners."""

from __future__ import annotations

import argparse
import csv
import json
import secrets
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("clips", nargs="+", type=Path, help="Generated audio clips")
    parser.add_argument("--output", type=Path, default=Path("results/raw/listening_sheet.csv"))
    args = parser.parse_args()
    missing = [path for path in args.clips if not path.is_file()]
    if missing:
        parser.error("Missing clip(s): " + ", ".join(path.name for path in missing))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    mapping_path = args.output.with_suffix(".mapping.json")
    assignments = [(secrets.token_hex(6), path) for path in args.clips]
    fields = [
        "blind_clip_id",
        "listener_id",
        "naturalness_1_to_5",
        "accent_fit_1_to_5",
        "clarity_1_to_5",
        "names_numbers_1_to_5",
        "emotional_fit_1_to_5",
        "comments",
    ]
    with args.output.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for blind_id, _ in assignments:
            writer.writerow({"blind_clip_id": blind_id})
    mapping_path.write_text(
        json.dumps({blind_id: path.name for blind_id, path in assignments}, indent=2),
        encoding="utf-8",
    )
    print(f"Rating sheet: {args.output}")
    print(f"Keep the unblinding map private: {mapping_path}")
    print("Collect ratings from at least five Nigerian listeners before reporting MOS.")


if __name__ == "__main__":
    main()
