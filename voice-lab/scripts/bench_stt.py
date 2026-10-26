#!/usr/bin/env python3
"""Benchmark cleared STT models on a consented manifest (dev split by default)."""

from __future__ import annotations

import argparse
import csv
import json
import tempfile
from pathlib import Path

from voicelab.audio import make_16k_mono_pcm, make_phone_audio
from voicelab.metrics import character_error_rate, real_time_factor, word_error_rate
from voicelab.model_registry import create_stt_adapter
from voicelab.privacy import redact_for_storage
from voicelab.run_metadata import collect_run_metadata, create_run_id

CSV_FIELDS = [
    "run_id",
    "timestamp_utc",
    "git_sha",
    "model_id",
    "model_revision",
    "backend",
    "device",
    "compute_type",
    "clip_id",
    "language",
    "channel",
    "network",
    "audio_s",
    "latency_s",
    "rtf",
    "hypothesis",
    "wer",
    "cer",
    "error",
]


def load_rows(manifest: Path, split: str) -> list[dict[str, str]]:
    with manifest.open(encoding="utf-8-sig", newline="") as handle:
        rows = [row for row in csv.DictReader(handle) if row.get("split") == split]
    if not rows:
        raise ValueError(f"No {split!r} rows found in manifest {manifest}")
    for row in rows:
        if not row.get("clip_id") or not row.get("reference_text"):
            raise ValueError("Every benchmark row needs clip_id and reference_text")
        if not row.get("consent_id"):
            raise PermissionError(f"Clip {row['clip_id']} has no consent_id; refusing evaluation")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument(
        "--audio-dir", type=Path, required=True, help="Private source-audio directory"
    )
    parser.add_argument("--split", choices=["dev", "test"], default="dev")
    parser.add_argument(
        "--models", nargs="+", default=["stt_fw_turbo", "stt_fw_large", "stt_fw_small"]
    )
    parser.add_argument("--repeats", type=int, default=20)
    parser.add_argument("--output-dir", type=Path, default=Path("results/raw"))
    args = parser.parse_args()
    if args.repeats < 20:
        parser.error("--repeats must be at least 20 for reported timing benchmarks")
    rows = load_rows(args.manifest, args.split)
    for row in rows:
        source = args.audio_dir / f"{row['clip_id']}.wav"
        if not source.is_file():
            raise FileNotFoundError(source)

    run_id = create_run_id()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    csv_path = args.output_dir / f"stt_{run_id}.csv"
    metadata_path = args.output_dir / f"run_{run_id}.json"
    base_metadata = collect_run_metadata(
        config={"manifest": args.manifest.name, "split": args.split, "repeats": args.repeats},
        models=[],
    )
    metadata: list[dict] = []
    with csv_path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for model_id in args.models:
            adapter = create_stt_adapter(model_id)
            metadata.append(
                {
                    "model_id": model_id,
                    "model_name": adapter.model_name,
                    "revision": adapter.revision,
                    "device": adapter.device,
                    "compute_type": adapter.compute_type,
                }
            )
            first = rows[0]
            warm_path = args.audio_dir / f"{first['clip_id']}.wav"
            adapter.transcribe_file(str(warm_path), language=first.get("language"))
            for row in rows:
                source = args.audio_dir / f"{row['clip_id']}.wav"
                with tempfile.TemporaryDirectory(prefix="voice-lab-") as temp_dir:
                    temp = Path(temp_dir)
                    clean_path = make_16k_mono_pcm(source, temp / "clean_16k.wav")
                    _, phone_path = make_phone_audio(source, temp)
                    for condition, audio_path in (
                        ("clean", clean_path),
                        ("phone_8k_mulaw", phone_path),
                    ):
                        for _ in range(args.repeats):
                            try:
                                result = adapter.transcribe_file(
                                    str(audio_path),
                                    language=row.get("language"),
                                )
                                writer.writerow(
                                    {
                                        "run_id": run_id,
                                        "timestamp_utc": base_metadata["timestamp_utc"],
                                        "git_sha": base_metadata["git_sha"],
                                        "model_id": model_id,
                                        "model_revision": adapter.revision,
                                        "backend": "openai-whisper",
                                        "device": adapter.device,
                                        "compute_type": adapter.compute_type,
                                        "clip_id": row["clip_id"],
                                        "language": row["language"],
                                        "channel": f"{row['channel']}:{condition}",
                                        "network": row["network"],
                                        "audio_s": result.audio_s,
                                        "latency_s": result.latency_s,
                                        "rtf": real_time_factor(result.latency_s, result.audio_s),
                                        "hypothesis": redact_for_storage(result.text),
                                        "wer": word_error_rate(row["reference_text"], result.text),
                                        "cer": character_error_rate(
                                            row["reference_text"], result.text
                                        ),
                                        "error": "",
                                    }
                                )
                            except Exception as error:  # keep a per-item failure in the artifact
                                writer.writerow(
                                    {
                                        "run_id": run_id,
                                        "timestamp_utc": "",
                                        "git_sha": "",
                                        "model_id": model_id,
                                        "model_revision": adapter.revision,
                                        "backend": "openai-whisper",
                                        "device": adapter.device,
                                        "compute_type": adapter.compute_type,
                                        "clip_id": row["clip_id"],
                                        "language": row["language"],
                                        "channel": f"{row['channel']}:{condition}",
                                        "network": row["network"],
                                        "audio_s": "",
                                        "latency_s": "",
                                        "rtf": "",
                                        "hypothesis": "",
                                        "wer": "",
                                        "cer": "",
                                        "error": type(error).__name__,
                                    }
                                )
                output.flush()
    run_metadata = collect_run_metadata(
        config={"manifest": args.manifest.name, "split": args.split, "repeats": args.repeats},
        models=metadata,
    )
    metadata_path.write_text(
        json.dumps(run_metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Raw rows: {csv_path}")
    print(f"Run metadata: {metadata_path}")
    print("Summarize with: python scripts/report.py stt " + str(csv_path))


if __name__ == "__main__":
    main()
