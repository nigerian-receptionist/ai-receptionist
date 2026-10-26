#!/usr/bin/env python3
"""Convert a WAV file to simulated phone-band audio."""

from __future__ import annotations

import argparse
from pathlib import Path

from voicelab.audio import make_phone_audio


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Source WAV/audio file")
    parser.add_argument(
        "--output-dir", type=Path, required=True, help="Directory for generated WAV files"
    )
    args = parser.parse_args()
    phone_path, restored_path = make_phone_audio(args.input, args.output_dir)
    print(f"8 kHz G.711 mu-law: {phone_path}")
    print(f"16 kHz mono PCM: {restored_path}")


if __name__ == "__main__":
    main()
