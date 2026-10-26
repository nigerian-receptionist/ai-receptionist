#!/usr/bin/env python3
"""Generate a synthetic spoken exchange WAV without recording microphone audio."""

from __future__ import annotations

import argparse
import wave
from pathlib import Path

import numpy as np

from voicelab.model_registry import create_tts_adapter

LINES = [
    "This is a synthetic local voice demo. No real person is speaking, no call is being "
    "placed, and microphone audio is not saved.",
    "I would like to reschedule my appointment, please.",
    "Of course. What day and time would work better for you?",
    "The twenty-eighth of October at half past two would be good.",
    "Thank you. I have noted the twenty-eighth of October at half past two.",
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--voice", default="af_sarah")
    parser.add_argument("--language", default="en-NG")
    args = parser.parse_args()
    adapter = create_tts_adapter("tts_kokoro")
    available = {voice.voice_id for voice in adapter.voices()}
    if args.voice not in available:
        parser.error(f"Voice {args.voice!r} is not available")
    audio_parts: list[bytes] = []
    sample_rate: int | None = None
    for line in LINES:
        result = adapter.synthesize(line, voice_id=args.voice, language=args.language)
        sample_rate = result.sample_rate
        audio_parts.append(result.pcm_s16le)
        audio_parts.append(np.zeros(int(0.25 * sample_rate), dtype="<i2").tobytes())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.output), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate or 24000)
        output.writeframes(b"".join(audio_parts))
    print(f"Generated synthetic demo: {args.output}")
    print(f"Model asset hash: {adapter.model_revision}")


if __name__ == "__main__":
    main()
