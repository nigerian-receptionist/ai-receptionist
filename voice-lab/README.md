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

The lab includes local Whisper STT, Kokoro TTS, and experimental YarnGPT2 TTS adapters, benchmark runners,
and round-trip and microphone demo scripts. Candidate status and license notes
are tracked in `licences.md`; blocked models cannot be loaded through the
registry.

The `speech`, `tts`, `codec`, `yarngpt2`, and `live` dependency groups are separated so you
can install only the parts needed. `uv.lock` pins the resolved versions. Model
files and the upstream WavTokenizer source checkout stay under ignored
`models/`.

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

## YarnGPT2 TTS generator and WavTokenizer codec

WavTokenizer is an audio codec, not a text-to-speech model. Its adapter only
encodes mono waveforms to discrete codes and decodes codes back to waveforms;
it does not generate speech from text. YarnGPT2 generates those codes from text,
then the adapter decodes them to 24 kHz audio. YarnGPT2 is experimental and
available for local evaluation only; its model card describes public-media
training sources and experimental use. Commercial adoption needs a separate
review of data provenance and speaker rights. The model card identifies the
weights as Apache-2.0; its visible current commit is `bf654c7`.

```sh
uv sync --group codec --group yarngpt2 --locked
git clone --depth 1 https://github.com/jishengpeng/WavTokenizer.git models/wavtokenizer/WavTokenizer
```

YarnGPT2's published inference example pairs the medium speech config
`wavtokenizer_mediumdata_frame75_3s_nq1_code4096_dim512_kmeans200_attn.yaml`
with the **large speech** checkpoint `wavtokenizer_large_speech_320_24k.ckpt`.
The similarly named medium checkpoint is not a drop-in replacement: speaker
profiles must be encoded with the same large checkpoint used for decoding.
Download that checkpoint and config from the official WavTokenizer repositories
into `models/wavtokenizer/`, then set `WAVTOKENIZER_ROOT`,
`WAVTOKENIZER_CONFIG_PATH`, and `WAVTOKENIZER_CHECKPOINT_PATH` (see
`.env.example`). Set the YarnGPT2 variables there as well. Its model weights
download from Hugging Face on first use unless `YARNGPT2_LOCAL_FILES_ONLY=true`.
They stay in the local Hugging Face cache. Set `YARNGPT2_REVISION` to a reviewed
immutable commit, `YARNGPT2_SPEAKERS_DIR` to a private folder of speaker profiles,
and `TTS_MODEL=tts_yarngpt2`. Each profile is a private JSON file named
`{voice_id}.json` and needs the upstream `text` and aligned `words` fields, plus
`voice_use_authorized: true` and a `consent_id` matching a written permission
record. `words` entries contain `word`, `duration`, and integer `codes` fields.
Create profiles only from the speaker's own recording or another voice with
documented permission for AI speech generation. Do not use upstream preset
profiles: their likeness rights are not cleared here. The profile directory is
ignored under `models/` and must not be committed.

To build a profile from a corrected WhisperX result and its matching mono 24 kHz
PCM16 WAV, save a private consent record containing the matching `consent_id`
and `voice_use_authorized: true`, then run:

```sh
python scripts/build_yarngpt2_profile.py \
  --audio models/yarngpt2/reference_24k.wav \
  --alignment outputs/Voice-ai-corrected.json \
  --voice-id my_consented_voice \
  --consent-id your-private-consent-id \
  --consent-record models/yarngpt2/consent-record.json
```

The script encodes the full reference once and slices the resulting code frames
by each corrected top-level `word_segments` time span. Keep the consent record,
alignment, WAV, and generated profile local and ignored. Review the transcript
and timings first; this process does not validate consent or correct alignment.

To synthesize one sentence or start the microphone echo demo, use your profile
ID as the voice:

```sh
python scripts/tts_smoke.py "Hello, how can I help you today?" --model tts_yarngpt2 --voice my_consented_voice --output /tmp/yarn.wav
TTS_MODEL=tts_yarngpt2 TTS_VOICE=my_consented_voice python scripts/echo_loop.py
```

Choose a speech generator each time you start an interactive microphone demo, or
select one directly with `--tts-model`:

```sh
python scripts/echo_loop.py --tts-model kokoro
python scripts/echo_loop.py --tts-model yarngpt2
```

