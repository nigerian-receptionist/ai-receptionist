from __future__ import annotations

import pytest

from voicelab.metrics import latency_summary, normalize_for_metric, real_time_factor


def test_metric_normalization_preserves_letters_and_apostrophes() -> None:
    assert normalize_for_metric("Ọ̀ bụ́, echi! I'm here.") == "ọ̀ bụ́ echi i'm here"


def test_tone_stripping_preserves_under_dots() -> None:
    assert normalize_for_metric("ọ̀ bụ́", strip_tones=True) == "ọ bụ"


@pytest.mark.parametrize("audio_s", [0, -1])
def test_real_time_factor_rejects_empty_audio(audio_s: float) -> None:
    with pytest.raises(ValueError):
        real_time_factor(0.1, audio_s)


def test_latency_summary_uses_median_and_p95() -> None:
    summary = latency_summary([1, 2, 3, 4, 5])
    assert summary["p50"] == 3
    assert summary["p95"] == 4.8
