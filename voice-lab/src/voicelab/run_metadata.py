"""Reproducibility metadata for benchmark runs."""

from __future__ import annotations

import importlib.metadata
import platform
import subprocess
import sys
from datetime import UTC, datetime


def _command_output(command: list[str]) -> str | None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    return result.stdout.strip()


def collect_run_metadata(*, config: dict, models: list[dict]) -> dict:
    packages = {}
    for name in (
        "openai-whisper",
        "jiwer",
        "kokoro-onnx",
        "numpy",
        "pandas",
        "PyYAML",
        "sounddevice",
        "soundfile",
        "silero-vad",
        "torch",
    ):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
    try:
        git_sha = _command_output(["git", "rev-parse", "HEAD"])
    except Exception:
        git_sha = None
    return {
        "timestamp_utc": datetime.now(UTC).isoformat(),
        "git_sha": git_sha,
        "python": sys.version,
        "platform": platform.platform(),
        "processor": platform.processor(),
        "cpu_count": __import__("os").cpu_count(),
        "nvidia_smi": _command_output(
            ["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"]
        ),
        "cuda_available": _cuda_available(),
        "packages": packages,
        "config": config,
        "models": models,
    }


def _cuda_available() -> bool | None:
    try:
        import torch
    except ImportError:
        return None
    return bool(torch.cuda.is_available())


def create_run_id() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
