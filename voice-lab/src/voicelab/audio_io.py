"""Small WAV helpers used by the command-line tools."""

from __future__ import annotations

import wave
from pathlib import Path


def write_pcm_wav(path: str | Path, pcm_s16le: bytes, sample_rate: int) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm_s16le)


def wav_duration(path: str | Path) -> float:
    with wave.open(str(path), "rb") as source:
        frames = source.getnframes()
        rate = source.getframerate()
    return frames / rate
