#!/usr/bin/env python3
"""Compare Whisper hint strategies on a consented manifest.

Runs four hint modes against the same model and clips:
- none:      no hints
- prompt:    phrase-level hints only (--hint)
- hotwords:  entity-term hints only (--hotword)
- both:      --hint and --hotword terms together

Accuracy comparison only (one decode per clip/condition); latency is recorded
in the CSV but IS NOT a timing benchmark.

openai-whisper, pinned at 20250625 upstream, has no dedicated `hotwords`
decoding option (verified in transcribe.py and decoding.py); hotword terms are
therefore delivered through the same `initial_prompt` channel as hints. The
matrix still answers the ADR question: which terms, placed in the prompt,
improve transcription of Nigerian names, amounts and Pidgin.

Outputs: results/raw/hints_{run_id}.csv, run_{run_id}.json, and a stdout
summary of tabulated WER per mode and condition.
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import tempfile
from pathlib import Path

from voicelab.audio import make_16k_mono_pcm, make_phone_audio
from voicelab.metrics import character_error_rate, real_time_factor, word_error_rate
from voicelab.model_registry import create_stt_adapter
from voicelab.privacy import redact_for_storage
from voicelab.run_metadata import collect_run_metadata, create_run_id

MODES = ("none", "prompt", "hotwords", "both")

CSV_FIELDS = [
    "run_id",
    "timestamp_utc",
    "git_sha",
    "model_id",
    "mode",
    "n_hint_terms",
    "clip_id",
    "language",
    "network",
    "channel",
    "condition",
    "audio_s",
    "latency_s",
    "rtf",
    "hypothesis",
    "wer",
    "cer",
    "error",
]


def hints_for(mode: str, hints: list[str], hotwords: list[str]) -> list[str]:
    """Build the hint list for one matrix mode (unknown modes raise)."""
    if mode not in MODES:
        raise ValueError(f"Unknown hint mode: {mode}")
    match mode:
        case "none":
            return []
        case "prompt":
            return list(hints)
        case "hotwords":
            return list(hotwords)
    return [*hints, *hotwords]


def load_rows(manifest: Path, split: str) -> list[dict[str, str]]:
    """Reuse the benchmark loader rules: consent is mandatory, split filters."""
    import csv as csv_module

    with manifest.open(encoding="utf-8-sig", newline="") as handle:
        rows = [row for row in csv_module.DictReader(handle) if row.get("split") == split]
    if not rows:
        raise ValueError(f"No {split!r} rows found in manifest {manifest}")
    for row in rows:
        if not row.get("clip_id") or not row.get("reference_text"):
            raise ValueError("Every row needs clip_id and reference_text")
        if not row.get("consent_id"):
            raise PermissionError(f"Clip {row['clip_id']} has no consent_id; refusing evaluation")
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--audio-dir", type=Path, required=True, help="Private source-audio dir")
    parser.add_argument("--split", choices=["dev", "test", "train"], default="dev")
    parser.add_argument("--model", default="stt_fw_turbo")
    parser.add_argument("--hint", action="append", default=[], help="Phrase hint; repeatable")
    parser.add_argument(
        "--hotword", action="append", default=[], help="Entity-term hint; repeatable"
    )
    parser.add_argument("--modes", nargs="+", choices=list(MODES), default=list(MODES))
    parser.add_argument("--output-dir", type=Path, default=Path("results/raw"))
    args = parser.parse_args(argv)

    rows = load_rows(args.manifest, args.split)
    for row in rows:
        source = args.audio_dir / f"{row['clip_id']}.wav"
        if not source.is_file():
            raise FileNotFoundError(source)

    run_id = create_run_id()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    csv_path = args.output_dir / f"hints_{run_id}.csv"
    metadata_path = args.output_dir / f"run_{run_id}.json"
    base = collect_run_metadata(
        config={
            "manifest": args.manifest.name,
            "split": args.split,
            "modes": list(args.modes),
            "hints": len(args.hint),
            "hotwords": len(args.hotword),
        },
        models=[],
    )

    adapter = create_stt_adapter(args.model)
    adapter_metadata = {
        "model_id": args.model,
        "model_name": adapter.model_name,
        "revision": adapter.revision,
        "device": adapter.device,
        # Whisper adapters expose compute_type; other backends may not.
        "compute_type": getattr(adapter, "compute_type", None),
    }

    # Warm up once so the first measured clip does not include lazy loading.
    warm = args.audio_dir / f"{rows[0]['clip_id']}.wav"
    adapter.transcribe_file(str(warm), language=rows[0].get("language"))

    scores: dict[tuple[str, str], list[float]] = {}
    with csv_path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for mode in args.modes:
            hint_terms = hints_for(mode, args.hint, args.hotword)
            for row in rows:
                with tempfile.TemporaryDirectory(prefix="voice-lab-hints-") as temp_name:
                    temp = Path(temp_name)
                    clean_path = make_16k_mono_pcm(
                        args.audio_dir / f"{row['clip_id']}.wav", temp / "clean_16k.wav"
                    )
                    _, phone_path = make_phone_audio(args.audio_dir / f"{row['clip_id']}.wav", temp)
                    conditions = (("clean", clean_path), ("phone_8k_mulaw", phone_path))
                    for condition, audio_path in conditions:
                        try:
                            result = adapter.transcribe_file(
                                str(audio_path),
                                language=row.get("language"),
                                hints=hint_terms,
                            )
                            wer = word_error_rate(row["reference_text"], result.text)
                            scores.setdefault((mode, condition), []).append(wer)
                            writer.writerow(
                                {
                                    "run_id": run_id,
                                    "timestamp_utc": base["timestamp_utc"],
                                    "git_sha": base["git_sha"],
                                    "model_id": args.model,
                                    "mode": mode,
                                    "n_hint_terms": len(hint_terms),
                                    "clip_id": row["clip_id"],
                                    "language": row["language"],
                                    "network": row["network"],
                                    "channel": f"{row['channel']}:{condition}",
                                    "condition": condition,
                                    "audio_s": result.audio_s,
                                    "latency_s": result.latency_s,
                                    "rtf": real_time_factor(result.latency_s, result.audio_s),
                                    "hypothesis": redact_for_storage(result.text),
                                    "wer": wer,
                                    "cer": character_error_rate(row["reference_text"], result.text),
                                    "error": "",
                                }
                            )
                        except Exception as error:  # keep a per-item failure in the artifact
                            scores.setdefault((mode, condition), [])
                            writer.writerow(
                                {
                                    "run_id": run_id,
                                    "timestamp_utc": "",
                                    "git_sha": "",
                                    "model_id": args.model,
                                    "mode": mode,
                                    "n_hint_terms": len(hint_terms),
                                    "clip_id": row["clip_id"],
                                    "language": row["language"],
                                    "network": row["network"],
                                    "channel": f"{row['channel']}:{condition}",
                                    "condition": condition,
                                    "audio_s": "",
                                    "latency_s": "",
                                    "rtf": "",
                                    "hypothesis": "",
                                    "wer": "",
                                    "cer": "",
                                    "error": type(error).__name__,
                                }
                            )

    summary = {
        (f"{mode}|{condition}"): {
            "mean_wer": round(statistics.mean(wers), 4) if wers else None,
            "min_wer": round(min(wers), 4) if wers else None,
            "max_wer": round(max(wers), 4) if wers else None,
        }
        for (mode, condition), wers in scores.items()
    }
    metadata = collect_run_metadata(
        config={"matrix": summary, **base["config"]},
        models=[adapter_metadata],
    )
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Rows: {csv_path}")
    print(f"Run metadata: {metadata_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