Kokoro and YarnGPT2 run through the local adapters. “YangGPT” here refers to
this project's YarnGPT2 adapter. Underdog Bark is selectable as the separate
speech recognition model with `--stt-model underdog`.

The echo loop does not use an LLM. `llm_loop.py` is a separate optional demo.
YarnGPT2 runs on CPU here and can take many seconds per sentence. It generates
a full sentence before playback; its sentence chunking is emulated, not true
token streaming. For responsive conversations, use Kokoro. The upstream project is source-based and documents an older
requirements file; do not install that file wholesale into the voice-lab
environment because it pins different PyTorch versions. The adapter lazily
loads the source and records SHA-256 hashes for its local config and checkpoint.
Input audio must already be mono, float32, normalized to [-1, 1], and sampled at
24 kHz; resample explicitly before encoding.

```python
import torch

from voicelab.adapters.codec.wavtokenizer import WavTokenizerCodecAdapter

codec = WavTokenizerCodecAdapter.from_environment()
waveform = torch.zeros(24_000, dtype=torch.float32)  # replace with local audio
codes = codec.encode(waveform, sample_rate_hz=24_000)
reconstructed = codec.decode(codes)
```

Pin the codec model repository revision before benchmarking. The code and official
model cards identify WavTokenizer as MIT-licensed; see the
[license record](../docs/decisions/licences.md).

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

Underdog Bark 3.0 is an optional, local English speech-to-text model, not a
speech generator. Install its runtime with `uv sync --group speech --group
live --group underdog --locked`, then start either microphone demo with
`--stt-model underdog` to use Bark instead of Whisper, for example:
`python scripts/echo_loop.py --tts-model kokoro --stt-model underdog`. The model
downloads from Hugging Face on first use; set
`UNDERDOG_BARK_LOCAL_FILES_ONLY=true` to require a pre-cached copy. Bark does
not provide word timings or language support beyond English. Its CC-BY-4.0
attribution is recorded in [`licences.md`](licences.md).

## Talk to the demo

Use `llm_loop.py` for a spoken conversation: it listens through the microphone,
transcribes each turn with Bark, sends the text to the local Ollama model, and
speaks the reply with Kokoro. On Ubuntu, install Ollama from its official
installer and pull the model used by the demo:

```sh
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:3b
ollama list
```

The installer needs your sudo password. If Ollama is not running as a service,
start `ollama serve` in a separate terminal and leave it running. Then, from
`voice-lab/`, install the Python groups, download Kokoro's local voice files,
and start the demo:

```sh
uv sync --group speech --group tts --group live --group underdog --locked
uv run python scripts/download_kokoro_assets.py
export KOKORO_MODEL_PATH=models/kokoro/kokoro-v1.0.onnx
export KOKORO_VOICES_PATH=models/kokoro/voices-v1.0.bin
uv run python scripts/llm_loop.py --stt-model underdog --tts-model kokoro
```

The code defaults to `ollama/qwen2.5:3b` at `http://localhost:11434`; these are
the Ollama settings in `.env.example`. The first Bark run
downloads its model weights from Hugging Face. To speak replies with YarnGPT2
instead, use `--tts-model yarngpt2` and configure the consented local voice
profile described above. Press Ctrl-C to end the session.

For the browser interface, install the `web` group and run the local server:

```sh
uv sync --group speech --group tts --group live --group underdog --group web --locked
uv run python scripts/web_demo.py
```

If you have a private `.env` in `voice-lab/`, the launcher reads its
`KEY=value` settings automatically. Open
[http://127.0.0.1:8765](http://127.0.0.1:8765). Allow microphone access,
choose Bark or Whisper for listening and Kokoro or an authorized YarnGPT2
profile for the speaking voice, then tap **Start talking** and tap **Finish and
send** when you are done, or pause for 1.5 seconds to send automatically. The
assistant text and audio stream sentence by sentence as Ollama generates them,
so playback begins before the full reply is complete. The page and model API bind to localhost; the browser
transmits audio only to this local server. Ollama must be running with the
configured model installed. Whisper Tiny is the fast CPU option; Whisper Small
can be selected when accuracy matters more than response time. Replies play
automatically and keep a **Hear reply** button in case the browser blocks audio.

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
