#!/usr/bin/env python3
"""Print a text string in a form suitable for speech synthesis."""

from __future__ import annotations

import argparse

from voicelab.normalise import normalize_for_speech


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("text", help="Text to normalize; avoid passing sensitive personal data")
    args = parser.parse_args()
    print(normalize_for_speech(args.text))


if __name__ == "__main__":
    main()
