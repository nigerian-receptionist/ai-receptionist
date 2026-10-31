"""Hint-mode matrix rules for compare_hints.py (pure logic, no model)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from compare_hints import hints_for, load_rows  # noqa: E402


def test_matrix_modes_select_the_expected_terms() -> None:
    hints = ["forty five thousand naira", "transfer"]
    hotwords = ["Adaeze", "Ikeja"]
    assert hints_for("none", hints, hotwords) == []
    assert hints_for("prompt", hints, hotwords) == hints
    assert hints_for("hotwords", hints, hotwords) == hotwords
    assert hints_for("both", hints, hotwords) == hints + hotwords


def test_unknown_mode_raises() -> None:
    with pytest.raises(ValueError):
        hints_for("whisper", [], [])


def test_load_rows_requires_consent(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.csv"
    manifest.write_text(
        "clip_id,language,channel,network,reference_text,consent_id,split\n"
        "c1,en-NG,phone_call,mtn,hello,,dev\n",
        encoding="utf-8",
    )
    with pytest.raises(PermissionError):
        load_rows(manifest, "dev")


def test_load_rows_filters_split(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.csv"
    manifest.write_text(
        "clip_id,language,channel,network,reference_text,consent_id,split\n"
        "c1,en-NG,phone_call,mtn,hello,consent-1,dev\n"
        "c2,en-NG,phone_call,mtn,demo,consent-2,test\n",
        encoding="utf-8",
    )
    rows = load_rows(manifest, "test")
    assert [row["clip_id"] for row in rows] == ["c2"]
