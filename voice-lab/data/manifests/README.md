# Dataset manifests

Commit manifest metadata only. The actual audio must remain in a private
location or DVC remote and must not be committed. Obtain written consent for
every speaker, use pseudonymous speaker IDs, and keep the `test` split untouched
until final comparison.

CSV columns, in order:

```text
clip_id,speaker_id,language,accent_region,channel,network,sample_rate_hz,duration_s,scenario,reference_text,contains_numbers,contains_names,contains_pidgin,consent_id,split,recorded_at
```

The `split` column classifies each clip as `train`, `dev` or `test`:

- `train` clips feed LoRA fine-tuning via `scripts/prepare_finetune_data.py`
  and `scripts/finetune_whisper.py` only.
- `dev` clips drive every benchmark and hint comparison.
- `test` clips stay untouched until the final comparison (AGENTS.md 6.3).

Every speaker must appear in exactly one split. `prepare_finetune_data.py`
refuses to build the fine-tune dataset when a speaker spans several splits, so
the test split can never leak into tuning.
