"""Load only models with an explicit, reviewed status from the local registry."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def _load_registry(path: str | Path | None = None) -> dict[str, Any]:
    try:
        import yaml
    except ImportError as error:
        raise RuntimeError("Install the `speech` dependency group to load model configs") from error
    config_path = Path(path or os.getenv("VOICE_LAB_MODELS_CONFIG", "configs/models.yaml"))
    with config_path.open(encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def create_stt_adapter(model_id: str, config_path: str | Path | None = None):
    registry = _load_registry(config_path)
    candidates = [registry["stt"]["baseline"], *registry["stt"]["candidates"]]
    candidate = next((entry for entry in candidates if entry["id"] == model_id), None)
    if candidate is None:
        raise ValueError(f"Unknown STT model: {model_id}")
    if model_id == "stt_underdog_bark":
        if candidate.get("status") != "experimental-local-only":
            raise PermissionError("Underdog Bark is available only for local experimental evaluation")
        from voicelab.adapters.stt.underdog_bark import UnderdogBarkAdapter

        return UnderdogBarkAdapter()
    if candidate.get("status") == "blocked" or "verified upstream" not in candidate.get(
        "license_status", ""
    ):
        raise PermissionError(f"STT model {model_id} is not cleared for benchmarking")
    from voicelab.adapters.stt.openai_whisper import OpenAIWhisperAdapter

    return OpenAIWhisperAdapter(
        model_id=model_id,
        model_name=candidate["model"],
        expected_sha256=candidate["model_sha256"],
    )


def create_tts_adapter(model_id: str, config_path: str | Path | None = None):
    registry = _load_registry(config_path)
    entries = [registry["tts"]["baseline"], *registry["tts"]["candidates"]]
    candidate = next((entry for entry in entries if entry["id"] == model_id), None)
    if candidate is None or candidate.get("status") in {"blocked", "disabled"}:
        raise PermissionError(f"TTS model {model_id} is not cleared for benchmarking")
    if model_id == "tts_yarngpt2":
        if candidate.get("status") != "experimental-local-only":
            raise PermissionError("YarnGPT2 is available only for local experimental evaluation")
        from voicelab.adapters.tts.yarngpt2 import YarnGPT2Adapter

        return YarnGPT2Adapter.from_environment()
    if model_id == "tts_kokoro":
        from voicelab.adapters.tts.kokoro import KokoroAdapter

        return KokoroAdapter()
    raise NotImplementedError(f"No adapter is implemented for {model_id}")
