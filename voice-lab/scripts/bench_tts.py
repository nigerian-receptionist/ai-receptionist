#!/usr/bin/env python3
"""Benchmark cleared TTS candidates on synthetic, non-personal prompts."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import tempfile
from pathlib import Path

from voicelab.audio import make_phone_audio
from voicelab.audio_io import wav_duration, write_pcm_wav
from voicelab.metrics import real_time_factor, word_error_rate
from voicelab.model_registry import create_stt_adapter, create_tts_adapter
from voicelab.run_metadata import collect_run_metadata, create_run_id


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sentences", type=Path, default=Path("data/tts_sentences.csv"))
    parser.add_argument("--model", default="tts_kokoro")
    parser.add_argument("--voice", default="af_sarah")
    parser.add_argument("--repeats", type=int, default=20)
    parser.add_argument("--roundtrip-model", default="stt_fw_turbo")
    parser.add_argument("--skip-roundtrip", action="store_true")
    parser.add_argument("--output-dir", type=Path, default=Path("results/raw"))
    args = parser.parse_args()
    if args.repeats < 20:
        parser.error("--repeats must be at least 20 for reported timing benchmarks")
    with args.sentences.open(encoding="utf-8-sig", newline="") as handle:
        sentences = list(csv.DictReader(handle))
    if not sentences:
        parser.error("Sentence set is empty")

    run_id = create_run_id()
    raw_dir = args.output_dir / run_id
    raw_dir.mkdir(parents=True, exist_ok=True)
    csv_path = args.output_dir / f"tts_{run_id}.csv"
    metadata_path = args.output_dir / f"run_{run_id}.json"
    tts = create_tts_adapter(args.model)
    voice_ids = {voice.voice_id for voice in tts.voices()}
    if args.voice not in voice_ids:
        parser.error(f"Voice {args.voice!r} is not provided by this model")
    first_sentence = sentences[0]
    tts.synthesize(
        first_sentence["text"],
        voice_id=args.voice,
        language=first_sentence["language"],
    )  # warm-up
    stt = None if args.skip_roundtrip else create_stt_adapter(args.roundtrip_model)
    base_metadata = collect_run_metadata(config={}, models=[])

    fields = [
        "run_id",
        "timestamp_utc",
        "git_sha",
        "model_id",
        "model_revision",
        "voice_id",
        "language",
        "sentence_id",
        "audio_s",
        "latency_s",
        "ttfa_s",
        "rtf",
        "roundtrip_wer",
        "output_wav",
        "error",
    ]
    with csv_path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        for sentence in sentences:
            first_wav: Path | None = None
            for repeat in range(args.repeats):
                result = tts.synthesize(
                    sentence["text"],
                    voice_id=args.voice,
                    language=sentence["language"],
                )
                output_wav = raw_dir / f"{sentence['sentence_id']}.wav"
                if repeat == 0:
                    write_pcm_wav(output_wav, result.pcm_s16le, result.sample_rate)
                    first_wav = output_wav
                writer.writerow(
                    {
                        "run_id": run_id,
                        "timestamp_utc": base_metadata["timestamp_utc"],
                        "git_sha": base_metadata["git_sha"],
                        "model_id": args.model,
                        "model_revision": tts.model_revision,
                        "voice_id": args.voice,
                        "language": sentence["language"],
                        "sentence_id": sentence["sentence_id"],
                        "audio_s": result.duration_s,
                        "latency_s": result.total_latency_s,
                        "ttfa_s": result.time_to_first_audio_s,
                        "rtf": real_time_factor(result.total_latency_s, result.duration_s),
                        "roundtrip_wer": "",
                        "output_wav": output_wav.name if repeat == 0 else "",
                        "error": "",
                    }
                )
            if stt and first_wav:
                with tempfile.TemporaryDirectory(prefix="voice-lab-tts-") as temp_dir:
                    _, phone_path = make_phone_audio(first_wav, Path(temp_dir))
                    recognized = stt.transcribe_file(str(phone_path), language=sentence["language"])
                score = word_error_rate(sentence["text"], recognized.text)
                writer.writerow(
                    {
                        "run_id": run_id,
                        "timestamp_utc": base_metadata["timestamp_utc"],
                        "git_sha": base_metadata["git_sha"],
                        "model_id": args.model,
                        "model_revision": tts.model_revision,
                        "voice_id": args.voice,
                        "language": sentence["language"],
                        "sentence_id": sentence["sentence_id"],
                        "audio_s": wav_duration(first_wav),
                        "latency_s": "",
                        "ttfa_s": "",
                        "rtf": "",
                        "roundtrip_wer": score,
                        "output_wav": first_wav.name,
                        "error": "",
                    }
                )
    model_hashes = {}
    for env_name in ("KOKORO_MODEL_PATH", "KOKORO_VOICES_PATH"):
        path = Path(os.environ.get(env_name, ""))
        if path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            model_hashes[env_name] = {"sha256": digest.hexdigest()}
        else:
            model_hashes[env_name] = None
    run_metadata = collect_run_metadata(
        config={"sentences": args.sentences.name, "repeats": args.repeats},
        models=[{"model_id": args.model, "assets": model_hashes}],
    )
    metadata_path.write_text(
        json.dumps(run_metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Raw rows: {csv_path}")
    print(f"Raw WAVs: {raw_dir}")
    print("Summarize with: python scripts/report.py tts " + str(csv_path))


if __name__ == "__main__":
    main()
