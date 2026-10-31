# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot and similar) and human contributors working in this repository. Read this file fully before changing anything.

**Rule priority:** (1) safety and compliance rules in section 9, (2) the speech-stack policy in section 5, (3) the rest of this file, (4) the task you were given. If a task conflicts with 1 or 2, stop and explain. If nested `AGENTS.md` files exist in subdirectories (for example `backend/AGENTS.md`), the closest one wins for details, but never for sections 5 and 9.

---

## 1. Project summary

A multi-tenant platform for Nigerian organisations (lenders, companies, churches) that deploys AI agents to **call, message (WhatsApp, SMS, web chat) and survey** contacts.

- Agents follow tracked, versioned **scripts** and speak with natural **Nigerian voices** with controllable emotion (warm, empathetic, upbeat, calm-firm, apologetic, reverent).
- Agents take **actions during live conversations** through tools (book a meeting, write a CRM record, alert a team channel, call a tenant API, send a payment link).
- Each contact has **one memory** shared across calls and channels (same brain, same memory).
- Every interaction (outbound, inbound, voice, web, WhatsApp, SMS) appears in the **call logs hub** with full transcript, audio, extracted variables and per-turn decision data.
- A **testbed** turns real conversations (after redaction) into regression tests for prompt, script and model iteration.
- Everything must work for Nigerian conditions: accents, Pidgin, Yoruba, Igbo, Hausa, 8 kHz phone audio, weak networks, naira, +234 numbers.

Source of truth for scope: `docs/prd/` (product requirements) and `docs/infrastructure/` (build plan). If code and docs disagree, stop and ask which is right.

---

## 2. Current focus and milestones

**Current milestone: M1, the voice lab.** Prove speech-to-text and text-to-speech using **free and open-source models only** on Nigerian phone-quality audio, then run a live microphone loop. Work only on the current milestone unless the task explicitly says otherwise. Do not scaffold billing, Kubernetes, multi-region, SSO or voice cloning.

| Milestone | Scope | Exit criteria |
|---|---|---|
| M0 | Repo, CI, tooling, decision records | CI green, pre-commit secret scan active, ADR 0001 merged |
| **M1** | **`voice-lab/`: STT and TTS benchmarks, round-trip test, echo loop, LLM in the loop** | Benchmark tables committed, ADR 0002 (chosen models), recorded demo of a spoken exchange |
| M2 | Backend skeleton (FastAPI, Postgres, Valkey, tenancy) | Health endpoint, migrations, RLS leak test, CI green |
| M3 | Frontend skeleton (Next.js dashboard) | Contacts, agents and call-log list pages on real API data |
| M4 | First real agent (LiveKit Agents or Pipecat) | Browser test call; transcript, audio and per-turn timings stored and visible in the log page |
| M5 | SIP trunk, inbound and outbound phone calls | Calls succeed on MTN, Airtel, Glo, 9mobile; fraud limits tested |
| M6 | WhatsApp, tools, testbed, pilot | Supervised pilot with 3 businesses |

Update this table when a milestone completes.

---

## 3. Repository layout

If a directory does not exist yet, create it only when its milestone starts.

```
/
  AGENTS.md                    this file
  README.md                    setup overview for humans
  .env.example                 fake values only, every variable documented
  .gitignore
  .pre-commit-config.yaml      gitleaks, ruff, formatting hooks
  docker-compose.yml           local Postgres (pgvector) and Valkey
  backend/
    pyproject.toml
    app/
      main.py                  FastAPI app factory
      core/                    config, logging, security, errors, time, ids
      api/v1/                  routers (one file per resource)
      domain/                  business logic, no framework imports
      adapters/                interfaces + vendor implementations
        stt/ tts/ llm/ telephony/ whatsapp/ sms/ payments/ calendar/ crm/
      db/                      models, session, migrations (alembic/)
      workers/                 Temporal workers, post-call pipeline
      policy/                  compliance gate rules (OPA bundles or Python rules)
      tools/                   tool definitions, gateway, connectors
      memory/                  memory extraction, validation, retrieval
      observability/           tracing, metrics, event emitters
    tests/
      unit/ integration/ compliance/ leak/ golden/
  frontend/
    package.json
    src/
      app/                     Next.js routes
      components/              shared UI
      features/                feature folders (contacts, agents, call-logs, testbed)
      lib/                     api client (generated), utils
    tests/
  voice-lab/                   STT and TTS experiments and benchmarks (not production code)
    pyproject.toml
    README.md
    configs/                   models.yaml, benchmark.yaml
    src/voicelab/              adapters, audio, metrics, normalise, timing
    scripts/                   runnable entry points (see section 6)
    data/                      GITIGNORED audio; manifests are tracked
    results/                   summary CSVs tracked, raw outputs ignored
    tests/
  infra/                       OpenTofu, Ansible, compose overrides, CI helpers
  docs/
    prd/
    infrastructure/
    decisions/                 ADRs: 0001-stack.md, 0002-speech-models.md ...
    runbooks/
```

---

## 4. Technology decisions

### 4.1 Decided

| Layer | Choice |
|---|---|
| Backend | Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2, Alembic, pytest, ruff, mypy |
| Data | PostgreSQL (pgvector, row-level security), Valkey |
| Workflows | Temporal (from M5; not needed in M1 to M4) |
| Frontend | Next.js, TypeScript (strict), Tailwind, shadcn/ui, TanStack Query, React Hook Form, Zod |
| Tooling | `uv` (Python), `pnpm` (Node), Docker Compose, GitHub Actions, Gitleaks |
| **Speech (STT and TTS)** | **Free or open-source only. See section 5.** |
| Voice runtime (from M4) | LiveKit SIP with LiveKit Agents, or Pipecat. Decide by ADR in M4 |
| LLM gateway | LiteLLM in front of any model provider |

### 4.2 LLM during development
Speech must be open source. The language model may be a hosted API during development, but keep it behind LiteLLM so it can be swapped. For a fully free local setup in the voice lab, run a small open model (for example a Qwen or Llama instruct model through Ollama or vLLM). Record which model each experiment used. Never hard-code a provider.

### 4.3 Not allowed without an ADR
Adding a framework, database, queue, vendor SDK or model family not listed here. Write the ADR first (section 18).

---

## 5. Speech stack policy: free and open source only

**This is a hard rule.**

1. **Allowed for STT and TTS:** open-source models and libraries that run on our own hardware or rented GPUs, under licences that permit our intended use, plus free tools used offline (ffmpeg, sox).
2. **Forbidden in the product path and in any default config:** paid or metered speech APIs and services, including hosted STT or TTS from cloud vendors, ElevenLabs-style voice services, Deepgram-style APIs, and OpenAI speech endpoints. Do not add their SDKs, keys or adapters.
3. **Free tiers are not "free":** a hosted service with a free tier is still forbidden in the product path because it creates lock-in, data egress and cost surprises.
4. **Exception:** a hosted service may be used as a clearly labelled **reference** in a benchmark only if the human explicitly approves it in the task, the data sent is synthetic or consented and redacted, and no code from it ships.
5. **Licence must be checked** for every model weight and library before use (section 19). Open-source code does not imply the weights are free for commercial use.
6. **Data stays on our infrastructure.** No call audio or transcripts are sent to third-party speech services.

### 5.1 STT candidates (benchmark all, adopt by ADR)

