#!/usr/bin/env python3
"""Turn ignored raw benchmark rows into a tracked aggregate Markdown summary."""

from __future__ import annotations

import argparse
import csv
import statistics
from collections import defaultdict
from pathlib import Path

from voicelab.metrics import latency_summary


def _number(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _p95(values: list[float]) -> float | None:
    return latency_summary(values)["p95"]


def stt_report(path: Path) -> str:
    groups: dict[tuple[str, str, str, str], dict[str, list[float]]] = defaultdict(
        lambda: defaultdict(list)
    )
    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            key = (row["model_id"], row["language"], row["network"], row["channel"])
            for metric in ("wer", "cer", "latency_s", "rtf"):
                value = _number(row.get(metric, ""))
                if value is not None:
                    groups[key][metric].append(value)
    lines = [
        f"# STT benchmark summary: `{path.stem}`",
        "",
        "Raw transcript hypotheses remain in the ignored raw output directory and are "
        "redacted before writing.",
        "",
        "| Model | Language | Network | Condition | WER | CER | Latency p50 / p95 (s) | "
        "RTF p50 / p95 |",
        "|---|---|---|---|---:|---:|---:|---:|",
    ]
    for (model, language, network, condition), metrics in sorted(groups.items()):
        wers, cers = metrics["wer"], metrics["cer"]
        latencies, rtfs = metrics["latency_s"], metrics["rtf"]
        lines.append(
            "| {} | {} | {} | {} | {} | {} | {} / {} | {} / {} |".format(
                model,
                language,
                network,
                condition,
                f"{statistics.mean(wers):.3f}" if wers else "—",
                f"{statistics.mean(cers):.3f}" if cers else "—",
                f"{statistics.median(latencies):.3f}" if latencies else "—",
                f"{_p95(latencies):.3f}" if _p95(latencies) is not None else "—",
                f"{statistics.median(rtfs):.3f}" if rtfs else "—",
                f"{_p95(rtfs):.3f}" if _p95(rtfs) is not None else "—",
            )
        )
    if not groups:
        lines.append("| No successful rows | — | — | — | — | — | — | — |")
    lines.extend(
        [
            "",
            "Per-language, network, channel and clean-versus-phone slices are shown separately. "
            "No test-split result should be used for model selection.",
            "",
        ]
    )
    return "\n".join(lines)


def tts_report(path: Path) -> str:
    groups: dict[tuple[str, str, str], dict[str, list[float]]] = defaultdict(
        lambda: defaultdict(list)
    )
    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            key = (row["model_id"], row["language"], row["voice_id"])
            for metric in ("latency_s", "ttfa_s", "rtf", "roundtrip_wer"):
                value = _number(row.get(metric, ""))
                if value is not None:
                    groups[key][metric].append(value)
    lines = [
        f"# TTS benchmark summary: `{path.stem}`",
        "",
        "| Model | Language | Voice | Total latency p50 / p95 (s) | TTFA p50 / p95 (s) | "
        "RTF p50 / p95 | Round-trip WER |",
        "|---|---|---|---:|---:|---:|---:|",
    ]
    for (model, language, voice), metrics in sorted(groups.items()):
        latencies, ttfas, rtfs, wers = (
            metrics["latency_s"],
            metrics["ttfa_s"],
            metrics["rtf"],
            metrics["roundtrip_wer"],
        )
        lines.append(
            "| {} | {} | {} | {} / {} | {} / {} | {} / {} | {} |".format(
                model,
                language,
                voice,
                f"{statistics.median(latencies):.3f}" if latencies else "—",
                f"{_p95(latencies):.3f}" if _p95(latencies) is not None else "—",
                f"{statistics.median(ttfas):.3f}" if ttfas else "—",
                f"{_p95(ttfas):.3f}" if _p95(ttfas) is not None else "—",
                f"{statistics.median(rtfs):.3f}" if rtfs else "—",
                f"{_p95(rtfs):.3f}" if _p95(rtfs) is not None else "—",
                f"{statistics.mean(wers):.3f}" if wers else "—",
            )
        )
    if not groups:
        lines.append("| No successful rows | — | — | — | — | — | — |")
    lines.extend(
        [
            "",
            "Kokoro returns a whole utterance. Its recorded TTFA is whole-call latency, not "
            "streaming TTFA; this comparison model is not a Nigerian-accent baseline.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["stt", "tts"])
    parser.add_argument("raw_csv", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("results/summary"))
    args = parser.parse_args()
    renderer = stt_report if args.kind == "stt" else tts_report
    summary = renderer(args.raw_csv)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    path = args.output_dir / f"{args.kind}_{args.raw_csv.stem}.md"
    path.write_text(summary, encoding="utf-8")
    print(path)


if __name__ == "__main__":
    main()
