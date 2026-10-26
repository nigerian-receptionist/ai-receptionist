"""OpenAI Whisper adapter for local, checksum-pinned checkpoints."""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
import wave
from collections.abc import AsyncIterator
from pathlib import Path

from voicelab.interfaces import SttEvent, SttResult, WordTiming


class OpenAIWhisperAdapter:
    """Load one local Whisper checkpoint and reuse it between turns."""

    def __init__(
        self,
        *,
        model_id: str,
        model_name: str,
        expected_sha256: str,
        device: str | None = None,
        cache_dir: str | None = None,
        cpu_threads: int | None = None,
    ) -> None:
        self.model_id = model_id
        self.model_name = model_name
        self.device = device or os.getenv("STT_DEVICE", "cpu")
        self.compute_type = "fp16" if self.device != "cpu" else "fp32"
        self.cache_dir = Path(
            cache_dir or os.getenv("WHISPER_CACHE_DIR") or Path.home() / ".cache" / "whisper"
        )
        try:
            import torch
            import whisper
        except ImportError as error:
            raise RuntimeError("Install the `speech` dependency group to use Whisper") from error

        if model_name not in whisper.available_models():
            raise ValueError(f"Unknown OpenAI Whisper model: {model_name}")
        if cpu_threads:
            torch.set_num_threads(cpu_threads)
        self._model = whisper.load_model(
            model_name,
            device=self.device,
            download_root=str(self.cache_dir),
        )
        checkpoint = self.cache_dir / f"{model_name}.pt"
        if not checkpoint.is_file():
            raise FileNotFoundError(f"Whisper checkpoint was not saved at {checkpoint}")
        actual_sha256 = self._sha256(checkpoint)
        if actual_sha256 != expected_sha256:
            raise ValueError(f"Whisper checkpoint checksum does not match registry: {checkpoint}")
        self.revision = f"sha256:{actual_sha256}"

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def transcribe_file(
        self,
        path: str,
        *,
        language: str | None = None,
        hints: list[str] | None = None,
    ) -> SttResult:
        input_path = Path(path)
        duration_s = _wav_duration(input_path)
        language_code = {"en-NG": "en", "pcm": "en"}.get(language or "", language)
        started = time.perf_counter()
        response = self._model.transcribe(
            str(input_path),
            language=language_code,
            initial_prompt="; ".join(hints or []) or None,
            word_timestamps=True,
            condition_on_previous_text=False,
            fp16=self.device != "cpu",
            verbose=False,
        )
        latency_s = time.perf_counter() - started
        words = [
            WordTiming(
                text=word["word"],
                start_s=float(word["start"]),
                end_s=float(word["end"]),
            )
            for segment in response.get("segments", [])
            for word in segment.get("words", [])
        ]
        detected = response.get("language", "")
        if detected == "en" and language == "en-NG":
            detected = "en-NG"
        return SttResult(
            text=response.get("text", "").strip(),
            language=detected,
            confidence=None,
            words=words,
            audio_s=duration_s,
            latency_s=latency_s,
            model_id=f"{self.model_id}@{self.revision}",
        )

    async def transcribe_stream(
        self,
        frames: AsyncIterator[bytes],
        *,
        sample_rate: int = 16000,
        language: str | None = None,
        hints: list[str] | None = None,
    ) -> AsyncIterator[SttEvent]:
        """Buffer PCM frames and emit one final event; no partials are fabricated."""
        chunks: list[bytes] = []
        async for frame in frames:
            chunks.append(frame)
        if not chunks:
            return
        temp_path: Path | None = None
        try:
            import tempfile

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
                temp_path = Path(handle.name)
            with wave.open(str(temp_path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(sample_rate)
                output.writeframes(b"".join(chunks))
            result = await asyncio.to_thread(
                self.transcribe_file,
                str(temp_path),
                language=language,
                hints=hints,
            )
            yield SttEvent(kind="final", result=result)
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as source:
        return source.getnframes() / source.getframerate()
