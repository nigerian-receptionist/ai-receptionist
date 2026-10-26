"""Adapter for the official WavTokenizer audio codec implementation.

This adapter converts between mono 24 kHz waveforms and discrete audio codes.
It does not generate speech from text; a compatible speech-generation model
must produce codes before ``decode`` can be used for TTS.
"""

from __future__ import annotations

import hashlib
import importlib
import os
import sys
from pathlib import Path
from typing import Any


class WavTokenizerCodecAdapter:
    """Encode and decode audio with a locally checked-out WavTokenizer model."""

    model_id = "wavtokenizer"
    sample_rate_hz = 24000

    def __init__(self, model: Any, *, device: str, model_revision: str) -> None:
        try:
            import torch
        except ImportError as error:
            raise RuntimeError(
                "Install the optional `codec` dependency group to use WavTokenizer"
            ) from error
        if not model_revision:
            raise ValueError("model_revision must identify the exact local checkpoint")
        self._torch = torch
        self.device = device
        self.model_revision = model_revision
        self._model = model.to(device).eval()

    @classmethod
    def from_checkpoint(
        cls,
        *,
        source_root: str | Path,
        config_path: str | Path,
        checkpoint_path: str | Path,
        device: str = "cpu",
    ) -> WavTokenizerCodecAdapter:
        """Load upstream WavTokenizer code and a local config/checkpoint pair."""
        root = Path(source_root).expanduser().resolve()
        config = Path(config_path).expanduser().resolve()
        checkpoint = Path(checkpoint_path).expanduser().resolve()
        if not (root / "decoder" / "pretrained.py").is_file():
            raise FileNotFoundError(
                "source_root must point to a checkout of github.com/jishengpeng/WavTokenizer"
            )
        for asset in (config, checkpoint):
            if not asset.is_file():
                raise FileNotFoundError(f"WavTokenizer asset does not exist: {asset}")

        source_path = str(root)
        if source_path not in sys.path:
            sys.path.insert(0, source_path)
        try:
            upstream = importlib.import_module("decoder.pretrained")
            upstream_model = upstream.WavTokenizer.from_pretrained0802(str(config), str(checkpoint))
        except (ImportError, AttributeError) as error:
            raise RuntimeError(
                "Could not load WavTokenizer from the supplied source checkout. "
                "Install its inference dependencies in this environment."
            ) from error

        revision = f"config-sha256:{_sha256(config)};checkpoint-sha256:{_sha256(checkpoint)}"
        return cls(upstream_model, device=device, model_revision=revision)

    @classmethod
    def from_environment(cls) -> WavTokenizerCodecAdapter:
        """Load from WAVTOKENIZER_* paths documented in the lab README."""
        required = {
            "source_root": os.getenv("WAVTOKENIZER_ROOT"),
            "config_path": os.getenv("WAVTOKENIZER_CONFIG_PATH"),
            "checkpoint_path": os.getenv("WAVTOKENIZER_CHECKPOINT_PATH"),
        }
        missing = [key for key, value in required.items() if not value]
        if missing:
            variables = ", ".join(
                {
                    "source_root": "WAVTOKENIZER_ROOT",
                    "config_path": "WAVTOKENIZER_CONFIG_PATH",
                    "checkpoint_path": "WAVTOKENIZER_CHECKPOINT_PATH",
                }[key]
                for key in missing
            )
            raise RuntimeError(f"Set the local WavTokenizer paths: {variables}")
        return cls.from_checkpoint(
            **required,
            device=os.getenv("WAVTOKENIZER_DEVICE", "cpu"),
        )

    def encode(
        self,
        waveform: Any,
        *,
        sample_rate_hz: int = 24000,
        bandwidth_id: int = 0,
    ) -> Any:
        """Encode float audio in [-1, 1], shaped [samples] or [1, samples]."""
        if sample_rate_hz != self.sample_rate_hz:
            raise ValueError(
                f"WavTokenizer expects {self.sample_rate_hz} Hz; "
                "resample explicitly before calling encode"
            )
        audio = self._torch.as_tensor(waveform, dtype=self._torch.float32, device=self.device)
        if audio.ndim == 1:
            audio = audio.unsqueeze(0)
        if audio.ndim != 2 or audio.shape[0] != 1:
            raise ValueError("WavTokenizer adapter accepts one mono waveform at a time")
        if audio.numel() == 0 or not self._torch.isfinite(audio).all():
            raise ValueError("waveform must be non-empty and contain only finite samples")
        if audio.abs().max().item() > 1.001:
            raise ValueError("waveform samples must be normalized to the [-1, 1] range")

        bandwidth = self._torch.tensor([bandwidth_id], dtype=self._torch.long)
        with self._torch.inference_mode():
            encoded = self._model.encode_infer(audio, bandwidth_id=bandwidth)
        if len(encoded) == 2:
            _, codes = encoded
        elif len(encoded) == 3:
            _, codes, _ = encoded
        else:
            raise RuntimeError("Unexpected encode_infer output from WavTokenizer")
        return codes.detach().cpu()

    def decode(self, codes: Any, *, bandwidth_id: int = 0) -> Any:
        """Decode WavTokenizer codes to a mono float waveform at 24 kHz."""
        code_tensor = self._torch.as_tensor(codes, dtype=self._torch.long, device=self.device)
        if code_tensor.ndim == 2:
            code_tensor = code_tensor.unsqueeze(1)
        if code_tensor.ndim != 3 or code_tensor.shape[1] != 1:
            raise ValueError("codes must have shape [codebooks, frames] or [codebooks, 1, frames]")
        if code_tensor.shape[-1] == 0:
            raise ValueError("codes must contain at least one frame")

        bandwidth = self._torch.tensor([bandwidth_id], dtype=self._torch.long)
        with self._torch.inference_mode():
            features = self._model.codes_to_features(code_tensor)
            audio = self._model.decode(features, bandwidth_id=bandwidth)
        return audio.detach().cpu().squeeze(0)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