| ID | Model and runtime | Licence (verify before use) | Role | Notes |
|---|---|---|---|---|
| `stt_fw_turbo` | faster-whisper with Whisper large-v3-turbo | MIT (code and weights) | **Baseline** for English, Pidgin, code-switching | Confirm the installed faster-whisper version supports `large-v3-turbo`; otherwise use `large-v3` |
| `stt_fw_large` | faster-whisper with Whisper large-v3 | MIT | Accuracy ceiling for comparison | Slower |
| `stt_fw_small` | faster-whisper with Whisper small | MIT | CPU and low-cost fallback | Lower accuracy |
| `stt_natlas_*` | N-ATLaS ASR models (Whisper Small based: Yoruba, Hausa, Igbo, Nigerian-accented English) | Gated on Hugging Face. Reported terms include attribution and a cap on active end users | **Benchmark and research reference only** until the licence is confirmed | Accept terms on each model page; read the licence |
| `stt_community_multi` | Community Whisper fine-tunes for Yoruba, Hausa, Igbo (for example `yusasif/whisper-small-multilingual`) | Apache-2.0 reported; verify per model | Benchmark candidate | Quality unverified |
| `stt_parakeet` | NVIDIA Parakeet via NeMo or sherpa-onnx | CC-BY-4.0 reported; verify | Streaming English candidate | English-focused |
| `stt_sherpa_stream` | sherpa-onnx streaming models | Apache-2.0 | Low-latency streaming candidate | Check available Nigerian-relevant models |
| `stt_vosk` | Vosk small models | Apache-2.0 | CPU-only emergency fallback | Lower accuracy |
| `stt_ft_own` | Our own Whisper fine-tune (LoRA) on consented Nigerian phone audio | MIT base + our data | **Likely production path** | Needs the benchmark and a data plan first |

### 5.2 TTS candidates (benchmark all, adopt by ADR)

| ID | Model | Licence (verify before use) | Role | Notes |
|---|---|---|---|---|
| `tts_yarngpt2` | YarnGPT2 (SmolLM2-360M based, WavTokenizer, 24 kHz output) | Apache-2.0 per model card | **Baseline** for Nigerian accent; English, Yoruba, Igbo, Hausa; named voices (for example idera, chinenye, jude, zainab) | Labelled experimental; trained on public Nigerian media, so legal review before commercial use. Generates a whole utterance at a time: chunk by sentence |
| `tts_orpheus` | Orpheus-style expressive TTS | Apache-2.0 reported; the base model licence may also apply | Emotion tags, streaming | English-centric; verify base licence |
| `tts_chatterbox` | Chatterbox | MIT | Emotion intensity control | Voice cloning needs verified consent; may embed an audio watermark, verify |
| `tts_kokoro` | Kokoro-82M | Apache-2.0 | Small, fast, CPU-friendly | Limited accents and emotion |
| `tts_piper` | Piper voices | Differs by version (older MIT, newer repo GPL); ask first | Emergency CPU fallback | Less natural |
| `tts_ft_own` | Fine-tune of the chosen base on **licensed voice-talent recordings** | Depends on base plus our licences | **Likely production voice** | Needs signed voice licences |

Avoid model weights under non-commercial licences (some XTTS and F5-TTS weights, for example) in anything that could ship.

### 5.3 Selection rules
- No model is adopted unless it **beats the `stt_fw_turbo` baseline** (STT) or the **`tts_yarngpt2` baseline** (TTS) on the dev set for the target language, or there is a documented reason (licence, latency, cost).
- Provisional gates (revise after the first baseline run; record revisions in the ADR):
  - STT: real-time factor below 0.5 on the target GPU for batch; word error rate reported per language, per network and for clean versus 8 kHz audio.
  - TTS: time to first audio per short sentence measured and reported (target under about 500 ms on the target GPU); automated round-trip word error rate reported; listener panel mean at or above 4 out of 5 for naturalness before any voice is used in a pilot.
- Report **median and 95th percentile** for latency, never only the mean.

### 5.4 Adapter interfaces (all speech code goes through these)

Core code imports these protocols, never a model library directly. Put implementations in `backend/app/adapters/stt/` and `tts/` (and mirror in `voice-lab/src/voicelab/` until M2).

```python
from dataclasses import dataclass
from typing import AsyncIterator, Literal, Protocol

@dataclass(frozen=True)
class WordTiming:
    text: str
    start_s: float
    end_s: float
    confidence: float | None

@dataclass(frozen=True)
class SttResult:
    text: str
    language: str                 # en-NG, pcm, yo, ig, ha
    confidence: float | None
    words: list[WordTiming]
    audio_s: float
    latency_s: float
    model_id: str                 # for example "stt_fw_turbo@large-v3-turbo"

@dataclass(frozen=True)
class SttEvent:
    kind: Literal["partial", "final"]
    result: SttResult

class SpeechToText(Protocol):
    model_id: str
    def transcribe_file(self, path: str, *, language: str | None = None,
                        hints: list[str] | None = None) -> SttResult: ...
    def transcribe_stream(self, frames: AsyncIterator[bytes], *, sample_rate: int = 16000,
                          language: str | None = None,
                          hints: list[str] | None = None) -> AsyncIterator[SttEvent]: ...

@dataclass(frozen=True)
class VoiceInfo:
    voice_id: str
    language: str
    gender: str
    tones: list[str]              # supported tones

@dataclass(frozen=True)
class AudioChunk:
    pcm_s16le: bytes
    sample_rate: int
    is_first: bool
    is_last: bool

@dataclass(frozen=True)
class TtsResult:
    pcm_s16le: bytes
    sample_rate: int
    duration_s: float
    time_to_first_audio_s: float
    total_latency_s: float
    voice_id: str
    model_id: str
    text_spoken: str              # after normalisation

class TextToSpeech(Protocol):
    model_id: str
    def voices(self) -> list[VoiceInfo]: ...
    def synthesize(self, text: str, *, voice_id: str, language: str,
                   tone: str = "neutral", speed: float = 1.0) -> TtsResult: ...
    def synthesize_stream(self, text: str, *, voice_id: str, language: str,
                          tone: str = "neutral", speed: float = 1.0) -> AsyncIterator[AudioChunk]: ...
```

Rules for implementations:
- Implementations load models **once** and keep them warm; never load inside a request or call path.
- Device and precision come from config (`STT_DEVICE`, `STT_COMPUTE_TYPE`), never hard-coded.
- Always return timing fields. A missing timing field is a bug.
- If a model cannot truly stream, `*_stream` must emulate streaming by chunking, and the docstring must say so.
- Models that need gated access read `HF_TOKEN` from the environment; never from a file in the repo.

### 5.5 Audio standards

| Item | Standard |
|---|---|
| Internal processing | PCM signed 16-bit little-endian, mono |
| STT input rate | 16 kHz |
| Phone leg (PSTN) | 8 kHz, G.711 mu-law or A-law as the carrier requires |
| TTS native output | Model dependent (YarnGPT2: 24 kHz); resample explicitly, never implicitly |
| Resampling | High-quality low-pass resample (sox or soxr, or ffmpeg with a proper filter) |
| Stored recordings | Stereo, caller on one channel and agent on the other, lossless (FLAC) or Opus at a fixed bitrate; record the format in metadata |
| Loudness | Keep voices and pre-rendered blocks at a consistent level; peak-limit to avoid clipping; remove DC offset |
| File naming | `{clip_id}.wav` for dataset audio; `{run_id}/{clip_id}.{model_id}.wav` for generated audio |

