#!/usr/bin/env python3
"""Run the local microphone echo demo with a LiteLLM-routed language model."""

from __future__ import annotations

import argparse

from voicelab.live_demo import run_echo_loop


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-turn-seconds", type=float, default=12)
    parser.add_argument("--no-barge-in", action="store_true")
    args = parser.parse_args()
    run_echo_loop(
        include_llm=True, max_seconds=args.max_turn_seconds, barge_in=not args.no_barge_in
    )


if __name__ == "__main__":
    main()
