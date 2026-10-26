#!/usr/bin/env python3
"""Synthesize one sentence with the cleared comparison TTS adapter."""

from __future__ import annotations

import argparse
import json
import os

from voicelab.audio_io import write_pcm_wav
from voicelab.model_registry import create_tts_adapter


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("text", help="Synthetic sentence to speak; do not pass personal data")
    parser.add_argument("--model", default="tts_kokoro")
    parser.add_argument("--voice", default=os.getenv("TTS_VOICE"))
    parser.add_argument("--language", default="en-NG")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument(
        "--output", required=True, help="WAV output path; keep raw output untracked"
    )
    args = parser.parse_args()
    tts = create_tts_adapter(args.model)
    voice = args.voice
    if voice is None:
        available = tts.voices()
        if not available:
            raise SystemExit("No usable voices. Set --voice and configure an authorized profile.")
        voice = available[0].voice_id
    result = tts.synthesize(
        args.text,
        voice_id=voice,
        language=args.language,
        speed=args.speed,
    )
    write_pcm_wav(args.output, result.pcm_s16le, result.sample_rate)
    print(
        json.dumps(
            {
                "output": args.output,
                "model_id": result.model_id,
                "voice_id": result.voice_id,
                "sample_rate_hz": result.sample_rate,
                "audio_s": result.duration_s,
                "ttfa_s": result.time_to_first_audio_s,
                "total_latency_s": result.total_latency_s,
                "ttfa_note": "whole-utterance synthesis; not streaming TTFA",
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
