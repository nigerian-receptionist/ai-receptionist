# Backend (NestJS)

TypeScript NestJS API and real-time voice gateway. See ADR 0006 and ADR 0007.

## Setup

```sh
# From the repo root: start Postgres (127.0.0.1:5433) and Valkey.
docker compose up -d

cd backend
cp .env.example .env   # then fill in real API keys (never commit .env)
pnpm install
pnpm db:setup          # migrate as owner + seed demo tenant/agent (idempotent)
pnpm dev               # http://127.0.0.1:8000/v1/health
```

## Database roles

| Role | URL variable | Used by |
|---|---|---|
| `ai_receptionist` (owner) | `DATABASE_MIGRATION_URL` | `db:migrate`, `db:seed` only |
| `ai_receptionist_app` (LOGIN, no superuser, no BYPASSRLS) | `DATABASE_URL` | The running app and DB tests |

The app role has only `SELECT/INSERT/UPDATE/DELETE` grants; every tenant table
has `FORCE ROW LEVEL SECURITY` with a `tenant_isolation` policy on
`app.tenant_id`. All tenant access goes through `DbService.withTenant`, which
opens a transaction and runs `SELECT set_config('app.tenant_id', $1, true)`.
With no tenant set the app role sees zero rows (see `test/leak/`).

Production must pre-create `ai_receptionist_app` with a vault password; the
migration only applies the placeholder password when creating the role.

## Commands

```sh
pnpm lint              # eslint
pnpm typecheck          # tsc --noEmit
pnpm test              # unit tests (no DB needed)
pnpm test:integration  # store + RLS leak tests against real Postgres
pnpm db:migrate        # drizzle-kit migrations + roles/RLS (owner)
pnpm db:seed           # demo tenant "Demo Microfinance Ltd" + agent "Ada"
pnpm db:setup          # migrate + seed
pnpm build && pnpm start
```

## REST (`/v1`)

Guarded by `DevAuthGuard` (`Authorization: Bearer <DEV_ACCESS_TOKEN>`, local/dev
only) except readiness. Errors are RFC 9457 `application/problem+json`.

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /v1/health`, `GET /health` | no | Process liveness |
| `GET /v1/ready` | no | 200 when Postgres answers `SELECT 1`, else 503 |
| `GET /v1/agents?limit=&cursor=` | yes | Oldest first, keyset cursor, stable (`{data, nextCursor}`) |
| `GET /v1/interactions?limit=&cursor=` | yes | Newest first, keyset cursor, stable |
| `GET /v1/interactions/:id` | yes | Interaction with turns ordered by seq |

Public ids are prefixed (`int_…`, `trn_…`, `agt_…`); endpoints accept the
prefixed or raw uuid form.

## Voice loop (`src/voice/`)

WebSocket gateway at `/v1/voice` (protocol: `docs/contracts/voice-protocol.ts`).
A browser client connects with `?token=<DEV_ACCESS_TOKEN>`, hears the AI
disclosure and recording notice, then talks; the agent answers by voice with
barge-in. Speech: Cartesia `ink-2` STT and `sonic-3.6` TTS (streaming
WebSockets); LLM: Muse Spark via the OpenAI-compatible endpoint.

- Adapter interfaces in `adapters/types.ts`; vendor code behind them only.
- Pre-rendered blocks (disclosure, notice, hold, silence prompt) are cached as
  raw PCM under `backend/.cache/blocks/` (gitignored), keyed by sha256 of
  (text, language, voice, model, model revision, speed, tone, sample rate).
  Bump `TTS_MODEL_REVISION` whenever the TTS model changes.
- **No audio is persisted anywhere in this milestone.** Transcripts, timings
  and notice proof go to Postgres through `DrizzleInteractionStore` (the
  `InMemoryInteractionStore` is test-only now); both stores redact sensitive
  values before writing (see `src/interactions/interaction-store.ts`).
- Errors leave the API as RFC 9457 `application/problem+json` with stable
  `urn:ai-receptionist:*` type ids (see `src/common/errors.ts`).
- Latency: `turn.metrics` carries per-turn `stt`, `llm_first_token`,
  `llm_total`, `tts_first_audio` and `end_to_first_audio` (ms).

Headless end-to-end check against a running backend:

```
pnpm voice:smoke   # synthesises a caller line, runs one turn, prints timings
```
