#!/usr/bin/env python3
"""Run the local microphone, VAD, STT, TTS echo demo."""

from __future__ import annotations

import argparse
import os
import sys

from voicelab.live_demo import run_echo_loop


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-turn-seconds", type=float, default=12)
    parser.add_argument("--no-barge-in", action="store_true")
    parser.add_argument(
        "--tts-model",
        choices=("kokoro", "yarngpt2"),
        help="TTS provider (default: TTS_MODEL, then kokoro)",
    )
    parser.add_argument(
        "--stt-model",
        choices=("whisper", "underdog"),
        default="whisper",
        help="Speech recognition model (default: whisper)",
    )
    args = parser.parse_args()
    model = args.tts_model or os.getenv("TTS_MODEL", "").removeprefix("tts_") or None
    if model is None and sys.stdin.isatty():
        print("Choose a speech generator: 1) Kokoro  2) YarnGPT2")
        choice = input("Provider [1]: ").strip() or "1"
        model = {"1": "kokoro", "2": "yarngpt2"}.get(choice)
        if model is None:
            parser.error("choose 1 or 2")
    model = model or "kokoro"
    if model not in {"kokoro", "yarngpt2"}:
        parser.error("TTS_MODEL must be kokoro or yarngpt2")
    model_id = {"kokoro": "tts_kokoro", "yarngpt2": "tts_yarngpt2"}[model]
    run_echo_loop(
        include_llm=False,
        max_seconds=args.max_turn_seconds,
        barge_in=not args.no_barge_in,
        tts_model=model_id,
        stt_model={"whisper": "stt_fw_small", "underdog": "stt_underdog_bark"}[
            args.stt_model
        ],
    )


if __name__ == "__main__":
    main()
