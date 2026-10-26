#!/usr/bin/env python3
"""Synthesize a synthetic sentence, simulate an 8 kHz phone leg, and score STT."""

from __future__ import annotations

import argparse
import csv
import json
import tempfile
from pathlib import Path

from voicelab.audio import make_phone_audio
from voicelab.audio_io import write_pcm_wav
from voicelab.metrics import word_error_rate
from voicelab.model_registry import create_stt_adapter, create_tts_adapter
from voicelab.run_metadata import create_run_id


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("text", help="Synthetic, non-personal text")
    parser.add_argument("--voice", default="af_sarah")
    parser.add_argument("--language", default="en-NG")
    parser.add_argument("--tts-model", default="tts_kokoro")
    parser.add_argument("--stt-model", default="stt_fw_turbo")
    parser.add_argument("--output-dir", type=Path, default=Path("results/raw"))
    args = parser.parse_args()

    run_id = create_run_id()
    output_dir = args.output_dir / run_id
    output_dir.mkdir(parents=True, exist_ok=True)
    tts = create_tts_adapter(args.tts_model)
    generated = tts.synthesize(args.text, voice_id=args.voice, language=args.language)
    clean_path = output_dir / "roundtrip_tts.wav"
    write_pcm_wav(clean_path, generated.pcm_s16le, generated.sample_rate)
    with tempfile.TemporaryDirectory(prefix="voice-lab-roundtrip-") as temp_dir:
        phone_8k, phone_16k = make_phone_audio(clean_path, Path(temp_dir))
        phone_copy = output_dir / "roundtrip_phone_8k_mulaw.wav"
        phone_copy.write_bytes(phone_8k.read_bytes())
        result = create_stt_adapter(args.stt_model).transcribe_file(
            str(phone_16k), language=args.language
        )
    score = word_error_rate(args.text, result.text)
    output = {
        "run_id": run_id,
        "tts_model": args.tts_model,
        "tts_revision": tts.model_revision,
        "voice_id": args.voice,
        "stt_model": args.stt_model,
        "stt_revision": result.model_id.rsplit("@", maxsplit=1)[-1],
        "reference": args.text,
        "hypothesis": result.text,
        "roundtrip_wer": score,
        "tts_latency_s": generated.total_latency_s,
        "stt_latency_s": result.latency_s,
        "audio_s": result.audio_s,
        "rtf": result.latency_s / result.audio_s,
        "sample_rate_hz": generated.sample_rate,
        "phone_simulation": "8 kHz mono G.711 mu-law, resampled to 16 kHz PCM for STT",
        "warning": "Kokoro is an English comparison model, not a Nigerian-accent voice evaluation.",
    }
    (output_dir / "roundtrip.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    with (output_dir / "roundtrip.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(output))
        writer.writeheader()
        writer.writerow(output)
    print(json.dumps(output, ensure_ascii=False, indent=2))
    print(f"Raw artifacts: {output_dir}")


if __name__ == "__main__":
    main()
