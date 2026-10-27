#!/usr/bin/env python3
"""Start the local browser voice conversation interface."""

from __future__ import annotations

import os
from pathlib import Path

import uvicorn


def load_local_environment() -> None:
    """Load simple KEY=value entries from the private voice-lab .env if present."""
    env_path = Path(".env")
    if not env_path.is_file():
        return
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


def main() -> None:
    load_local_environment()
    uvicorn.run("voicelab.web_app:app", host="127.0.0.1", port=8765, reload=False)


if __name__ == "__main__":
    main()