Telephone-band simulation (used to test STT and TTS on realistic audio):

```
ffmpeg -i in.wav -ar 8000 -ac 1 -c:a pcm_mulaw phone_mulaw.wav
ffmpeg -i phone_mulaw.wav -ar 16000 -ac 1 phone_16k.wav
```

Also test with added noise and with codec artefacts. Always report results for clean audio and for 8 kHz audio separately.

### 5.6 Text normalisation before TTS (Nigerian examples, all must have tests)

| Input | Spoken form |
|---|---|
| `N45,000`, `NGN 45,000`, `₦45,000` | forty-five thousand naira |
| `N1.5m`, `N2.3bn` | one point five million naira, two point three billion naira |
| `28/10`, `28th Oct`, `Oct 28` | the twenty-eighth of October |
| `2:30pm`, `14:30` | half past two in the afternoon, two thirty p m |
| `0803 123 4567`, `+234 803 123 4567` | digit groups: zero eight zero three, one two three, four five six seven |
| `ending in 4421` | ending in four, four, two, one |
| `BVN`, `NIN`, `POS`, `NUBAN` | letters spelled or expanded per config |
| URLs and emails | never read aloud; the agent offers to send by WhatsApp or SMS |
| Emoji, markdown, bullet points | removed |
| Yoruba and Igbo diacritics | preserved exactly through the pipeline |
| Names, places, brands | per-tenant pronunciation lexicon with phonetic overrides |

Implement as pure functions in `normalise.py` with table-driven tests. Do not use a normaliser library whose licence is unclear (some are LGPL); prefer own rules and permissive libraries.

### 5.7 Pre-rendered audio blocks

Approved fixed phrases are synthesised once and cached. They give exact wording, zero synthesis latency and proof of delivery.

```yaml
# configs/blocks.yaml (illustrative)
blocks:
  - id: disclose_ai
    version: 2
    language: en-NG
    text: "Hello, good afternoon. This is an AI assistant calling on behalf of {org_name}."
  - id: recording_notice
    version: 1
    language: en-NG
    text: "This call is recorded for improvement purposes."
```

- Cache key: hash of `(text, language, voice_id, model_id, model_revision, speed, tone)`.
- Blocks with tenant variables are rendered at **agent publish time**, not at call time.
- Re-render automatically when text, voice or model changes.
- The runtime logs the **block id, version and hash** when a block plays. That log entry is the proof that the recording notice was delivered.
- The recording notice wording is exactly: **"This call is recorded for improvement purposes."** Translations are approved separately per language.

---

## 6. Voice-lab specification (Milestone 1)

### 6.1 Setup
```
cd voice-lab
uv init
uv add faster-whisper jiwer soundfile torchaudio transformers huggingface_hub \
       sounddevice silero-vad numpy pandas pyyaml rich
hf auth login        # needed only for gated models
```
Target Python 3.12. Pin versions in `uv.lock`. Record GPU model, driver, CUDA, Python and package versions in every results file.

### 6.2 Scripts to build (each is a CLI with `--help`)

| Script | Purpose | Output |
|---|---|---|
| `stt_smoke.py` | Transcribe one file with one model | Text and timings to stdout |
| `tts_smoke.py` | Synthesise one sentence with one model and voice | WAV file and timings |
| `make_phone_audio.py` | Convert audio to 8 kHz mu-law and back to 16 kHz; optional noise | WAV files |
| `roundtrip.py` | TTS then phone simulation then STT; compute word error rate | CSV row per sentence |
| `bench_stt.py` | Run models over a dataset split | `results/stt_{run_id}.csv` and a summary |
| `bench_tts.py` | Synthesise a sentence set for each model and voice, measure timings, run round-trip WER | `results/tts_{run_id}.csv`, WAVs |
| `listening_sheet.py` | Build a rating sheet (CSV or form) for human listeners | Sheet with blinded clip names |
| `echo_loop.py` | Microphone, VAD, STT, TTS, speaker; log timings | Console and `results/echo_{run_id}.jsonl` |
| `llm_loop.py` | Echo loop with an LLM in the middle (via LiteLLM) | Console and JSONL |
| `report.py` | Combine results into markdown tables for the ADR | `docs/decisions/` snippet |
| `compare_hints.py` | Compare Whisper with no hints, prompt, hotwords, and both | `results/hints_{run_id}.csv` and summary |
| `prepare_finetune_data.py` | Validate consent and speaker splits, convert to 16 kHz, add phone-line copies, write JSONL | `train.jsonl`, `dev.jsonl`, `test.jsonl`, `stats.json` |
| `finetune_whisper.py` | LoRA fine-tuning of Whisper (`--dry-run` validates data only) | Adapter, `train_summary.json` |
| `merge_and_convert.py` | Merge the LoRA adapter and convert to CTranslate2 for faster-whisper | Converted model directory |

### 6.3 Dataset manifest (tracked; audio is not)

`data/manifests/{dataset}.csv` columns:

| Column | Meaning |
|---|---|
| `clip_id` | Unique ID |
| `speaker_id` | Pseudonymous ID, never a real name |
| `language` | `en-NG`, `pcm`, `yo`, `ig`, `ha` |
| `accent_region` | For example `lagos`, `kano`, `enugu`, `port_harcourt`, `ibadan` |
| `channel` | `phone_call`, `voice_note`, `studio` |
| `network` | `mtn`, `airtel`, `glo`, `9mobile`, `none` |
| `sample_rate_hz`, `duration_s` | Audio facts |
| `scenario` | `lender_reminder`, `church_followup`, `booking`, `survey`, `other` |
| `reference_text` | Hand-corrected transcript |
| `contains_numbers`, `contains_names`, `contains_pidgin` | Booleans for slicing |
| `consent_id` | Link to the signed consent record |
| `split` | `train`, `dev` or `test` (train only for fine-tuning; never tune on `test`) |
| `recorded_at` | UTC timestamp |

Rules: written consent for every speaker; no real names in the repo; keep `test` split untouched until the final comparison; keep audio in a private bucket or DVC remote.

### 6.4 Metrics (define once in `metrics.py`)
- **WER** and **CER** with jiwer. Normalise reference and hypothesis identically (lowercase, strip punctuation, keep apostrophes and letters of all languages). For Yoruba and Igbo report **with and without tone marks**.
- **RTF** (real-time factor): processing time divided by audio duration.
- **TTFA** (time to first audio) for TTS, and total synthesis time per sentence.
- **Round-trip WER** for TTS: synthesise, apply phone simulation, transcribe with the baseline STT, compare to the input text.
- **Listener scores** (1 to 5): naturalness, accent fit, clarity, name and number pronunciation, emotional fit. Blind the model names. At least 5 Nigerian listeners; report mean and spread.
- Report median and 95th percentile for all latencies. Warm up each model before timing. Run each timing at least 20 times.

### 6.5 Results file schema (`results/stt_{run_id}.csv`)

`run_id, timestamp_utc, git_sha, model_id, model_revision, backend, device, compute_type, clip_id, language, channel, network, audio_s, latency_s, rtf, hypothesis, wer, cer, error`

Every run writes a `run_{run_id}.json` with hardware, versions, config and seeds so it can be reproduced.

