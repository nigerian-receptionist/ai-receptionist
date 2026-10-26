# ADR 0004: WavTokenizer codec adapter

- **Status:** Accepted for codec-only experimentation
- **Date:** 2026-10-26

## Context

The voice lab needs an adapter boundary for WavTokenizer, which converts
between waveforms and discrete audio codes. It does not perform text-to-speech
by itself. The upstream project and official model card are MIT-licensed, but
the upstream source is not published as a normal Python package and its
requirements file pins an older PyTorch stack.

## Decision

Add `WavTokenizerCodecAdapter` as an audio-codec adapter. It accepts mono
24 kHz float waveforms and returns discrete codes; it decodes compatible codes
to waveforms. It does not add YarnGPT2, another text generator, voice training,
or voice training. YarnGPT2 integration is recorded separately in
[ADR 0005](0005-yarngpt2-generator.md). Source and checkpoint paths are local and ignored. The
adapter records SHA-256 hashes for the config and checkpoint as its model
revision.

## Consequences

- Install the optional `codec` dependency group and provide a local upstream
  source checkout plus compatible config and checkpoint files.
- Pin the upstream source and exact checkpoint revision in future benchmark
  records.
- Resampling and channel conversion remain explicit caller responsibilities.
- A separate speech-generation model is required to convert text into
  WavTokenizer codes for TTS; YarnGPT2 is connected by ADR 0005.
- Do not install the upstream full requirements file into the lab environment;
  it pins older versions than the lab's current PyTorch runtime.
