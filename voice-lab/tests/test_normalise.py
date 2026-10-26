from __future__ import annotations

import pytest

from voicelab.normalise import normalize_for_speech, number_to_words


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("N45,000", "forty-five thousand naira"),
        ("NGN 45,000", "forty-five thousand naira"),
        ("₦45,000", "forty-five thousand naira"),
        ("N1.5m", "one point five million naira"),
        ("N2.3bn", "two point three billion naira"),
        ("28/10", "the twenty-eighth of October"),
        ("28th Oct", "the twenty-eighth of October"),
        ("Oct 28", "the twenty-eighth of October"),
        ("2:30pm", "half past two in the afternoon"),
        ("14:30", "two thirty p m"),
        ("0803 123 4567", "zero eight zero three, one two three, four five six seven"),
        (
            "+234 803 123 4567",
            "zero eight zero three, one two three, four five six seven",
        ),
        ("ending in 4421", "ending in four, four, two, one"),
        ("BVN NIN POS NUBAN", "B V N N I N P O S N U B A N"),
        ("Ọ̀pọ̀lọpọ̀", "Ọ̀pọ̀lọpọ̀"),
    ],
)
def test_normalize_for_speech_examples(source: str, expected: str) -> None:
    assert normalize_for_speech(source) == expected


def test_urls_emails_markdown_and_emoji_are_removed() -> None:
    assert normalize_for_speech("**Call** https://example.com or me@example.com 😊") == "Call or"


@pytest.mark.parametrize(
    ("value", "expected"),
    [(0, "zero"), (21, "twenty-one"), (45_000, "forty-five thousand")],
)
def test_number_to_words(value: int, expected: str) -> None:
    assert number_to_words(value) == expected
