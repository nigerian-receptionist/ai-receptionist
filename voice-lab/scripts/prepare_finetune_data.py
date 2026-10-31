#!/usr/bin/env python3
"""Validate a manifest and build 16 kHz fine-tune data with phone-line copies.

Rules enforced here (AGENTS.md section 6.3):
- Every clip row must carry a consent_id; anything else aborts.
- One speaker must stay in one split, so the test split is never tuned on.
- Audio is converted to clean 16 kHz mono PCM and, unless skipped, to a
  simulated 8 kHz phone round-trip copy matching the benchmark conditions.

Outputs live under the (git-ignored) output directory:
- {train,dev,test}.jsonl: one example per clip with paths and reference text
- stats.json: counts per split/language/speaker plus the failure report
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from voicelab.audio import make_16k_mono_pcm, make_phone_audio
from voicelab.finetune_data import (
    load_manifest,
    speaker_leakage_issues,
    split_rows,
    summarize,
    validate_rows,
)
from voicelab.run_metadata import collect_run_metadata, create_run_id

EXAMPLE_COLUMNS = (
    "clip_id",
    "speaker_id",
    "language",
    "accent_region",
    "channel",
    "network",
    "sample_rate_hz",
    "duration_s",
    "scenario",
    "contains_numbers",
    "contains_names",
    "contains_pidgin",
    "consent_id",
    "split",
    "recorded_at",
)


def prepare_subset(
    rows: list[dict[str, str]],
    output_path: Path,
    audio_dir: Path,
    *,
    skip_phone: bool,
) -> list[str]:
    """Write one JSONL example per clip and return per-clip error messages."""
    audio_out = output_path.parent / "audio"
    errors: list[str] = []
    output_path.parent.mkdir(parents=True, exist_ok=True)
    audio_out.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            source = audio_dir / f"{row['clip_id']}.wav"
            if not source.is_file():
                errors.append(f"{row['clip_id']}: missing source audio {source}")
                continue
            try:
                clean_path = make_16k_mono_pcm(source, audio_out / f"{row['clip_id']}_16k.wav")
                example = {key: row[key] for key in EXAMPLE_COLUMNS}
                example["reference_text"] = row["reference_text"]
                example["audio_clean"] = str(clean_path)
                if not skip_phone:
                    # make_phone_audio converts from the source clip exactly like
                    # the benchmark, so both conditions come from one master copy.
                    make_phone_audio(source, audio_out)
                    example["audio_phone"] = str(audio_out / f"{row['clip_id']}_phone_16k_pcm.wav")
                handle.write(json.dumps(example, ensure_ascii=False) + "\n")
            # Per-clip failures stay in stats.json; every clip is required for training.
            except Exception as error:
                errors.append(f"{row['clip_id']}: {type(error).__name__}: {error}")
    return errors


def build_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--audio-dir", type=Path, required=True, help="Private source-audio dir")
    parser.add_argument("--output-dir", type=Path, default=Path("data/finetune"))
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Check consent, splits and audio presence without writing anything",
    )
    parser.add_argument(
        "--skip-phone",
        action="store_true",
        help="Skip the simulated 8 kHz phone-line copies (clean 16 kHz only)",
    )
    args = parser.parse_args(argv)
    args.manifest = args.manifest.resolve()
    args.audio_dir = args.audio_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    return args


def main(argv: list[str] | None = None) -> int:
    args = build_arguments(argv)

    rows_all = load_manifest(args.manifest)
    validate_rows(rows_all)
    grouped = split_rows(rows_all)
    leakage = speaker_leakage_issues(grouped)
    if leakage:
        print(
            "Refusing to prepare fine-tune data: keep each speaker inside one split "
            "so the test split is never tuned on.",
            file=sys.stderr,
        )
        for issue in leakage:
            print(f"  {issue}", file=sys.stderr)
        return 3

    for split, rows in grouped.items():
        missing = [
            row["clip_id"]
            for row in rows
            if not (args.audio_dir / f"{row['clip_id']}.wav").is_file()
        ]
        if missing:
            print(f"Missing source audio for {len(missing)} {split} clip(s)", file=sys.stderr)
            for clip_id in missing[:10]:
                print(f"  {clip_id}", file=sys.stderr)
            return 2

    if args.validate_only:
        print(
            json.dumps(
                {"manifest": str(args.manifest), "stats": summarize(grouped), "leakage": leakage},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    failures: dict[str, list[str]] = {}
    for split, rows in grouped.items():
        failures[split] = prepare_subset(
            rows, args.output_dir / f"{split}.jsonl", args.audio_dir, skip_phone=args.skip_phone
        )

    stats = {
        "run_id": create_run_id(),
        "manifest": str(args.manifest),
        "audio_dir": str(args.audio_dir),
        "output_dir": str(args.output_dir),
        "phone_copies": not args.skip_phone,
        "stats": summarize(grouped),
        "leakage": leakage,
        "failures": failures,
        # The test split stays untouched by tuning (AGENTS.md 6.3); it is written
        # out only so evaluation can replay the exact same examples later.
        "note": "test split clips are prepared for evaluation only and are never tuned on",
        "metadata": collect_run_metadata(
            config={"manifest": args.manifest.name, "skip_phone": args.skip_phone},
            models=[],
        ),
    }
    stats_path = args.output_dir / "stats.json"
    stats_path.parent.mkdir(parents=True, exist_ok=True)
    stats_path.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False, indent=2))

    failed_count = sum(len(errors) for errors in failures.values())
    if failed_count:
        print(f"{failed_count} clip(s) failed; rerun after fixing them", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
