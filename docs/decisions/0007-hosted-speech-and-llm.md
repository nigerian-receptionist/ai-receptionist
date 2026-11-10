# ADR 0007: Hosted speech (Cartesia) and LLM (Muse Spark) for the real-time loop

- **Status:** Accepted by the project owner (2026-11-10)
- **Date:** 2026-11-10
- **Amends:** AGENTS.md section 5 (speech stack policy) and section 4.2

## Context

The owner relaxed the "free and open-source speech only" rule: open-source
speech is preferred, not required. The immediate goal is a working spoken
exchange with low latency, without running GPU models locally.

## Decision

- **STT and TTS:** Cartesia streaming APIs over WebSocket (STT and TTS), behind
  the `SpeechToText` and `TextToSpeech` adapter interfaces. Key: `CARTESIA_API_KEY`.
- **Default voice:** the Cartesia voice "seun" (Nigerian accent,
  id `63b389ff-8a8c-4013-a4d6-df3b893812df`), configurable with `TTS_VOICE`.
  Its origin and licence for commercial use must be confirmed before a pilot.
- **LLM:** Meta Muse Spark 1.3 contributor (`muse-spark-1.3-contributor`) through
  the OpenAI-compatible endpoint `https://api.meta.ai/v1/chat/completions`
  (streaming). Key: `MUSE_API_KEY`. Model and base URL come from `LLM_MODEL` and
  `LLM_BASE_URL`; the adapter speaks the OpenAI chat-completions protocol, so the
  provider stays swappable.
- `reasoning_effort` defaults to `minimal` for live turns (`none` is rejected by
  this model); configurable with `LLM_REASONING_EFFORT`.
- Open-source adapters (faster-whisper, YarnGPT2, Kokoro from `voice-lab/`) remain
  valid alternatives behind the same interfaces.

## Consequences

- Call audio and transcripts leave our infrastructure (Cartesia, Meta). Before any
  real contact data is used, confirm data-processing terms, retention and
  cross-border transfer under the NDPA with counsel. Until then: synthetic and
  consented test audio only.
- Cartesia does not list Yoruba, Igbo, Hausa or Pidgin as languages; English
  (Nigerian accent) only for now.
- Usage is metered; per-turn usage is logged so cost is visible.

## Known gaps (must close before any pilot)

- **Names and addresses are not yet redacted.** The `redact()` rules cover
  card numbers, BVN/NIN, NUBAN, OTP/PIN, phone numbers, emails and URLs, but
  AGENTS.md 9.2 rule 10 also requires name/address detection (Presidio
  recognisers plus custom Nigerian patterns). A caller sentence like "my name
  is Adaeze Okafor, I live at 14 Allen Avenue Ikeja" is currently persisted
  verbatim. Add name/address recognisers and table-driven tests before any
  pilot; this gap was deliberately left open (no Presidio) in the
  review-findings pass of 2026-11-10.
