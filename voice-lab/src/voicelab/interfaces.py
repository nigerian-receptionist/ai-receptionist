"""Model-independent speech interfaces shared by the lab and demos."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class WordTiming:
    text: str
    start_s: float
    end_s: float
    confidence: float | None = None


@dataclass(frozen=True)
class SttResult:
    text: str
    language: str
    confidence: float | None
    words: list[WordTiming]
    audio_s: float
    latency_s: float
    model_id: str


@dataclass(frozen=True)
class SttEvent:
    kind: Literal["partial", "final"]
    result: SttResult


class SpeechToText(Protocol):
    model_id: str

    def transcribe_file(
        self, path: str, *, language: str | None = None, hints: list[str] | None = None
    ) -> SttResult: ...

    def transcribe_stream(
        self,
        frames: AsyncIterator[bytes],
        *,
        sample_rate: int = 16000,
        language: str | None = None,
        hints: list[str] | None = None,
    ) -> AsyncIterator[SttEvent]: ...


@dataclass(frozen=True)
class VoiceInfo:
    voice_id: str
    language: str
    gender: str = "unspecified"
    tones: list[str] | None = None


@dataclass(frozen=True)
class AudioChunk:
    pcm_s16le: bytes
    sample_rate: int
    is_first: bool
    is_last: bool


@dataclass(frozen=True)
class TtsResult:
    pcm_s16le: bytes
    sample_rate: int
    duration_s: float
    time_to_first_audio_s: float
    total_latency_s: float
    voice_id: str
    model_id: str
    text_spoken: str


class TextToSpeech(Protocol):
    model_id: str

    def voices(self) -> list[VoiceInfo]: ...

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str,
        language: str,
        tone: str = "neutral",
        speed: float = 1.0,
    ) -> TtsResult: ...

    def synthesize_stream(
        self,
        text: str,
        *,
        voice_id: str,
        language: str,
        tone: str = "neutral",
        speed: float = 1.0,
    ) -> AsyncIterator[AudioChunk]: ...
