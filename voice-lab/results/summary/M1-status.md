# M1 benchmark status

Status recorded 2026-10-26. No production model selection is supported yet.

| Required result | Status | Reason / next input |
|---|---|---|
| STT WER and CER by language, network, clean and 8 kHz phone audio | Pending | No consented clips or hand-corrected references are available; one synthetic round-trip plumbing check matched exactly (WER 0.0, not a quality result) |
| STT p50/p95 latency and real-time factor | Pending | Run at least 20 repeats per clip/model on the consented dev manifest |
| TTS p50/p95 synthesis latency and RTF | Measured, comparison only | Kokoro `af_sarah`, four synthetic English prompts × 20 repeats: total latency p50/p95 13.032/17.020 s; whole-call latency used as non-streaming TTFA; RTF 2.507/3.354 on CPU. See [TTS summary](tts_tts_20261026T141553Z.md). |
| TTS round-trip WER | One synthetic plumbing check | One sentence through Kokoro, 8 kHz mu-law simulation and Whisper small: WER 0.0; STT latency 37.138 s for 2.665 s audio (RTF 13.937). Raw output is ignored at `results/raw/20261026T151945Z/`; this is not Nigerian accuracy evidence. |
| Nigerian listener ratings | Pending | Requires at least five Nigerian listeners and a blinded rating sheet |
| Microphone echo and LLM-in-the-loop spoken exchange | Not run | No audio input device is available on this machine |

STT and raw TTS outputs belong in ignored `results/raw/`. Only aggregate
summaries belong in this tracked directory. The TTS comparison uses synthetic
English phrases and Kokoro's `af_sarah` voice; it does not measure Nigerian
accent quality or establish a production choice. See [ADR 0002](../../../docs/decisions/0002-speech-models.md),
[GPL approval record](../../../docs/decisions/0003-gpl-speech-dependencies.md),
and the [license review](../../../docs/decisions/licences.md).
