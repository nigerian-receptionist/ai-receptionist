"""Audio conversion helpers for the telephone-band benchmark."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def make_phone_audio(input_path: Path, output_dir: Path) -> tuple[Path, Path]:
    """Create mono 8 kHz mu-law and simulated 16 kHz PCM WAV files with ffmpeg."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg is required; install it and retry")
    if not input_path.is_file():
        raise FileNotFoundError(input_path)

    output_dir.mkdir(parents=True, exist_ok=True)
    phone_path = output_dir / f"{input_path.stem}_phone_8k_mulaw.wav"
    restored_path = output_dir / f"{input_path.stem}_phone_16k_pcm.wav"
    subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-y",
            "-i",
            str(input_path),
            "-ar",
            "8000",
            "-ac",
            "1",
            "-c:a",
            "pcm_mulaw",
            str(phone_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-y",
            "-i",
            str(phone_path),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(restored_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return phone_path, restored_path


def make_16k_mono_pcm(input_path: Path, output_path: Path) -> Path:
    """Resample a source clip to the internal 16 kHz mono PCM format."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg is required; install it and retry")
    if not input_path.is_file():
        raise FileNotFoundError(input_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-y",
            "-i",
            str(input_path),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return output_path
