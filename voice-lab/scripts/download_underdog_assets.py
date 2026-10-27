#!/usr/bin/env python3
"""Cache the local Bark checkpoint and its small Parakeet processor files."""

from __future__ import annotations

import os
from pathlib import Path


def load_local_environment() -> None:
    env_path = Path(".env")
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        entry = line.strip()
        if not entry or entry.startswith("#") or "=" not in entry:
            continue
        key, value = entry.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def main() -> None:
    load_local_environment()
    # This command is the explicit online setup step, even when the app's
    # private .env requires offline inference after the cache is complete.
    os.environ["HF_HUB_OFFLINE"] = "false"
    from huggingface_hub import hf_hub_download

    for filename in ("bark_loader.py", "model.bark"):
        path = hf_hub_download(
            repo_id="ConwayResearch/Underdog-Bark-3.0",
            filename=filename,
            revision="85db2ad",
        )
        print(f"Cached Underdog Bark {filename}: {path}", flush=True)

    # Bark stores its acoustic model in model.bark, but uses Parakeet's small
    # config, tokenizer and generation settings at runtime. Its 2.5 GB model
    # weights are not needed for this adapter.
    for filename in (
        "config.json",
        "generation_config.json",
        "processor_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
    ):
        path = hf_hub_download(
            repo_id="nvidia/parakeet-tdt-0.6b-v3",
            filename=filename,
            revision="main",
        )
        print(f"Cached Parakeet {filename}: {path}", flush=True)


if __name__ == "__main__":
    main()
