# ADR 0002: Speech model evaluation and selection

- **Status:** Proposed; no production speech model selected
- **Date:** 2026-10-26

## Context

M1 requires local speech evaluation on consented Nigerian speech, including
clean and simulated 8 kHz phone audio. Candidate weights and runtime licenses
must permit the intended use. Nigerian speech quality cannot be inferred from
English-only synthetic prompts.

## Options considered

| Role | Candidate | License/status | Evaluation status |
|---|---|---|---|
| STT baseline | OpenAI Whisper, large-v3-turbo | MIT code and weights; checkpoint SHA pinned | Pending consented Nigerian dev set |
| STT comparison | OpenAI Whisper, large-v3 | MIT code and weights; checkpoint SHA pinned | Pending consented Nigerian dev set |
| STT CPU comparison | OpenAI Whisper, small | MIT code and weights; checkpoint SHA pinned | Pending consented Nigerian dev set |
| TTS baseline | YarnGPT2 | Model card says Apache-2.0; training data, speaker rights, and helper-code rights unresolved | Blocked pending review |
| TTS comparison | Kokoro-82M via kokoro-onnx | Apache-2.0 weights; MIT runtime plus GPL phonemizer/eSpeak NG dependencies. Human approval for commercial use is recorded in ADR 0003. | Synthetic English timing and one synthetic round trip only; not a Nigerian-accent baseline |
| Codec component | WavTokenizer | MIT source and official model cards; exact checkpoint still to pin | Codec adapter only; it does not generate speech from text. See [ADR 0004](0004-wavtokenizer-codec.md) |

N-ATLaS, Parakeet, community weights, Orpheus, Chatterbox, Piper, and
fine-tunes remain blocked until the exact license and provenance checks in
[`licences.md`](licences.md) are complete.

## Decision

Build local adapters and reproducible benchmark tools, but select no production
STT or TTS model until quality, timing, license, and human listening results
are available. Use Kokoro only to exercise the TTS path and produce an
explicitly synthetic local demo. Its GPL runtime dependencies were approved
for commercial use by the human requester; see ADR 0003 and comply with GPL
obligations for any distribution. Keep all raw clips and benchmark rows ignored.

## Consequences

- STT comparisons use a consented manifest, hand-corrected references, and
  separate clean and phone-simulated results. Do not tune on the test split.
- Timing summaries report p50 and p95, with at least 20 measured runs after
  warm-up.
- TTS adoption remains blocked until the YarnGPT2 questions are resolved or a
  different candidate is approved after comparison.
- WavTokenizer is available as an audio codec component only. It does not
  change the TTS model decision or supply a text-to-speech generator.
- No production voice or model decision is made by this ADR. Update this record
  after a complete evaluation and human review.

## Results still required

The current machine has no consented speech corpus and no audio input device.
STT accuracy, phone-channel results, listener ratings, and live microphone
results are therefore pending. The tracked current benchmark status is in
[`voice-lab/results/summary/M1-status.md`](../../voice-lab/results/summary/M1-status.md).