### 6.6 Echo loop requirements
1. Capture microphone audio at 16 kHz with `sounddevice`.
2. Detect speech with Silero VAD; end the turn after a configurable silence (start at 600 ms).
3. Transcribe with the chosen STT adapter.
4. Optional: send the text to the LLM (LiteLLM) with a short system prompt that forces short spoken-style replies.
5. Normalise, split into sentences, synthesise sentence by sentence with the chosen TTS adapter, and play the first sentence while the next one generates.
6. Log per turn: `t_speech_end`, `t_stt_final`, `t_llm_first_token`, `t_llm_done`, `t_tts_first_audio`, `t_playout_start`. Use `time.perf_counter()` (monotonic).
7. Support barge-in: if the user speaks during playout, stop playback and keep only the spoken part in history.
8. Print a one-line summary per turn with the latency breakdown.

### 6.7 Fine-tuning plan (after the baseline, not before)
- STT: LoRA or full fine-tune of Whisper (small or turbo-size) with Hugging Face Transformers and PEFT on consented, hand-corrected Nigerian phone audio, with telephone-band augmentation (8 kHz resampling, codec simulation, noise). Keep train, dev and test speakers disjoint. Publish word error rate before and after on the untouched test split.
- TTS: fine-tune the chosen base on professionally recorded, licensed voice-talent audio (conversational lines, numbers, naira amounts, names, Pidgin phrases, the full emotion range). Hold signed licences covering training, synthesis and commercial use.
- Never train on audio or transcripts from tenants without their written opt-in.

### 6.8 Hardware and performance notes
- Prefer a GPU with 16 GB or more. For CPU-only runs use int8 compute and smaller models; record that the results are CPU results.
- Set `HF_HOME` or `MODEL_CACHE_DIR` to a persistent disk so models download once.
- Do not download models in CI. Mark GPU or model-heavy tests with `@pytest.mark.gpu` and skip them in CI.
- Keep models loaded between utterances; the first inference is always slower (warm-up).

---

## 7. Backend conventions (Python)

### 7.1 Structure and style
- `domain/` holds business logic with **no FastAPI, SQLAlchemy or vendor imports**. `api/` and `workers/` call `domain/`. `adapters/` implement interfaces defined in `domain/` or `adapters/*/base.py`.
- Type hints everywhere. `mypy` strict for `app/`. Pydantic v2 models at every boundary (HTTP, queues, adapters, config).
- `ruff` for lint and format. Line length 100. Imports sorted. No wildcard imports.
- `async` for I/O. Never block the event loop in request, call or message paths (no sync network calls, no heavy CPU work; offload to a worker or thread pool).
- Names: modules and functions `snake_case`, classes `PascalCase`, constants `UPPER_SNAKE`. Tables plural `snake_case`.
- Small functions. No dead code, no commented-out code. Comments explain why, not what.
- Raise typed domain errors (`ComplianceBlocked`, `ConsentMissing`, `ToolNotAllowed`, `TenantMismatch`). Map them to HTTP problems in one place. Never swallow exceptions around compliance, redaction or isolation code.

### 7.2 Configuration
- `pydantic-settings` reads environment variables. No config values in code. `.env.example` lists every variable with a fake value and a comment.
- Secrets come from the environment or the vault, never from files in the repo.

| Variable | Purpose |
|---|---|
| `APP_ENV` | `local`, `dev`, `staging`, `prod` |
| `LOG_LEVEL` | `INFO` default |
| `DEFAULT_TIMEZONE` | `Africa/Lagos` |
| `DATABASE_URL`, `VALKEY_URL` | Data stores |
| `HF_TOKEN` | Hugging Face token for gated models (never committed) |
| `HF_HOME`, `MODEL_CACHE_DIR` | Persistent model cache |
| `DATA_DIR` | Local datasets path (outside git) |
| `STT_BACKEND`, `STT_MODEL`, `STT_DEVICE`, `STT_COMPUTE_TYPE` | Speech-to-text selection, for example `faster_whisper`, `large-v3-turbo`, `cuda`, `float16` |
| `TTS_BACKEND`, `TTS_VOICE`, `TTS_DEVICE` | Text-to-speech selection, for example `yarngpt2`, `idera`, `cuda` |
| `LLM_MODEL`, `LITELLM_BASE_URL` | Language model access through LiteLLM |

### 7.3 Identity, time, money, phones, languages
- IDs: UUIDs (v7 preferred for index locality). Public references use prefixed IDs (`agt_`, `int_`, `con_`).
- Time: store UTC `timestamptz`. Evaluate calling windows and render times in `Africa/Lagos`. Use a holiday calendar table; never hard-code holidays.
- Money: integer minor units (kobo) plus ISO currency code (`NGN`). Never floats.
- Phone numbers: normalise to E.164 with the `phonenumbers` library. Accept `0803...`, `803...`, `+234803...`. Store the original input separately for audit.
- Languages: `en-NG`, `pcm` (Nigerian Pidgin), `yo`, `ig`, `ha`. Language codes are a Python `Literal` or enum defined once.

### 7.4 Reliability patterns
- **Idempotency:** every retryable operation (webhook, dial attempt, tool call, message send, payment link) carries an idempotency key. Store keys with results for a defined period.
- **Outbox:** emit webhooks and cross-service events from an outbox table written in the same transaction as the state change.
- **Timeouts and retries:** every outbound call has a timeout, bounded retries with jitter, and a circuit breaker for providers.
- **Graceful degradation:** if STT, TTS or the LLM fails, follow the fallback chain (section 10.6); never leave a caller in silence.

### 7.5 Logging
Structured JSON logs only. Required fields: `ts`, `level`, `msg`, `service`, `tenant_id`, `interaction_id`, `request_id`. Never log secrets, raw sensitive values, full transcripts or audio paths with personal names.

```json
{"ts":"2026-10-25T10:14:03.221Z","level":"INFO","service":"voice-agent","tenant_id":"...",
 "interaction_id":"int_01H...","msg":"turn.completed","turn":4,"stt_ms":212,"llm_first_token_ms":410,"tts_first_audio_ms":260}
```

---

## 8. Data model and API conventions

### 8.1 Database rules
- Every tenant table has `id`, `tenant_id uuid not null`, `created_at`, `updated_at`. Index `(tenant_id, created_at)` at minimum.
- **Row-level security on every tenant table**, with `FORCE ROW LEVEL SECURITY`. The application connects with a role that is **not** a superuser and **not** the table owner (owners bypass RLS unless forced). Set the tenant at the start of each transaction.

```sql
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contacts
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
-- application code, per transaction:
-- SET LOCAL app.tenant_id = '<uuid>';
```

- Partition high-volume tables (`turns`, `events`, `usage_events`) by month. Plan retention and purge jobs from the start.
- Migrations only through Alembic. Never edit an applied migration. Destructive changes need a two-step migration (add, backfill, switch, drop later).
- Soft delete where history matters, with a **hard-delete job** for data-subject deletion requests that also removes search index entries, caches, derived memory and embeddings.

### 8.2 Core tables (initial)

