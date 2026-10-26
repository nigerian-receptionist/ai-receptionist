#!/usr/bin/env python3
"""Transcribe one local WAV file with a license-cleared STT adapter."""

from __future__ import annotations

import argparse
import json

from voicelab.model_registry import create_stt_adapter
from voicelab.privacy import redact_for_storage


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", help="Audio file to transcribe")
    parser.add_argument("--model", default="stt_fw_turbo", help="Model ID from configs/models.yaml")
    parser.add_argument("--language", help="en-NG, pcm, yo, ig, or ha")
    parser.add_argument(
        "--hint", action="append", default=[], help="Repeat for pronunciation hints"
    )
    args = parser.parse_args()
    result = create_stt_adapter(args.model).transcribe_file(
        args.audio,
        language=args.language,
        hints=args.hint,
    )
    print(
        json.dumps(
            {
                "text": redact_for_storage(result.text),
                "language": result.language,
                "confidence": result.confidence,
                "audio_s": result.audio_s,
                "latency_s": result.latency_s,
                "rtf": result.latency_s / result.audio_s,
                "model_id": result.model_id,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
