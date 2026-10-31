#!/usr/bin/env python3
"""Merge a LoRA adapter into Whisper and convert the result to CTranslate2.

Produces the artifact the next generation of `stt_ft_own` evaluation needs:
a CTranslate2 model directory that can run under faster-whisper once an
adapter for it is registered and benchmarked (AGENTS.md sections 5.1 and 6.2).

Steps:
1. Load the MIT-licensed base Whisper checkpoint, attach the PEFT adapter
   saved by finetune_whisper.py with PeftModel.from_pretrained, and reduce it
   to plain weights with merge_and_unload() (documented PEFT API).
2. Save the merged model plus its processor to a temporary directory.
3. Run the CTranslate2 converter CLI that the upstream transformers guide
   documents for Whisper checkpoints:
   ct2-transformers-converter --model <merged_dir> --output_dir <out> --quantization <q>

--dry-run validates the adapter directory and prints the exact commands
without importing torch or running the converter.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from voicelab.run_metadata import collect_run_metadata, create_run_id

CONVERTER_NAME = "ct2-transformers-converter"


def build_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-model", default="openai/whisper-small")
    parser.add_argument("--adapter-dir", type=Path, required=True, help="PEFT adapter directory")
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Destination CTranslate2 model directory (git-ignored, e.g. models/finetune-ct2)",
    )
    parser.add_argument(
        "--quantization",
        default="float16",
        help="Converter --quantization value (float32, float16, int8, int8_float16, ...)",
    )
    parser.add_argument(
        "--ct2-extra",
        nargs="*",
        default=[],
        help="Extra converter flags passed through verbatim, see CTranslate2 converter docs",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and print the commands without running anything",
    )
    args = parser.parse_args(argv)
    args.adapter_dir = args.adapter_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    return args


def validate_adapter_dir(adapter_dir: Path) -> None:
    if not adapter_dir.is_dir():
        raise FileNotFoundError(f"Adapter directory not found: {adapter_dir}")
    if not (adapter_dir / "adapter_config.json").is_file():
        raise FileNotFoundError(
            f"{adapter_dir} is missing adapter_config.json; point --adapter-dir at a "
            "PEFT adapter written by finetune_whisper.py"
        )
    if not list(adapter_dir.glob("adapter_model.*")):
        raise FileNotFoundError(f"{adapter_dir} contains no adapter_model.* weights")


def converter_command(
    converter_path: str,
    args: argparse.Namespace,
    merged_dir: str,
) -> list[str]:
    if not merged_dir:
        raise ValueError("merged_dir is required to build the converter command")
    return [
        converter_path,
        "--model",
        merged_dir,
        "--output_dir",
        str(args.output_dir),
        "--quantization",
        args.quantization,
        *args.ct2_extra,
    ]


def find_converter() -> str | None:
    return shutil.which(CONVERTER_NAME)


def run_merge(args: argparse.Namespace) -> Path:  # pragma: no cover - requires torch
    try:
        from peft import PeftModel
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
    except ImportError as error:
        raise RuntimeError(
            "Merging needs the finetune dependency group (uv sync --group finetune)"
        ) from error

    model = WhisperForConditionalGeneration.from_pretrained(args.base_model)
    peft_model = PeftModel.from_pretrained(model, args.adapter_dir)
    # merge_and_unload() returns a new plain model; the adapter weights are not
    # kept in memory afterwards (documented PEFT behaviour).
    merged = peft_model.merge_and_unload()
    merged_dir = Path(tempfile.mkdtemp(prefix="voice-lab-merged-"))
    merged.save_pretrained(merged_dir)
    WhisperProcessor.from_pretrained(args.base_model).save_pretrained(merged_dir)
    return merged_dir


def main(argv: list[str] | None = None) -> int:
    args = build_arguments(argv)
    validate_adapter_dir(args.adapter_dir)
    converter_path = find_converter()
    merged_placeholder = "<temporary merged Whisper model directory>"

    if args.dry_run:
        summary = {
            "dry_run": True,
            "base_model": args.base_model,
            "adapter_dir": str(args.adapter_dir),
            "output_dir": str(args.output_dir),
            "quantization": args.quantization,
            "converter_found": converter_path,
            "commands": [
                "merge_and_unload (in process, transformers + peft)",
                " ".join(converter_command(CONVERTER_NAME, args, merged_placeholder)),
            ],
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    if converter_path is None:
        raise RuntimeError(
            f"{CONVERTER_NAME} not found on PATH; install ctranslate2 "
            "(uv sync --group ctranslate2) or add it to PATH"
        )
    if args.output_dir.exists() and list(args.output_dir.iterdir()):
        raise FileExistsError(f"Output directory not empty: {args.output_dir}")

    merged_dir = run_merge(args)  # pragma: no cover - requires torch
    try:
        command = converter_command(converter_path, args, str(merged_dir))
        subprocess.run(command, check=True)
    finally:
        shutil.rmtree(merged_dir, ignore_errors=True)

    summary = {
        "dry_run": False,
        "run_id": create_run_id(),
        "base_model": args.base_model,
        "adapter_dir": str(args.adapter_dir),
        "output_dir": str(args.output_dir),
        "quantization": args.quantization,
        **collect_run_metadata(
            config={"quantization": args.quantization},
            models=[{"model_id": "stt_ft_own", "model_name": args.base_model}],
        ),
    }
    summary_path = args.output_dir / "run_metadata.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