| Table | Key columns |
|---|---|
| `tenants` | name, plan, region, retention policy, settings |
| `users`, `memberships` | tenant_id, role (owner, admin, campaign_manager, qa_reviewer, agent, viewer) |
| `contacts` | phone_e164, language, preferred_channel, tags, custom fields, consent flags, opt_out_at |
| `consents` | contact_id, channel, evidence (source, wording version, timestamp) |
| `agents`, `agent_versions` | persona, voice_id, prompt_ref, script_ref, tools, turn-taking settings, status |
| `scripts`, `script_versions` | state machine JSON, mandatory blocks, approval status |
| `campaigns`, `attempts` | audience, schedule, pacing, status; per-attempt outcome and idempotency key |
| `interactions` | channel, direction, agent_version_id, script_version_id, status, end_reason, started_at, ended_at, cost |
| `turns` | interaction_id, seq, speaker, text, language, stt_confidence, timings, decision data (JSONB), interrupted |
| `recordings` | interaction_id, storage key, format, notice_block_id, notice_delivered_at |
| `variables` | interaction_id, name, typed value, confidence, evidence_turn_id, method, reviewed |
| `tool_calls` | interaction_id, turn_id, tool, arguments (masked), result, latency, status |
| `memory_items` | contact_id, category, content, sensitivity, confidence, source_interaction_id, expires_at |
| `knowledge_sources`, `kb_chunks` | tenant_id, source, text, embedding (pgvector), metadata |
| `escalations` | interaction_id, reason, assignee, status |
| `testbed_cases`, `testbed_runs` | source_interaction_id, redacted context, assertions, results |
| `audit_logs`, `usage_events`, `webhook_outbox` | append-only |

### 8.3 API conventions
- REST under `/v1`, JSON, OpenAPI generated and published. The frontend client is generated from it.
- Errors use RFC 9457 `application/problem+json` with a stable `type` code.
- Cursor pagination (`limit`, `cursor`), stable sort. No offset pagination on large tables.
- `Idempotency-Key` header on all POST requests that create or send something.
- Auth: OIDC bearer tokens for users; scoped API keys for integrations. Every route declares its required permission.
- Webhooks out: HMAC signature, timestamp, retries with backoff, replay endpoint.
- Webhooks in (WhatsApp, payments, carriers): verify signature, deduplicate by provider event ID, respond fast, process asynchronously.
- Rate limits per tenant and per API key, returned in headers.

---

## 9. Non-negotiable safety, privacy and compliance rules

These come from the PRD. Never weaken, bypass or "temporarily" disable them, including in tests, demos, feature flags or the voice lab. If a task conflicts, stop and say so.

### 9.1 Calls and recording
1. Every call plays the **AI disclosure** and then the recording notice, **"This call is recorded for improvement purposes."**, before any other content, in the contact's language, using pre-rendered approved blocks.
2. Recording state machine: `not_started` then `notice_playing` then `notice_confirmed` then `recording`. Audio is persisted **only** in the `recording` state. If the notice did not play, purge the audio, flag the interaction and alert the tenant's compliance reviewer.
3. If the contact objects to recording, stop recording, delete audio captured so far, and follow the tenant policy (continue unrecorded or transfer to a human). Save the objection on the contact.
4. The agent never claims to be human. It answers "are you a robot?" truthfully.
5. No imitation of a real named person (pastor, executive, celebrity). No voice cloning without verified written consent and an audit record. Synthetic voices are licensed and registered.
6. The **compliance gate** (code, policy engine) decides whether a contact may be contacted: consent for the channel, DND, opt-out, calling window (default 08:00 to 19:00 Africa/Lagos), frequency caps, tenant budget, campaign status and kill switches. Prompts never carry this logic alone.
7. An opt-out ("stop", "do not call me", local-language equivalents) takes effect immediately on every channel and within minutes in all queues.
8. Identity is confirmed before any personal or financial detail is shared. After a limited number of failed attempts, stop and escalate. For a wrong person, share nothing and end politely.

### 9.2 Sensitive information
9. The agent never asks for or accepts card numbers, PINs, OTPs, passwords, or full BVN or NIN. If a contact volunteers one, interrupt politely, do not repeat it, and redirect to a secure payment link or a human.
10. **Redact before storage:** transcripts, notes, variables, memory, logs, traces and analytics are redacted before they are written. Audio is the only place raw speech remains, with tighter access.

| Data | Detection |
|---|---|
| BVN, NIN | 11-digit numbers near identifying words, plus recognisers |
| Bank account (NUBAN) | 10-digit numbers, with context checks |
| Card number | 13 to 19 digits passing a Luhn check |
| Phone number | `+234` and local formats, via `phonenumbers` |
| Names, addresses, emails | Presidio recognisers plus custom Nigerian patterns |
| OTP and PIN | 4 to 8 digit codes after "code", "OTP", "PIN" in context |

11. Logs and the dashboard show masked values by default. Revealing raw text or audio requires a permission and writes an `audit_logs` entry. Exports are watermarked and audited.
12. Sensitive memory (health, religion, hardship, minors) is stored only with consent, tagged restricted, hidden from general roles, and never spoken aloud unprompted. Religious affiliation and health details are sensitive personal data under the NDPA.
13. If the contact seems to be a minor, end politely and flag.
14. Distress, self-harm language, threats, abuse allegations and legal threats trigger **immediate human escalation**. The agent does not counsel, diagnose or give legal, medical or financial advice.

### 9.3 Conduct rules by vertical
- **Lending:** no threats, shaming or pressure; no contacting third parties about a debt; no use of contact lists; mandatory lender identity and licence disclosure; clear dispute and complaint path; follow current FCCPC and CBN rules (verify with counsel).
- **Churches:** giving reminders are opt-in only and never pressured; pastoral concerns go to a human; religious data is restricted.
- **Companies:** respect marketing consent and DND for outbound messages.

### 9.4 Tenant isolation
15. Every table, cache key, storage path, vector query and search index entry is tenant-scoped. Row-level security is on for every tenant table.
16. Every new table, endpoint, cache and index needs an automated **cross-tenant leak test**.
17. An AI request contains one tenant's data only. No shared context, retrieval or memory between tenants.
18. Tenant data is never used to train or tune a shared model unless that tenant opted in, in writing. Default is off. Recordings and transcripts used for improvement stay inside the tenant after redaction.
19. Platform staff have no standing access to tenant data. Support access is tenant-approved, time-limited and logged.

### 9.5 Regulatory references (verify with Nigerian counsel; do not guess)
NDPA 2023 and NDPC guidance (consent, DPIA, DPO, data-subject rights, breach notification, cross-border transfer), FCCPC digital lending rules, CBN rules, NCC rules (DND, sender IDs, call conduct), WhatsApp Business policies. If a task needs a legal interpretation, flag it for a human.

---

## 10. Voice runtime rules (M4 onward)

### 10.1 Turn loop
1. Audio frames in, noise suppression, resample to the STT rate.
2. VAD (Silero) and turn detection decide when the caller finished.
3. STT (adapter) produces partial and final transcripts with confidence and language.
4. Context assembly: system prompt, script step, memory, retrieved knowledge, recent turns, variables so far.
5. LLM streams a response, possibly with tool calls.
6. Sentence chunker splits the text; the text normaliser (5.6) prepares each sentence.
7. TTS (adapter) streams audio per sentence; fixed phrases use pre-rendered blocks.
8. Audio out: resample, level, encode (G.711 on PSTN), play, and record exact playout timestamps.
9. Write the per-turn record (section 13.2).

