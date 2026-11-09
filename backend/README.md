# Backend (NestJS)

TypeScript NestJS API and real-time voice gateway. See ADR 0006 and ADR 0007.

```
cd backend
pnpm install
cp .env.example .env   # then fill in CARTESIA_API_KEY, MUSE_API_KEY, DEV_ACCESS_TOKEN
pnpm dev               # http://127.0.0.1:8000/v1/health
pnpm test
```

## Voice loop (`src/voice/`)

WebSocket gateway at `/v1/voice` (protocol: `docs/contracts/voice-protocol.ts`).
A browser client connects with `?token=<DEV_ACCESS_TOKEN>`, hears the AI
disclosure and recording notice, then talks; the agent answers by voice with
barge-in. Speech: Cartesia `ink-2` STT and `sonic-3.6` TTS (streaming
WebSockets); LLM: Muse Spark via the OpenAI-compatible endpoint.

- Adapter interfaces in `adapters/types.ts`; vendor code behind them only.
- Pre-rendered blocks (disclosure, notice, hold, silence prompt) are cached as
  raw PCM under `backend/.cache/blocks/` (gitignored), keyed by sha256 of
  (text, language, voice, model, speed, tone).
- **No audio is persisted anywhere in this milestone.** Transcripts, timings
  and notice proof go to the `InteractionStore` (in-memory stand-in until the
  Postgres data layer lands); the store is expected to redact sensitive values
  before writing (see `src/interactions/interaction-store.ts`).
- Latency: `turn.metrics` carries per-turn `stt`, `llm_first_token`,
  `llm_total`, `tts_first_audio` and `end_to_first_audio` (ms).

Headless end-to-end check against a running backend:

```
pnpm voice:smoke   # synthesises a caller line, runs one turn, prints timings
```
