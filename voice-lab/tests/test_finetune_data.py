"""Consent, split-integrity and output rules for fine-tune data preparation."""

from __future__ import annotations

import json
import sys
import wave
from pathlib import Path
from struct import pack

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from prepare_finetune_data import main as prepare_main  # noqa: E402

from voicelab.finetune_data import (  # noqa: E402
    load_manifest,
    speaker_leakage_issues,
    split_rows,
    summarize,
    validate_rows,
)


def row(clip_id: str, speaker_id: str, split: str) -> dict[str, str]:
    return {
        "clip_id": clip_id,
        "speaker_id": speaker_id,
        "language": "en-NG",
        "accent_region": "lagos",
        "channel": "phone_call",
        "network": "mtn",
        "sample_rate_hz": "16000",
        "duration_s": "2.5",
        "scenario": "lender_reminder",
        "reference_text": "Please deposit forty five thousand naira.",
        "contains_numbers": "1",
        "contains_names": "0",
        "contains_pidgin": "0",
        "consent_id": "consent-001",
        "split": split,
        "recorded_at": "2026-10-30T10:00:00Z",
    }


def write_manifest(path: Path, rows: list[dict[str, str]]) -> Path:
    header = [
        "clip_id",
        "speaker_id",
        "language",
        "accent_region",
        "channel",
        "network",
        "sample_rate_hz",
        "duration_s",
        "scenario",
        "reference_text",
        "contains_numbers",
        "contains_names",
        "contains_pidgin",
        "consent_id",
        "split",
        "recorded_at",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(",".join(header) + "\n")
        for entry in rows:
            handle.write(",".join(entry[column] for column in header) + "\n")
    return path


def make_wav(path: Path, seconds: float = 1.0, sample_rate_hz: int = 16000) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = int(seconds * sample_rate_hz)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate_hz)
        handle.writeframes(b"".join(pack("<h", 0) for _ in range(frames)))
    return path


def test_missing_consent_aborts() -> None:
    bad = row("c1", "s1", "dev")
    bad["consent_id"] = ""
    with pytest.raises(PermissionError):
        validate_rows([bad])


def test_invalid_language_and_split_are_rejected() -> None:
    bad = row("c1", "s1", "hold")
    bad["language"] = "fr"
    with pytest.raises(ValueError, match="split|language"):
        validate_rows([bad])


def test_speaker_leakage_is_detected() -> None:
    grouped = {
        "train": [row("c1", "s1", "train")],
        "dev": [row("c2", "s1", "dev")],
        "test": [],
    }
    issues = speaker_leakage_issues(grouped)  # type: ignore[arg-type]
    assert len(issues) == 1
    assert "s1" in issues[0]


def test_clean_splits_pass_leakage() -> None:
    grouped = split_rows([row("c1", "s1", "train"), row("c2", "s2", "test")])
    assert speaker_leakage_issues(grouped) == []


def test_summarize_counts_languages_and_speakers() -> None:
    grouped = {
        "train": [row("c1", "s1", "train"), row("c2", "s2", "train")],
        "dev": [row("c3", "s3", "dev")],
        "test": [],
    }
    stats = summarize(grouped)  # type: ignore[arg-type]
    assert stats["train"]["clips"] == 2
    assert stats["train"]["speakers"] == 2
    assert stats["dev"]["languages"] == {"en-NG": 1}
    assert stats["test"]["clips"] == 0