### 10.2 Barge-in
When the caller speaks over the agent for at least the minimum words or duration: cancel the LLM stream, flush TTS buffers, stop playout, determine from playout timestamps what the caller actually heard, and **truncate the assistant message in history to that spoken portion**, marked `interrupted=true`. Without this the model believes it said things the caller never heard.

### 10.3 Default parameters (tune per agent, log the values used)

| Parameter | Default |
|---|---|
| Endpointing silence | 600 ms (300 to 400 ms for yes/no steps, 900 to 1200 ms for digits) |
| Minimum words to interrupt | 2 words or 300 ms of speech |
| Silence prompt, silence end | 8 s, then 20 s |
| Maximum call duration | Per agent (for example 480 s for reminders) |
| First-turn delay after answer | 300 to 500 ms |
| Voicemail detection window | First 3 to 5 s |
| Reply length cap | About 35 words unless the caller asks for detail |

### 10.4 Latency budget (end of caller speech to start of agent speech: target 1.0 to 1.5 s)
Endpointing 200 to 400 ms, streaming STT 150 to 300 ms, LLM first token 300 to 600 ms, TTS first audio 150 to 300 ms, network 100 to 200 ms. Measure each segment on every turn. A change that adds more than 100 ms to any segment needs a justification in the PR.

### 10.5 Prompts for speech
Short spoken sentences; one question at a time; no lists, markdown or URLs; numbers as words when ambiguous; filler phrase before slow tools ("Let me check that for you"); reply in the caller's language and mirror formality; never mock accents; hard rules at the top (disclosure, recording notice, no sensitive data requests, escalate on request).

### 10.6 Fallback chain
Primary STT or TTS fails, then backup open-source model, then pre-rendered "please hold" and handoff to a human or a callback. Alert on every fallback. Never go silent.

### 10.7 Special situations
Voicemail (detect, then approved short message or a WhatsApp), wrong person, caller asks for a human (warm transfer with a spoken summary), silence or noise (prompt, then offer a callback), abrupt hang-up (finalise the log).

---

## 11. Messaging runtime rules (WhatsApp, SMS, web chat)

