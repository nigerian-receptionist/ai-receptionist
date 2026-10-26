#!/usr/bin/env python3
"""Download the official Kokoro ONNX comparison assets into ignored storage."""

from __future__ import annotations

import argparse
import hashlib
import urllib.request
from pathlib import Path

ASSETS = {
    "kokoro-v1.0.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx",
    "voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path("models/kokoro"))
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, url in ASSETS.items():
        path = args.output_dir / filename
        if not path.exists():
            print(f"Downloading {filename} from the upstream release…")
            urllib.request.urlretrieve(url, path)
        print(f"{filename} sha256={sha256(path)}")
    print("Record these hashes in the run metadata; do not commit the model files.")


if __name__ == "__main__":
    main()
