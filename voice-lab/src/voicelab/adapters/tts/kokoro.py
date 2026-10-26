"""Kokoro ONNX adapter used as a comparison model, not a Nigerian voice claim."""

from __future__ import annotations

import hashlib
import os
import re
import time
from collections.abc import AsyncIterator
from pathlib import Path

import numpy as np

from voicelab.interfaces import AudioChunk, TtsResult, VoiceInfo
from voicelab.normalise import normalize_for_speech


class KokoroAdapter:
    """CPU/GPU ONNX TTS wrapper with sentence-by-sentence emulated streaming."""

    model_id = "tts_kokoro"

    def __init__(self, *, model_path: str | None = None, voices_path: str | None = None) -> None:
        try:
            from kokoro_onnx import Kokoro
        except ImportError as error:
            raise RuntimeError("Install the `tts` dependency group to use Kokoro") from error

        model_path = model_path or os.getenv("KOKORO_MODEL_PATH")
        voices_path = voices_path or os.getenv("KOKORO_VOICES_PATH")
        if not model_path or not Path(model_path).is_file():
            raise FileNotFoundError("Set KOKORO_MODEL_PATH to a local Kokoro ONNX model")
        if not voices_path or not Path(voices_path).is_file():
            raise FileNotFoundError("Set KOKORO_VOICES_PATH to the local Kokoro voice bundle")
        self._kokoro = Kokoro(model_path, voices_path)
        self.model_path = Path(model_path)
        self.voices_path = Path(voices_path)
        self.model_revision = f"{self._sha256(self.model_path)}:{self._sha256(self.voices_path)}"

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def voices(self) -> list[VoiceInfo]:
        return [
            VoiceInfo(voice_id=voice_id, language="en-US") for voice_id in self._kokoro.get_voices()
        ]

    @staticmethod
    def _language(language: str) -> str:
        if language not in {"en", "en-US", "en-NG"}:
            raise ValueError("Kokoro comparison adapter supports English only")
        return "en-us"

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str,
        language: str,
        tone: str = "neutral",
        speed: float = 1.0,
    ) -> TtsResult:
        del tone  # Kokoro does not expose a tone control in this runtime.
        normalized = normalize_for_speech(text)
        started = time.perf_counter()
        samples, sample_rate = self._kokoro.create(
            normalized,
            voice=voice_id,
            speed=speed,
            lang=self._language(language),
        )
        total_latency = time.perf_counter() - started
        samples = np.asarray(samples, dtype=np.float32).reshape(-1)
        pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        duration = len(samples) / sample_rate
        return TtsResult(
            pcm_s16le=pcm,
            sample_rate=int(sample_rate),
            duration_s=duration,
            # The ONNX call returns a whole utterance; TTFA is therefore measured
            # as total synthesis latency and must not be read as streaming TTFA.
            time_to_first_audio_s=total_latency,
            total_latency_s=total_latency,
            voice_id=voice_id,
            model_id=self.model_id,
            text_spoken=normalized,
        )

    async def synthesize_stream(
        self,
        text: str,
        *,
        voice_id: str,
        language: str,
        tone: str = "neutral",
        speed: float = 1.0,
    ) -> AsyncIterator[AudioChunk]:
        """Emulate streaming by synthesizing each sentence as a separate block."""
        sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
        if not sentences:
            return
        for index, sentence in enumerate(sentences):
            result = self.synthesize(
                sentence,
                voice_id=voice_id,
                language=language,
                tone=tone,
                speed=speed,
            )
            yield AudioChunk(
                pcm_s16le=result.pcm_s16le,
                sample_rate=result.sample_rate,
                is_first=index == 0,
                is_last=index == len(sentences) - 1,
            )
