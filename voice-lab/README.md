# Voice lab

Offline experiments for Nigerian speech-to-text and text-to-speech. Speech
models must run on our own hardware or rented GPUs; hosted or metered speech
APIs are not allowed in the product path.

## Setup

Requires Python 3.12, `uv`, `ffmpeg`, and `pre-commit`.

```sh
cd voice-lab
uv sync --all-groups --locked
cd ..
pre-commit install
```

The lab includes local Whisper STT and Kokoro TTS adapters, benchmark runners,
and round-trip and microphone demo scripts. Candidate status and license notes
are tracked in `licences.md`; blocked models cannot be loaded through the
registry.

The `speech`, `tts`, and `live` dependency groups are separated so you can
install only the parts needed. `uv.lock` pins the resolved versions. The exact
Kokoro ONNX model files are downloaded separately and stay under ignored
`models/kokoro/`.

## Audio data and privacy

Keep source audio and generated clips outside Git, in a private location. Track
only consented, pseudonymous manifests under `data/manifests/`. Never include
real names, raw recordings, model weights, credentials, or tenant data in this
repository. Do not tune against the `test` split.

## Phone audio preparation

```sh
python scripts/make_phone_audio.py input.wav --output-dir /tmp/phone-audio
```

The command writes an 8 kHz mono G.711 mu-law WAV and a 16 kHz mono PCM WAV
resampled from that phone simulation. `ffmpeg` must be installed separately.

## Local model setup

```sh
python scripts/download_kokoro_assets.py
```

Set `KOKORO_MODEL_PATH` and `KOKORO_VOICES_PATH` to the downloaded files (or
copy `.env.example` to a private `.env`). Models stay local; blocked candidates
are refused by `model_registry.py`.

## Commands

Run from `voice-lab/`:

```sh
python scripts/stt_smoke.py --help
python scripts/tts_smoke.py --help
python scripts/bench_stt.py --help
python scripts/bench_tts.py --help
python scripts/roundtrip.py --help
python scripts/echo_loop.py --help
python scripts/llm_loop.py --help
python scripts/listening_sheet.py --help
```

The microphone demos need an audio input/output device. The LLM demo defaults
to a local LiteLLM/Ollama endpoint. Audio is held in memory and temporary WAV
files are deleted; only redacted timing logs are written. Use headphones to
reduce speaker-to-microphone echo.

STT benchmarks require a consented manifest with a `consent_id` for each clip,
hand-corrected reference text, and private audio named `{clip_id}.wav`. They
run on `dev` by default, report clean and phone-simulated audio separately,
perform one warm-up plus at least 20 timings, and write raw outputs under the
ignored `results/raw/` directory. Use `scripts/report.py` to create a tracked
aggregate Markdown table. Never commit transcripts, raw audio, or weights.

Run the short synthetic TTS demo to create a local spoken exchange:

```sh
python scripts/record_spoken_demo.py --output results/raw/spoken_demo.wav
```

This generated comparison voice is English-only and does not establish
Nigerian-accent quality. It does not record microphone audio. No spoken demo
artifact is checked into Git.

## Text normalization

The pure functions in `src/voicelab/normalise.py` prepare common Nigerian
currency amounts, phone numbers, acronyms, dates and times for speech. Yoruba
and Igbo diacritics are preserved. Tenant-specific names and pronunciation
lexicons belong in a later adapter/configuration layer; this module does not
persist or transmit input text.
