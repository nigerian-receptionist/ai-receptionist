"""Local Underdog Bark 3.0 speech recognition adapter."""

from __future__ import annotations

import hashlib
import importlib.util
import os
import sys
import time
import wave
from pathlib import Path

import numpy as np

from voicelab.interfaces import SttResult


class UnderdogBarkAdapter:
    """English-only Bark 3.0 transcription through the documented Transformers pipeline."""

    model_id = "stt_underdog_bark"
    model_name = "ConwayResearch/Underdog-Bark-3.0"
    revision = "85db2ad"
    loader_sha256 = "e86b7f130bec1a8fa14dd315cfce95785b890dbd30000f6ceb2597fdd4312b02"

    def __init__(self, *, device: str | None = None, local_files_only: bool | None = None) -> None:
        try:
            from huggingface_hub import hf_hub_download
        except ImportError as error:
            raise RuntimeError("Install the `underdog` dependency group to use Bark") from error

        self.device = device or os.getenv("UNDERDOG_BARK_DEVICE", "cpu")
        self.local_files_only = (
            local_files_only
            if local_files_only is not None
            else os.getenv("UNDERDOG_BARK_LOCAL_FILES_ONLY", "false").lower()
            in {"1", "true", "yes"}
        )
        self._loader_path = Path(
            hf_hub_download(
                repo_id=self.model_name,
                filename="bark_loader.py",
                revision=self.revision,
                local_files_only=self.local_files_only,
            )
        )
        self._model_path = Path(
            hf_hub_download(
                repo_id=self.model_name,
                filename="model.bark",
                revision=self.revision,
                local_files_only=self.local_files_only,
            )
        )
        loader_hash = hashlib.sha256(self._loader_path.read_bytes()).hexdigest()
        if loader_hash != self.loader_sha256:
            raise ValueError("Downloaded Bark loader does not match the reviewed pinned source")
        spec = importlib.util.spec_from_file_location(
            "voicelab_underdog_bark_loader", self._loader_path
        )
        if spec is None or spec.loader is None:
            raise ImportError("Could not load the pinned Underdog Bark runtime")
        self._loader = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self._loader
        spec.loader.exec_module(self._loader)
        self._model = None
        self._processor = None
        self._torch = None

    def _load_model(self):
        if self._model is None:
            import torch
            from transformers import AutoProcessor

            if self.device == "cpu":
                torch.set_num_threads(int(os.getenv("UNDERDOG_BARK_CPU_THREADS", "4")))
            model = self._loader.load_model(str(self._model_path), device=self.device)
            try:
                processor = AutoProcessor.from_pretrained(
                    "nvidia/parakeet-tdt-0.6b-v3", local_files_only=True
                )
            except OSError as error:
                raise RuntimeError(
                    "Underdog Bark's Parakeet processor files are missing from the local cache. "
                    "Run scripts/download_underdog_assets.py while online, then restart the app."
                ) from error
            self._model = model
            self._processor = processor
            self._torch = torch
        return self._model

    def _transcribe_with_cached_processor(
        self, model, samples: np.ndarray, sample_rate: int
    ) -> str:
        if sample_rate != 16000:
            import soxr

            samples = soxr.resample(samples, sample_rate, 16000)
        samples = np.concatenate(
            [np.zeros(int(0.25 * 16000), dtype=np.float32), samples.astype(np.float32)]
        )
        processor = self._processor
        inputs = processor([samples], sampling_rate=16000, return_tensors="pt", padding=True)
        device, dtype = next(model.parameters()).device, next(model.parameters()).dtype
        inputs = {
            key: value.to(device, dtype) if value.dtype.is_floating_point else value.to(device)
            for key, value in inputs.items()
        }
        with self._torch.inference_mode():
            output = model.generate(**inputs)
        return processor.batch_decode(output.sequences, skip_special_tokens=True)[0].strip()

    def transcribe_file(
        self,
        path: str,
        *,
        language: str | None = None,
        hints: list[str] | None = None,
        word_timestamps: bool = False,
    ) -> SttResult:
        # Bark returns a transcript without aligned words; accept the shared
        # option used by Whisper callers so adapter selection stays compatible.
        del hints, word_timestamps
        if language not in {None, "en", "en-NG", "en-US", "english"}:
            raise ValueError("Underdog Bark 3.0 currently supports English only")
        input_path = Path(path)
        with wave.open(str(input_path), "rb") as audio:
            duration_s = audio.getnframes() / audio.getframerate()
            if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
                raise ValueError("Bark input must be mono 16-bit PCM WAV audio")
            sample_rate = audio.getframerate()
            samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2")
        samples = samples.astype(np.float32) / 32768.0
        started = time.perf_counter()
        model = self._load_model()
        transcript = self._transcribe_with_cached_processor(model, samples, sample_rate)
        latency_s = time.perf_counter() - started
        return SttResult(
            text=transcript.strip(),
            language="en",
            confidence=None,
            words=[],
            audio_s=duration_s,
            latency_s=latency_s,
            model_id=f"{self.model_id}@{self.revision}",
        )
