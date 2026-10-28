# Repository Agent Guidance

## Project focus

- The current active project is the local speech and conversation demo in
  `voice-lab/`.
- Keep speech-to-text and text-to-speech in the local model path. Do not add
  hosted or metered speech APIs to the product path.
- Read `voice-lab/README.md` and `voice-lab/licences.md` before changing model
  setup, assets, or licensing behavior.

## Running the voice demo

- Run the web app from `voice-lab/` with `uv run python scripts/web_demo.py`.
- The supported browser origin is `http://127.0.0.1:8765/` while that server is
  running. Never ask the user to open `voice-lab/web/index.html` directly as a
  `file://` URL: its relative `/api/status` and `/api/turn/stream` requests
  cannot reach the FastAPI server and the UI reports “Failed to fetch.”
- If fetch fails, check that the server is running and that the browser URL
  starts with `http://127.0.0.1:8765/`, then check `/api/status` for model
  readiness.
- The web app defaults to Whisper Tiny and Kokoro for lower CPU latency. Bark
  and YarnGPT2 remain selectable, but can be slow on CPU; make performance
  claims only from measured timings on the target machine.

## Local model assets and privacy

- Model weights, Hugging Face caches, recordings, alignments, consent records,
  and generated speaker profiles belong in ignored local paths under
  `voice-lab/models/` or another private location. Never commit them.
- Before using Underdog Bark offline, run
  `uv run python scripts/download_underdog_assets.py` from `voice-lab/` while
  online. This caches the pinned Bark checkpoint and its Parakeet processor
  files; the app should use local assets for inference.
- YarnGPT2 voice profiles require documented permission. Keep the authorized
  local profiles private and do not expose upstream preset voices without
  appropriate rights review.

## Changes and documentation

- Keep root setup instructions in `README.md` and model-specific setup,
  troubleshooting, and performance caveats in `voice-lab/README.md`.
- When changing model initialization or cache requirements, update the setup
  script, readiness status, and both the user documentation and this file as
  needed so the supported local workflow stays clear.
- Keep runtime error messages specific to the failing stage (transcription,
  Ollama reply generation, or speech synthesis).
