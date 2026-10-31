#!/usr/bin/env python3
"""Build a private YarnGPT2 speaker profile from a WAV and WhisperX alignment."""

from __future__ import annotations

import argparse
import json
import math
import re
import wave
from pathlib import Path
from typing import Any

import numpy as np

from voicelab.adapters.codec.wavtokenizer import WavTokenizerCodecAdapter


def _read_mono_24k_wav(path: Path) -> tuple[np.ndarray, float]:
    with wave.open(str(path), "rb") as source:
        if (
            source.getnchannels() != 1
            or source.getsampwidth() != 2
            or source.getframerate() != 24000
            or source.getcomptype() != "NONE"
        ):
            raise ValueError("Reference WAV must be mono, 24 kHz, uncompressed PCM16")
        sample_count = source.getnframes()
        samples = np.frombuffer(source.readframes(sample_count), dtype="<i2").astype(np.float32)
    if samples.size == 0:
        raise ValueError("Reference WAV contains no audio")
    return samples / 32768.0, len(samples) / 24000


def _single_codebook(encoded: Any) -> list[int]:
    codes = encoded.detach().cpu()
    if codes.ndim == 3 and codes.shape[:2] == (1, 1):
        codes = codes[0, 0]
    elif codes.ndim == 2 and codes.shape[0] == 1:
        codes = codes[0]
    elif codes.ndim != 1:
        raise ValueError(f"Expected a single WavTokenizer codebook, got shape {tuple(codes.shape)}")
    sequence = [int(value) for value in codes.tolist()]
    if not sequence:
        raise ValueError("WavTokenizer returned an empty code sequence")
    return sequence


def _validate_consent(path: Path, consent_id: str) -> dict[str, Any]:
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("consent_id") != consent_id or record.get("voice_use_authorized") is not True:
        raise PermissionError("Consent record must match --consent-id and authorize this voice")
    return record


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, required=True, help="Private mono 24 kHz PCM16 WAV")
    parser.add_argument(
        "--alignment", type=Path, required=True, help="Corrected WhisperX JSON with word_segments"
    )
    parser.add_argument("--voice-id", required=True, help="Local profile filename stem")
    parser.add_argument("--consent-id", required=True, help="ID from the private permission record")
    parser.add_argument(
        "--consent-record", type=Path, required=True, help="Private JSON permission record"
    )
    parser.add_argument("--output-dir", type=Path, default=Path("models/yarngpt2/speakers"))
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.voice_id):
        parser.error("--voice-id may contain only letters, digits, '_' and '-'")

    consent = _validate_consent(args.consent_record, args.consent_id)
    audio, audio_duration = _read_mono_24k_wav(args.audio)
    alignment = json.loads(args.alignment.read_text(encoding="utf-8"))
    segments = alignment.get("word_segments")
    if not isinstance(segments, list) or not segments:
        parser.error("Alignment JSON must contain a non-empty top-level word_segments list")
    for segment in segments:
        if not isinstance(segment.get("word"), str) or not segment["word"].strip():
            parser.error("Each word_segments entry needs a corrected, non-empty 'word'")
        start, end = float(segment["start"]), float(segment["end"])
        if start < 0 or end <= start or end > audio_duration + 0.05:
            parser.error(f"Invalid word timing {start:.3f}–{end:.3f}s for the reference WAV")

    codec = WavTokenizerCodecAdapter.from_environment()
    encoded = codec.encode(audio, sample_rate_hz=24000)
    codes = _single_codebook(encoded)
    frames_per_second = len(codes) / audio_duration
    profile_words = []
    for segment in segments:
        start, end = float(segment["start"]), float(segment["end"])
        first = max(0, math.floor(start * frames_per_second))
        last = min(len(codes), math.ceil(end * frames_per_second))
        if last <= first:
            last = min(len(codes), first + 1)
        if first >= len(codes) or last <= first:
            parser.error(f"No WavTokenizer frames overlap word {segment['word']!r}")
        profile_words.append(
            {
                "word": segment["word"].strip(),
                "duration": round(end - start, 2),
                "codes": codes[first:last],
            }
        )

    transcript = " ".join(word["word"] for word in profile_words)
    profile = {
        "text": transcript,
        "words": profile_words,
        "voice_use_authorized": True,
        "consent_id": args.consent_id,
        "profile_scope": consent.get("scope", "local evaluation only"),
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    output = args.output_dir / f"{args.voice_id}.json"
    output.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Private YarnGPT2 profile written to {output}")
    print(f"WavTokenizer revision: {codec.model_revision}")
    print(f"Aligned words: {len(profile_words)}; reference duration: {audio_duration:.2f}s")


if __name__ == "__main__":
    main()