def test_missing_required_columns_fail(tmp_path: Path) -> None:
    manifest = tmp_path / "broken.csv"
    manifest.write_text("clip_id,speaker_id\nc1,s1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="missing columns"):
        load_manifest(manifest)


def test_prepare_builds_jsonl_and_phone_copies(tmp_path: Path) -> None:
    audio_dir = tmp_path / "audio"
    make_wav(audio_dir / "clip_train.wav")
    make_wav(audio_dir / "clip_dev.wav")
    make_wav(audio_dir / "clip_test.wav")
    manifest = write_manifest(
        tmp_path / "manifest.csv",
        [
            row("clip_train", "sp_train", "train"),
            row("clip_dev", "sp_dev", "dev"),
            row("clip_test", "sp_test", "test"),
        ],
    )
    output_dir = tmp_path / "finetune"
    exit_code = prepare_main(
        [
            "--manifest",
            str(manifest),
            "--audio-dir",
            str(audio_dir),
            "--output-dir",
            str(output_dir),
        ]
    )
    assert exit_code == 0
    train_rows = [
        json.loads(line)
        for line in (output_dir / "train.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert len(train_rows) == 1
    example = train_rows[0]
    assert example["consent_id"] == "consent-001"
    assert Path(example["audio_clean"]).is_file()
    audio = wave.open(str(Path(example["audio_clean"])), "rb")
    assert audio.getframerate() == 16000
    assert audio.getnchannels() == 1
    audio.close()
    assert Path(example["audio_phone"]).is_file()
    phone = wave.open(str(Path(example["audio_phone"])), "rb")
    assert phone.getframerate() == 16000
    phone.close()
    for split in ("dev", "test"):
        assert (output_dir / f"{split}.jsonl").read_text(encoding="utf-8").strip()
    stats = json.loads((output_dir / "stats.json").read_text(encoding="utf-8"))
    assert stats["failures"]["train"] == []


def test_prepare_skips_nothing_unless_asked(tmp_path: Path) -> None:
    audio_dir = tmp_path / "audio"
    make_wav(audio_dir / "clip_train.wav")
    manifest = write_manifest(tmp_path / "manifest.csv", [row("clip_train", "sp_train", "train")])
    output_dir = tmp_path / "finetune"
    exit_code = prepare_main(
        [
            "--manifest",
            str(manifest),
            "--audio-dir",
            str(audio_dir),
            "--output-dir",
            str(output_dir),
            "--skip-phone",
        ]
    )
    assert exit_code == 0
    example = json.loads((output_dir / "train.jsonl").read_text(encoding="utf-8").strip())
    assert "audio_phone" not in example


def test_prepare_refuses_leaked_speakers(tmp_path: Path) -> None:
    audio_dir = tmp_path / "audio"
    make_wav(audio_dir / "clip_dev.wav")
    make_wav(audio_dir / "clip_test.wav")
    manifest = write_manifest(
        tmp_path / "manifest.csv",
        [row("clip_dev", "sp_shared", "dev"), row("clip_test", "sp_shared", "test")],
    )
    exit_code = prepare_main(
        [
            "--manifest",
            str(manifest),
            "--audio-dir",
            str(audio_dir),
            "--output-dir",
            str(tmp_path / "finetune"),
        ]
    )
    assert exit_code == 3
    assert not (tmp_path / "finetune" / "test.jsonl").exists()


def test_prepare_validate_only_writes_nothing(tmp_path: Path) -> None:
    audio_dir = tmp_path / "audio"
    make_wav(audio_dir / "clip_dev.wav")
    manifest = write_manifest(tmp_path / "manifest.csv", [row("clip_dev", "sp_dev", "dev")])
    output_dir = tmp_path / "finetune"
    exit_code = prepare_main(
        [
            "--manifest",
            str(manifest),
            "--audio-dir",
            str(audio_dir),
            "--output-dir",
            str(output_dir),
            "--validate-only",
        ]
    )
    assert exit_code == 0
    assert not output_dir.exists()


def test_prepare_reports_missing_audio(tmp_path: Path) -> None:
    manifest = write_manifest(tmp_path / "manual.csv", [row("ghost", "sp_dev", "dev")])
    exit_code = prepare_main(
        [
            "--manifest",
            str(manifest),
            "--audio-dir",
            str(tmp_path / "nowhere"),
            "--output-dir",
            str(tmp_path / "finetune"),
        ]
    )
    assert exit_code == 2
