"""Manifest validation shared by the fine-tuning data and training scripts.

Pure standard-library logic so the consent and speaker-split rules in AGENTS.md
section 6.3 can be tested (and enforced) without torch or model downloads.
"""

from __future__ import annotations

import csv
from pathlib import Path

ALLOWED_LANGUAGES = frozenset({"en-NG", "pcm", "yo", "ig", "ha"})
ALLOWED_SPLITS = ("train", "dev", "test")
REQUIRED_COLUMNS = (
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
)


def load_manifest(manifest: Path) -> list[dict[str, str]]:
    """Read every manifest row; rows of all splits are returned together."""
    with manifest.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = reader.fieldnames or []
        missing = [column for column in REQUIRED_COLUMNS if column not in fieldnames]
        if missing:
            raise ValueError(f"Manifest {manifest} is missing columns: {', '.join(missing)}")
        rows = [dict(row) for row in list(reader) if row.get("clip_id")]
    if not rows:
        raise ValueError(f"No clip rows found in manifest {manifest}")
    return rows


def validate_rows(rows: list[dict[str, str]]) -> None:
    """Reject rows without consent or with unusable metadata.

    Raises PermissionError on missing consent (matching the benchmark loader),
    ValueError for anything else. Collects every problem instead of stopping at
    the first so one dry run reports the whole dataset.
    """
    problems: list[str] = []
    unconsented: list[str] = []
    for row in rows:
        clip_id = row.get("clip_id") or "<no clip_id>"
        if not row.get("consent_id"):
            unconsented.append(clip_id)
        if not row.get("reference_text"):
            problems.append(f"{clip_id}: reference_text is empty")
        if not row.get("speaker_id"):
            problems.append(f"{clip_id}: speaker_id is missing")
        language = row.get("language") or ""
        if language not in ALLOWED_LANGUAGES:
            problems.append(
                f"{clip_id}: language {language!r} is not one of {sorted(ALLOWED_LANGUAGES)}"
            )
        if (row.get("split") or "") not in ALLOWED_SPLITS:
            problems.append(
                f"{clip_id}: split {row.get('split')!r} is not one of {list(ALLOWED_SPLITS)}"
            )
        try:
            duration = float(row.get("duration_s") or "nan")
        except ValueError:
            duration = float("nan")
        if not duration > 0:
            problems.append(f"{clip_id}: duration_s must be a positive number")
    # Consent violations stay here AND keep the split invariants reportable, but
    # they must abort loudly; a dataset without consent is never written out.
    if problems:
        raise ValueError("Manifest validation failed:\n" + "\n".join(problems))
    if unconsented:
        raise PermissionError(
            "No consent_id for clips: " + ", ".join(unconsented) + "; refusing to prepare data"
        )


def split_rows(rows: list[dict[str, str]]) -> dict[str, list[dict[str, str]]]:
    """Group validated rows by their manifest split."""
    grouped: dict[str, list[dict[str, str]]] = {split: [] for split in ALLOWED_SPLITS}
    for row in rows:
        grouped[row["split"]].append(row)
    return grouped


def speaker_leakage_issues(grouped: dict[str, list[dict[str, str]]]) -> list[str]:
    """Return one issue per speaker classified into more than one split.

    Shared speakers would leak tuning information into the untouched test split
    (AGENTS.md 6.3), so any overlap blocks fine-tune preparation.
    """
    issues: list[str] = []
    for speaker_id in sorted({row.get("speaker_id") or "" for row in all_rows(grouped)}):
        if not speaker_id:
            continue
        splits = {
            split
            for split, rows in grouped.items()
            if any(row.get("speaker_id") == speaker_id for row in rows)
        }
        if len(splits) > 1:
            issues.append(f"speaker {speaker_id} appears in splits {', '.join(sorted(splits))}")
    return issues


def all_rows(grouped: dict[str, list[dict[str, str]]]) -> list[dict[str, str]]:
    return [row for rows in grouped.values() for row in rows]


def summarize(grouped: dict[str, list[dict[str, str]]]) -> dict[str, dict]:
    """Counts per split, language and speaker for stats.json and dry run."""
    stats: dict[str, dict] = {}
    for split, rows in grouped.items():
        languages: dict[str, int] = {}
        for row in rows:
            languages[row.get("language", "")] = languages.get(row.get("language", ""), 0) + 1
        stats[split] = {
            "clips": len(rows),
            "languages": dict(sorted(languages.items())),
            "speakers": len({row.get("speaker_id") or "" for row in rows}),
        }
    return stats
