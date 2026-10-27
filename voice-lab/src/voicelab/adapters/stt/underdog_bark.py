"""Local Underdog Bark 3.0 speech recognition adapter."""

from __future__ import annotations

import os
import time
import wave
from pathlib import Path

from voicelab.interfaces import SttResult


class UnderdogBarkAdapter:
    """English-only Bark 3.0 transcription through the documented Transformers pipeline."""

    model_id = "stt_underdog_bark"
    model_name = "ConwayResearch/Underdog-Bark-3.0"
    revision = "85db2ad"

    def __init__(self, *, device: str | None = None, local_files_only: bool | None = None) -> None:
        try:
            from transformers import pipeline
        except ImportError as error:
            raise RuntimeError("Install the `underdog` dependency group to use Bark") from error

        self.device = device or os.getenv("UNDERDOG_BARK_DEVICE", "cpu")
        self._pipeline = pipeline(
            "automatic-speech-recognition",
            model=self.model_name,
            revision=self.revision,
            device=self.device,
            model_kwargs={
                "local_files_only": (
                    local_files_only
                    if local_files_only is not None
                    else os.getenv("UNDERDOG_BARK_LOCAL_FILES_ONLY", "false").lower()
                    in {"1", "true", "yes"}
                )
            },
        )

    def transcribe_file(
        self,
        path: str,
        *,
        language: str | None = None,
        hints: list[str] | None = None,
    ) -> SttResult:
        del hints
        if language not in {None, "en", "en-NG", "en-US", "english"}:
            raise ValueError("Underdog Bark 3.0 currently supports English only")
        input_path = Path(path)
        with wave.open(str(input_path), "rb") as audio:
            duration_s = audio.getnframes() / audio.getframerate()
        started = time.perf_counter()
        response = self._pipeline(str(input_path))
        latency_s = time.perf_counter() - started
        return SttResult(
            text=str(response.get("text", "")).strip(),
            language="en",
            confidence=None,
            words=[],
            audio_s=duration_s,
            latency_s=latency_s,
            model_id=f"{self.model_id}@{self.revision}",
        )
