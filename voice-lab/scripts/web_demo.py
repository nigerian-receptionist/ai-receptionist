#!/usr/bin/env python3
"""Start the local browser voice conversation interface."""

from __future__ import annotations

import os
from pathlib import Path

import uvicorn


def load_local_environment() -> None:
    """Load simple KEY=value entries from the private voice-lab .env if present."""
    env_path = Path(".env")
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            entry = line.strip()
            if not entry or entry.startswith("#") or "=" not in entry:
                continue
            key, value = entry.split("=", 1)
            key, value = key.strip(), value.strip()
            if value.startswith(("'", '"')) and value[-1:] == value[:1]:
                value = value[1:-1]
            if key:
                os.environ.setdefault(key, value)
    os.environ.setdefault("KOKORO_MODEL_PATH", "models/kokoro/kokoro-v1.0.onnx")
    os.environ.setdefault("KOKORO_VOICES_PATH", "models/kokoro/voices-v1.0.bin")


def main() -> None:
    load_local_environment()
    uvicorn.run("voicelab.web_app:app", host="127.0.0.1", port=8765, reload=False)


if __name__ == "__main__":
    main()
