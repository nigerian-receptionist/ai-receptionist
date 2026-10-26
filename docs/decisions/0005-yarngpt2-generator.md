# ADR 0005: YarnGPT2 text-to-speech generator

- **Status:** Accepted for local experimental evaluation; commercial deployment pending review
- **Date:** 2026-10-26

## Context

WavTokenizer can decode audio codes but cannot generate speech from text. The
voice lab needs a Nigerian-accented English text generator to exercise that
codec and run a local conversation demo. The YarnGPT2 model card identifies
Apache-2.0 weights and describes experimental use, while also disclosing public
movie and podcast training sources. Upstream demo code uses speaker prompt
profiles whose voice rights have not been cleared for this project.

## Decision

Add `YarnGPT2Adapter` as an experimental TTS generator. It loads an explicit
Hugging Face revision, builds the model prompt from text and a local speaker
profile, generates discrete audio codes, and passes them to the WavTokenizer
codec adapter. The adapter supports English only and performs full-utterance
generation before playback; sentence chunking is emulated rather than true
streaming.

Do not bundle or load upstream preset-speaker profiles. A local profile must
include `voice_use_authorized: true` and a `consent_id` tied to a written
permission record. Keep profile JSON and model artifacts under ignored
`models/`. This adapter does not train or fine-tune voices.

## Consequences

- Local users can generate speech and try the model in the microphone echo loop
  without Ollama or another LLM.
- Meaningful voice use requires a compatible profile from the speaker's own
  voice or another speaker with documented permission.
- The model's Apache-2.0 card does not itself establish rights to its training
  sources or speaker likenesses. Commercial use remains pending review.
- Pin the Hugging Face commit and record codec checkpoint hashes for benchmark
  reproducibility.