- One conversation model for all channels. Channel adapters convert to and from a normalised message; only the response formatter knows channel formats.
- **Inbound pipeline:** webhook, signature check, deduplicate, normalise, per-contact lock, debounce bursts (2 to 4 s), build context and memory, run the turn, guardrails, send, track status (sent, delivered, read, failed), write the log.
- **WhatsApp:** official Cloud API only. Never use unofficial libraries that reverse-engineer WhatsApp Web (they breach Meta's terms and risk bans). Respect opt-in evidence, the 24-hour session window, template approval, and messaging limits and quality ratings (verify current Meta rules). Voice notes in: convert with ffmpeg, transcribe with the open-source STT, process as text. Voice notes out (optional): synthesise with the open-source TTS and send in the format WhatsApp requires.
- **Media:** OCR receipts and screenshots with open-source OCR (Tesseract, PaddleOCR, docTR). Payment proof is **unverified** until the payment gateway webhook confirms. Do not store ID or card images; redact and warn the contact.
- **SMS:** plain GSM-7 text is 160 characters per segment (153 when concatenated). Yoruba and Igbo diacritics force UCS-2, which drops to 70 (67 concatenated). Implement `sms_segments(text)` and fail template validation when a message exceeds the tenant's segment budget.
- **Web chat:** visible "AI assistant" label, consent line, WebSocket or SSE with reconnect and message replay by sequence number, handoff to the human inbox with transcript.
- **Design:** messages short (usually under 300 characters), one question at a time, buttons for common answers, confirm before actions, no emoji unless the persona allows.
- **Cross-channel:** a voice agent may send a payment link or receipt by WhatsApp mid-call using a tool; a WhatsApp conversation may offer a call. Memory and the timeline are shared.

---

## 12. Tools (agent actions during conversations)

A tool is a typed capability. Examples: schedule a meeting, create a CRM contact, send a team alert, call a tenant API, send a payment link, transfer a call.

### 12.1 Tool definition (illustrative)
```json
{
  "name": "book_appointment",
  "description": "Book a confirmed slot. Call only after the caller agreed to a specific slot.",
  "parameters": {"type": "object", "required": ["slot_start", "service_id"],
    "properties": {"slot_start": {"type": "string", "format": "date-time"},
                   "service_id": {"type": "string"}, "notes": {"type": "string", "maxLength": 200}}},
  "executor": {"type": "http", "connector": "calendar", "operation": "create_booking"},
  "risk": "write_reversible",
  "requires_confirmation": true,
  "allowed_steps": ["offer_slots", "confirm_booking"],
  "timeout_ms": 4000, "retries": 1, "idempotency": "contact_id+slot_start",
  "speak_while_waiting": "Let me lock that in for you.",
  "on_failure": "Offer to send the booking link on WhatsApp.",
  "rate_limit": {"per_call": 2, "per_contact_per_day": 3},
  "pii_policy": "log_masked"
}
```

### 12.2 Gateway steps (all tool calls, no exceptions)
1. Tool enabled for this tenant, agent version and **current script step** (allow-list).
2. Authorise (tenant, contact, identity check passed for sensitive tools).
3. Validate arguments against the JSON Schema; reject unknown fields.
4. Risk gate: read tools run; write tools need the confirmation step; irreversible tools (payments, deletions) need explicit confirmation and may need human approval.
5. Inject credentials from the vault; the model never sees them.
6. Execute with timeout, bounded retries, circuit breaker, idempotency key.
7. All outbound HTTP through the **egress proxy** with a domain allow-list; block private IP ranges (SSRF protection).
8. Trim and map the response to the fields the model needs.
9. Return to the model; log arguments (masked), result, latency, cost and status to `tool_calls`.
10. Emit events.

Controls: per-tool kill switch, per-tenant and per-call rate limits, daily spend caps, sandbox or dry-run mode with mock results, approval workflow before a new tool reaches production.

### 12.3 Tools in live calls
Filler speech before slow actions; soft timeout of about 3 to 5 s with a spoken fallback ("I'll confirm and message you"); async tools for non-blocking actions (CRM update, team alert); prefetch likely data at call start; never read raw error messages aloud.

### 12.4 Open-source-first integrations
Scheduling: Cal.com (self-hosted, AGPL, check fit) or a built-in scheduler with CalDAV. CRM: Twenty, EspoCRM, SuiteCRM, Odoo (connectors for Salesforce and HubSpot for tenants who use them). Team alerts: Mattermost, Zulip, Rocket.Chat, ntfy, Apprise (connector for Slack). Automation: Activepieces, Node-RED, n8n (source-available). Tool protocol: MCP SDKs. Egress: Smokescreen or Squid.

---

## 13. Call logs, events and per-turn data

### 13.1 Event envelope (every event, idempotent and ordered)
```json
{"event_id":"uuid","type":"turn.completed","version":1,"tenant_id":"uuid",
 "interaction_id":"int_...","seq":17,"occurred_at":"2026-10-25T10:14:03.221Z","payload":{}}
```
Writers consume the stream and update Postgres, object storage, analytics and the search index. A finaliser closes interactions that stop sending heartbeats and marks them incomplete.

### 13.2 Per-turn record (store in `turns`, decision data as JSONB)
```json
{
  "turn_id": "trn_...", "seq": 4, "speaker": "caller",
  "text": "...", "language": "en-NG", "stt_model_id": "stt_fw_turbo@large-v3-turbo",
  "stt_confidence": 0.91, "alt_hypotheses": ["..."],
  "endpoint_wait_ms": 640, "cut_off": false, "interrupted": false,
  "script_step_before": "collect_promise", "script_step_after": "confirm_promise",
  "prompt_version": "lender_reminder@14", "llm_model": "...",
  "retrieved_chunks": [{"id": "...", "score": 0.82, "source": "faq.pdf"}],
  "memory_items_used": ["mem_..."],
  "tools": [{"name": "log_promise_to_pay", "status": "ok", "latency_ms": 310}],
  "guardrails": [{"check": "grounding", "result": "pass"}],
  "tone": "empathetic", "spoken_text": "...", "tts_model_id": "tts_yarngpt2", "voice_id": "...",
  "timings_ms": {"endpointing": 640, "stt": 212, "retrieval": 40, "llm_first_token": 410,
                 "llm_total": 980, "tools": 310, "tts_first_audio": 260},
  "tokens": {"in": 1840, "out": 62}, "cost_ngn_minor": 0
}
```

### 13.3 Interaction-level data
Status, end reason, disposition, agent and script versions, numbers, carrier and SIP diagnostics (Call-ID, codec, response codes, jitter, packet loss, estimated MOS), recording and notice status, cost breakdown, summary, outcome, sentiment, QA score, flags, memory read and written.

### 13.4 Extracted variables
Defined per agent: name, description, type (string, number, boolean, enum, date, currency NGN, phone +234), validation, required step, extraction mode (in-call tool, post-call schema-constrained extraction, or both), confirmation rule. Each stored value keeps confidence, evidence turn and method. A correction creates a new value and keeps history.

### 13.5 Log hub requirements
List with filters on every field and transcript search; detail with transcript and synced audio, turn inspector with latency waterfall, variables, tools, diagnostics, memory, QA and comments, raw JSON; live monitor with listen-in, whisper, takeover and end-call (permissioned and audited); "add to testbed" and "share redacted clip" actions.

---

## 14. Frontend conventions

- Next.js (App Router), strict TypeScript, no `any` without a comment. Feature folders under `src/features/`; shared UI in `src/components/`.
- Data: TanStack Query with the generated API client. No hand-written request types. Forms: React Hook Form with Zod schemas mirrored from the API.
- State: server state in Query; small client state in Zustand; no global stores for server data.
- **Performance budget:** main routes under about 200 KB gzipped JavaScript; lazy-load charts, the script builder (React Flow) and the audio player (wavesurfer.js); virtualise long tables; paginate; skeleton loaders; autosave drafts; clear offline and reconnecting states; resumable large CSV uploads. Test on mid-range Android phones and throttled networks.
- **Security:** strict CSP, HttpOnly secure cookies, CSRF protection, no sensitive data in URLs or local storage, short-lived signed URLs for audio and exports. Permission checks are enforced on the server; hiding UI is cosmetic.
- **Accessibility:** WCAG 2.1 AA, keyboard navigation, labels, contrast, focus management.
- **i18n:** next-intl; strings externalised; support English first, Pidgin and others later; times in Africa/Lagos; naira formatting.
- **Testing:** Vitest for units, Playwright for end-to-end flows (login, import contacts, open a call log), Storybook for shared components, MSW for API mocks.
- **Never** render raw transcripts or audio without the masking and permission layer.

---

## 15. Testing requirements

### 15.1 Layers
- **Unit:** domain logic, normalisers, redactors, policy rules, SMS segment counter, metrics.
- **Integration:** real Postgres and Valkey (Testcontainers or Compose). **Do not mock the database for row-level security tests.**
- **Compliance suite** (`tests/compliance/`, must always pass):
  - recording notice delivered before audio is persisted; no notice means audio purged and a flag raised
  - AI disclosure present at call start
  - out-of-window attempt blocked; DND and opt-out honoured; frequency cap enforced
  - sensitive values redacted from transcripts, notes, memory, logs and traces
  - agent refuses to collect card numbers, PINs, OTPs, BVN or NIN
  - identity check required before sensitive tools or disclosures
- **Leak suite** (`tests/leak/`): for every tenant table, endpoint, cache, storage path and vector or search query, tenant A cannot read or influence tenant B.
- **Golden and testbed:** conversation cases per vertical and language (English, Pidgin, Yoruba, Igbo, Hausa) with deterministic assertions (tool called with arguments, variable captured, mandatory wording present, banned phrases absent, latency under limit) and judged rubrics. Repeat LLM-dependent cases several times and assert on pass rate.
- **Voice-lab:** benchmark scripts are reproducible and produce the CSV schema in 6.5.

### 15.2 Rules
- Mark model-heavy tests `@pytest.mark.gpu` or `@pytest.mark.slow`; CI skips them. No model downloads in CI.
- Use **synthetic data only** (fake names, numbers, transcripts, audio from TTS). No real customer data anywhere in the repo.
- Every bug fix includes a test that fails before the fix.
- Target at least 80% coverage on `domain/`, `policy/` and redaction code. Coverage is a floor, not a goal.

---

## 16. Git, CI and review

- Branch from `main`: `feat/`, `fix/`, `chore/`, `docs/`, `test/`. Conventional commits (`feat(voice-lab): add YarnGPT2 adapter`).
- Small pull requests. Required description: what changed, why, how tested, risks, follow-ups. Link the issue or milestone.
- CI jobs: lint, format check, type check, unit and integration tests, compliance and leak suites, secret scan (Gitleaks), dependency and licence scan, container scan, frontend build and tests.
- `main` is protected: pull request required, CI green, one review. Never force-push `main`. Never merge your own change without green CI. Agents open pull requests; humans merge.
- Pull request checklist (put in `.github/pull_request_template.md`): tests added, docs updated, `.env.example` updated, no secrets or data, licences checked, compliance and leak suites pass, ADR added if a decision changed.

---

## 17. Task playbooks

### 17.1 Add an STT model to the benchmark
1. Check its licence and any gating; record it in `docs/decisions/licences.md`.
2. Add an entry to `voice-lab/configs/models.yaml` (id, backend, revision, device, compute type).
3. Implement the adapter against `SpeechToText`; load once; return all timing fields.
4. Add a smoke test that runs on a 2-second synthetic clip (marked `gpu` if needed).
5. Run `bench_stt.py` on the dev split; commit the summary CSV; never touch the test split.
6. Add the row to the ADR comparison table.

### 17.2 Add a TTS model or voice
1. Licence check, plus consent and licence records for any voice talent.
2. Config entry and adapter against `TextToSpeech`, including `voices()` and tone support.
3. Verify normalisation and the pronunciation lexicon with the section 5.6 table.
4. Measure TTFA and total latency; run round-trip WER; generate a blinded listening sheet.
5. Add the voice to the catalogue with licence reference and status `draft`. Only approved voices can be attached to agents.
6. Pre-render the disclosure and recording-notice blocks for the voice and verify playback through an 8 kHz phone simulation.

### 17.3 Add a database table
1. Alembic migration with `tenant_id`, timestamps, indexes and the RLS policy (8.1).
2. SQLAlchemy model and Pydantic schemas.
3. Leak test proving tenant isolation; compliance test if it stores sensitive data.
4. Retention and deletion handling; update the hard-delete job.
5. Update the core tables list in this file if it is a core table.

### 17.4 Add an API endpoint
1. Router in `api/v1/`, permission declared, schemas defined, errors mapped.
2. Idempotency key if it creates or sends.
3. Tenant scoping tested; OpenAPI regenerated; frontend client regenerated.

### 17.5 Add a tool
1. Tool definition (12.1), connector adapter, sandbox account.
2. Contract tests with recorded fixtures; failure and timeout tests.
3. Egress allow-list entry; credentials in the vault; kill switch wired.
4. Tool description written for the model: when to call it, required inputs, what not to do.

### 17.6 Change a prompt or script
1. Edit the versioned prompt or script file; bump the version.
2. Add or update testbed cases that reproduce the issue.
3. Run targeted tests and the golden suite; compare pass rates.
4. Mandatory wording changes need compliance approval; canary before full rollout.

### 17.7 Add a language
1. Add the code to the language enum; add normalisation rules and a lexicon.
2. Benchmark STT and TTS for that language; add dataset rows.
3. Approve translations of the disclosure and recording notice.
4. Add golden cases and templates (check SMS encoding).

---

## 18. Documentation and decision records

- Update `README.md`, `.env.example`, runbooks and this file whenever behaviour, setup or decisions change.
- **ADR template** (`docs/decisions/NNNN-title.md`): Context, Options considered (with licence and cost), Decision, Consequences, Date, Status. Required for: frameworks, data model changes, model or vendor choices, licence exceptions.
- Required early ADRs: `0001-stack`, `0002-speech-models` (benchmark tables, chosen STT and TTS, fine-tuning plan), `0003-voice-runtime` (LiveKit Agents or Pipecat), `0004-licences`.
- Keep a `docs/decisions/licences.md` table: component, version, licence, commercial use allowed, notes, reviewer, date.

---

## 19. Dependencies and licences

| Class | Licences | Action |
|---|---|---|
| Allowed | MIT, BSD-2, BSD-3, Apache-2.0, ISC, MPL-2.0 | Use; record in `licences.md` |
| Ask first | LGPL, GPL, AGPL, SSPL, BSL, FSL, custom model licences (Llama-style), CC-BY (attribution), gated models | Open an ADR; confirm commercial use |
| Forbidden | Non-commercial licences (CC-BY-NC and similar), unknown or missing licences, models trained on data we cannot lawfully use | Do not add |

- Prefer OpenTofu over Terraform, OpenBao over Vault, Valkey over Redis, for licence reasons.
- AGPL components may run as separate services (for example Grafana, Cal.com) but must not be linked into our code without an ADR.
- Pin versions; commit lock files; prefer releases at least two weeks old; scan dependencies in CI.
- Model weights are dependencies: record repo, revision hash and licence.

---

## 20. Security

- Treat **everything a caller says or writes, and every ingested document, as untrusted** (prompt injection). The model cannot change policy, tools or data scopes; code enforces them.
- Verify webhook signatures; deduplicate events; least-privilege credentials, roles and tokens; rotate secrets.
- Encrypt in transit (TLS 1.2 or higher; SRTP where supported) and at rest (AES-256), with per-tenant keys for sensitive data.
- SIP: accept only allow-listed carrier IPs; no open relay; rate limit; **toll-fraud controls** (destination allow-list, concurrency and spend caps, alerts).
- Never run destructive commands (drop database, delete buckets, `rm -rf` on data, force-push) without explicit human confirmation.
- Report anything that looks like a secret leak or data exposure immediately. Do not hide it or quietly patch around it.
- Never paste real personal data, tokens or recordings into prompts, issues, logs or commits.

---

## 21. How agents should work in this repository

1. Read this file, then the relevant docs, then the code you will touch. Identify the current milestone (section 2).
2. State a short plan before large changes. Keep the diff scoped; no unrelated refactors.
3. **Do not invent** APIs, flags, model names, repo IDs, file formats or provider endpoints. Check the installed package, its documentation or the model card. If you cannot verify, say so in the PR.
4. Honour section 5: only free and open-source speech models and libraries. Never add a paid speech API or SDK.
5. Run the relevant commands (lint, type check, tests) and report exactly what you ran and the results. Do not claim something works if you did not run it. If you could not run something (for example no GPU), say that.
6. For ambiguous requirements, choose the safest reading, note the assumption, and ask only when the risk is high.
7. If a task would break a rule in section 9, stop and explain instead of proceeding.
8. Keep secrets, datasets, audio and model weights out of git. Use synthetic data for tests.
9. Update docs, `.env.example`, ADRs and this file when your change alters behaviour, setup or decisions.
10. For legal or compliance questions, flag them for a human and Nigerian counsel. Do not guess.
11. Prefer many small, reviewable commits over one large change.

---

## 22. Definition of done

- [ ] Code builds, lints, type-checks and tests pass for everything touched.
- [ ] Compliance and leak suites pass.
- [ ] New tenant data has `tenant_id`, RLS and a leak test.
- [ ] Sensitive values are redacted before storage, logging and tracing.
- [ ] Recording notice and AI disclosure behaviour unchanged or improved, and tested.
- [ ] Per-turn timings and decision data still recorded on voice and message paths.
- [ ] Only free or open-source speech components used; licences checked and recorded.
- [ ] No secrets, personal data, audio or model weights committed.
- [ ] Docs, `.env.example`, ADRs and this file updated where needed.
- [ ] PR description states what changed, how it was tested, what was not tested, and what remains.

---

## 23. Glossary

| Term | Meaning |
|---|---|
| Agent | A versioned configuration: persona, voice, prompt, script, tools, turn-taking settings |
| Script | A versioned state machine of steps with mandatory wording and transitions |
| Interaction | One call, chat or SMS thread, logged with transcript, audio, variables and decisions |
| Turn | One speaker's contribution, with timing and decision data |
| Compliance gate | Code that decides whether a contact may be contacted now |
| Tool gateway | Service that validates, authorises, runs and logs agent tool calls |
| Testbed | Datasets and runners that replay and simulate conversations for regression tests |
| Pre-rendered block | Cached approved audio, such as the AI disclosure and recording notice |
| Barge-in | The caller interrupting the agent while it speaks |
| WER, CER | Word and character error rate |
| RTF | Real-time factor: processing time divided by audio duration |
| TTFA | Time to first audio from TTS |
| VAD | Voice activity detection |
| RLS | PostgreSQL row-level security |
| ADR | Architecture decision record |
| Contact | The person being called or messaged |
| Tenant | A customer organisation using the platform |
| NDPA, NDPC | Nigeria Data Protection Act 2023 and the Nigeria Data Protection Commission |
| FCCPC, NCC, CBN | Consumer protection, telecom and central bank regulators |
| BVN, NIN, NUBAN | Bank verification number, national identification number, Nigerian bank account number |

---

## 24. Open questions (resolve by ADR, then remove from this list)

1. Which STT model family wins on Nigerian phone audio, and does N-ATLaS's licence permit commercial deployment?
2. Is YarnGPT2 cleared for commercial use, and which voice engine becomes the production base for the licensed fine-tune?
3. LiveKit Agents or Pipecat for the voice runtime?
4. Hosting region and data-residency stance for health, lending and faith data.
5. Which SIP carriers give the best quality on MTN, Airtel, Glo and 9mobile?
6. Collections: allowed at launch, or reminders only until compliance controls are proven?
7. Which open LLM, if any, is good enough in Pidgin, Yoruba, Igbo and Hausa to replace a hosted model?
