# ADR 0003: GPL speech dependencies in the voice lab

- **Status:** Accepted for voice-lab use
- **Date:** 2026-10-26

## Context

The Kokoro ONNX runtime (`kokoro-onnx` 0.6.1) declares `phonemizer` and
`espeakng-loader` as dependencies. `phonemizer` is GPL-3.0-or-later and the
loader bundles eSpeak NG, which is GPL-3.0-or-later. AGENTS.md section 19
requires an ADR and explicit commercial-use confirmation for GPL components.

## Decision

The human requester explicitly approved commercial use of these GPL
dependencies in this lab on 2026-10-26. They may be used for the local Kokoro
comparison and synthetic demo. This is not approval to omit GPL notices,
corresponding source, or any other obligations that apply to a particular
distribution. Review the actual distribution model with counsel before
shipping an application or combined environment containing these components.

## Consequences

- Pin the dependency graph in `voice-lab/uv.lock` and record its licenses in
  `docs/decisions/licences.md`.
- Keep Kokoro research-only; its English voice is not evidence of Nigerian
  accent quality and does not establish production selection.
- Do not distribute the combined environment until its GPL compliance package
  and notices have been reviewed.
- The Apache-2.0 Misaki English G2P could be evaluated later to replace the GPL
  phonemizer path, but that alternative is not part of this decision.
