"""Speech quality and timing metrics shared by smoke and benchmark commands."""

from __future__ import annotations

import statistics
import unicodedata

_TONE_MARKS = {
    "COMBINING GRAVE ACCENT",
    "COMBINING ACUTE ACCENT",
    "COMBINING MACRON",
    "COMBINING CARON",
    "COMBINING TILDE",
    "COMBINING CIRCUMFLEX ACCENT",
}


def normalize_for_metric(text: str, *, strip_tones: bool = False) -> str:
    """Normalize both reference and hypothesis without transliterating languages."""
    value = unicodedata.normalize("NFC", text).lower()
    if strip_tones:
        value = "".join(
            char
            for char in unicodedata.normalize("NFD", value)
            if unicodedata.name(char, "") not in _TONE_MARKS
        )
        value = unicodedata.normalize("NFC", value)
    output: list[str] = []
    for char in value:
        category = unicodedata.category(char)
        if char.isspace() or category[0] in {"L", "M", "N"} or char in {"'", "’"}:
            output.append(char)
        else:
            output.append(" ")
    return " ".join("".join(output).split())


def word_error_rate(reference: str, hypothesis: str, *, strip_tones: bool = False) -> float:
    """Compute WER with jiwer after applying the same normalization to both sides."""
    try:
        from jiwer import wer
    except ImportError as error:
        raise RuntimeError("Install the `speech` dependency group to calculate WER") from error
    return float(
        wer(
            normalize_for_metric(reference, strip_tones=strip_tones),
            normalize_for_metric(hypothesis, strip_tones=strip_tones),
        )
    )


def character_error_rate(reference: str, hypothesis: str, *, strip_tones: bool = False) -> float:
    """Compute CER with jiwer after applying the same normalization to both sides."""
    try:
        from jiwer import cer
    except ImportError as error:
        raise RuntimeError("Install the `speech` dependency group to calculate CER") from error
    return float(
        cer(
            normalize_for_metric(reference, strip_tones=strip_tones),
            normalize_for_metric(hypothesis, strip_tones=strip_tones),
        )
    )


def real_time_factor(processing_s: float, audio_s: float) -> float:
    if audio_s <= 0:
        raise ValueError("audio_s must be positive")
    return processing_s / audio_s


def latency_summary(values: list[float]) -> dict[str, float | None]:
    """Return median and inclusive p95 latency, or nulls for an empty sample."""
    if not values:
        return {"p50": None, "p95": None}
    ordered = [float(value) for value in values]
    p95 = (
        statistics.quantiles(ordered, n=20, method="inclusive")[-1]
        if len(ordered) > 1
        else ordered[0]
    )
    return {"p50": statistics.median(ordered), "p95": p95}
