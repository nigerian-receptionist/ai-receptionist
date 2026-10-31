#!/usr/bin/env python3
"""LoRA fine-tune Whisper on consented, speaker-disjoint prepared splits.

--dry-run is model-free: it validates the JSONL splits from
prepare_finetune_data.py (consent ids, speaker disjointness, audio paths)
without importing torch, so it runs anywhere including CI.

The real training path uses standard documented components —
transformers WhisperForConditionalGeneration/WhisperProcessor plus PEFT
LoraConfig targeting the attention projections ("q_proj", "v_proj") and
get_peft_model / save_pretrained — over a plain PyTorch loop. It has NOT been
executed on this machine (no GPU); validate it on the target GPU before any
adoption, and never tune on the test split (AGENTS.md section 6.3).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from voicelab.finetune_data import speaker_leakage_issues, summarize
from voicelab.run_metadata import collect_run_metadata

OUTPUT_SPLITS = ("train", "dev", "test")


def build_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("data/finetune"),
        help="Directory written by prepare_finetune_data.py ({train,dev,test}.jsonl)",
    )
    parser.add_argument(
        "--base-model",
        default="openai/whisper-small",
        help="MIT-licensed Whisper checkpoint; small or turbo size per AGENTS.md 6.7",
    )
    parser.add_argument("--output-dir", type=Path, default=Path("models/finetune"))
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--lora-r", type=int, default=8)
    parser.add_argument("--lora-alpha", type=int, default=16)
    parser.add_argument("--lora-dropout", type=float, default=0.05)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument(
        "--language",
        default="en",
        help="Whisper language token (en, yo, ha, ig; Pidgin is not a Whisper language)",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="cuda or cpu; defaults to cuda when available (training only)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate the prepared data only; no model or dependency is loaded",
    )
    args = parser.parse_args(argv)
    args.data_dir = args.data_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    return args


def load_examples(data_dir: Path) -> tuple[dict[str, list[dict]], list[str]]:
    """Read {split}.jsonl files; return rows per split and any file problems."""
    problems: list[str] = []
    grouped: dict[str, list[dict]] = {}
    for split in OUTPUT_SPLITS:
        path = data_dir / f"{split}.jsonl"
        if not path.is_file():
            problems.append(f"missing {path}; run prepare_finetune_data.py first")
            grouped[split] = []
            continue
        rows = []
        with path.open(encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as error:
                    problems.append(f"{path}:{line_number}: {error}")
                    continue
                if not row.get("consent_id"):
                    problems.append(f"{path}:{line_number}: no consent_id")
                if not row.get("audio_clean") or not Path(row["audio_clean"]).is_file():
                    problems.append(f"{path}:{line_number}: audio_clean file not found")
                rows.append(row)
        grouped[split] = rows
    return grouped, problems


def dry_run(args: argparse.Namespace) -> dict:
    grouped, problems = load_examples(args.data_dir)
    leakage = speaker_leakage_issues(
        {split: rows for split, rows in grouped.items()}  # type: ignore[arg-type]
    )
    summary = {
        "dry_run": True,
        "data_dir": str(args.data_dir),
        "stats": summarize(grouped),  # type: ignore[arg-type]
        "leakage": leakage,
        "problems": problems,
        "planned": {
            "base_model": args.base_model,
            "epochs": args.epochs,
            "lr": args.lr,
            "lora_r": args.lora_r,
            "lora_alpha": args.lora_alpha,
            "lora_dropout": args.lora_dropout,
            "batch_size": args.batch_size,
            "language": args.language,
            "output_dir": str(args.output_dir),
            "target_modules": ["q_proj", "v_proj"],
        },
    }
    return summary


def train(args: argparse.Namespace) -> dict:  # pragma: no cover - requires torch and a GPU
    try:
        import soundfile as sf
        import torch
        from peft import LoraConfig, get_peft_model
        from transformers import (
            WhisperForConditionalGeneration,
            WhisperProcessor,
        )
    except ImportError as error:
        raise RuntimeError(
            "Training needs the finetune dependency group (uv sync --group finetune)"
        ) from error

    grouped, problems = load_examples(args.data_dir)
    if problems:
        raise RuntimeError("Prepared data problems:\n" + "\n".join(problems))
    if not grouped["train"]:
        raise RuntimeError(f"No train examples in {args.data_dir}/train.jsonl")

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    # Whisperprocessor for the feature extractor and the label tokenizer; the
    # language token is fixed for the whole run, so one run serves one language.
    processor = WhisperProcessor.from_pretrained(
        args.base_model, language=args.language, task="transcribe"
    )
    model = WhisperForConditionalGeneration.from_pretrained(args.base_model).to(device)
    config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        target_modules=["q_proj", "v_proj"],
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="SEQ_2_SEQ_LM",
    )
    model = get_peft_model(model, config)
    model.print_trainable_parameters()

    optimizer = torch.optim.AdamW(
        (parameter for parameter in model.parameters() if parameter.requires_grad),
        lr=args.lr,
    )
    rng = __import__("random").Random(2026)  # deterministic shuffle; dataset is small
    epoch_losses: list[dict] = []
    for epoch in range(1, args.epochs + 1):
        order = list(grouped["train"])
        rng.shuffle(order)
        losses: list[float] = []
        for example in order:
            audio, sample_rate = sf.read(example["audio_clean"], dtype="float32")
            if sample_rate != 16000:
                raise ValueError(
                    f"{example['clip_id']}: expected 16 kHz mono PCM, got {sample_rate} Hz"
                )
            if audio.ndim != 1:
                raise ValueError(f"{example['clip_id']}: audio is not mono")
            features = processor(
                audio=audio,
                sampling_rate=16000,
                return_tensors="pt",
            )
            labels = processor.tokenizer(
                example["reference_text"],
                return_tensors="pt",
            ).input_ids
            outputs = model(
                input_features=features["input_features"].to(device),
                labels=labels.to(device),
            )
            loss = outputs.loss
            loss.backward()
            optimizer.step()
            optimizer.zero_grad()
            losses.append(float(loss.detach()))
        epoch_losses.append(
            {
                "epoch": epoch,
                "mean_loss": sum(losses) / len(losses) if losses else None,
                "steps": len(losses),
            }
        )
        print(json.dumps({"epoch": epoch, "mean_loss": epoch_losses[-1]["mean_loss"]}))

    # save_pretrained on a PeftModel writes the adapter, not the base weights.
    args.output_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(args.output_dir)
    processor.save_pretrained(args.output_dir)
    return {
        "dry_run": False,
        "base_model": args.base_model,
        "output_dir": str(args.output_dir),
        "device": device,
        "language": args.language,
        "epoch_losses": epoch_losses,
        "stats": summarize(grouped),  # type: ignore[arg-type]
        "metadata": collect_run_metadata(
            config={
                "epochs": args.epochs,
                "lr": args.lr,
                "lora_r": args.lora_r,
                "lora_alpha": args.lora_alpha,
                "language": args.language,
            },
            models=[
                {
                    "model_id": "stt_ft_own",
                    "model_name": args.base_model,
                }
            ],
        ),
    }


def main(argv: list[str] | None = None) -> int:
    args = build_arguments(argv)
    if args.dry_run:
        print(json.dumps(dry_run(args), ensure_ascii=False, indent=2))
        if not grouped_present(args):
            print("Missing prepared example files; run prepare_finetune_data.py", file=sys.stderr)
            return 2
        return 0
    summary = train(args)  # pragma: no cover - requires torch and a GPU
    summary_path = args.output_dir / "train_summary.json"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Adapter: {args.output_dir}")
    print(f"Summary: {summary_path}")
    return 0


def grouped_present(args: argparse.Namespace) -> bool:
    return all((args.data_dir / f"{split}.jsonl").is_file() for split in OUTPUT_SPLITS)


if __name__ == "__main__":
    raise SystemExit(main())
