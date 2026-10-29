# ai-receptionist

This repository contains a local AI voice demo and the starter for the platform
dashboard and API. The platform dashboard currently shows API connectivity and
clearly marks product areas that are not implemented yet.

## Start the platform frontend and backend

Install [uv](https://docs.astral.sh/uv/), [pnpm](https://pnpm.io/), and Docker
with Compose. From the repository root, create your local environment file and
start the supporting services:

```sh
cp .env.example .env
docker compose up -d
```

The container's PostgreSQL port is mapped to `127.0.0.1:5433` so it can run
alongside a PostgreSQL service already using the usual host port `5432`.

In a second terminal, start the API:

```sh
uv run --project backend uvicorn app.main:app --app-dir backend --reload --host 127.0.0.1 --port 8000
```

In a third terminal, start the dashboard:

```sh
cd frontend
cp .env.example .env.local
pnpm install
pnpm dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The API docs are at
[http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs). The current API only
provides health and readiness checks; it does not yet store or display contact,
agent, or call data. The API process check is at `/v1/health`; the dependency
check at `/v1/ready` verifies PostgreSQL and Valkey connectivity. Tenant data
models, row-level security policies, and migrations still need to be added.
This is a local development starter, not a production deployment.

Stop the frontend and API with Ctrl+C, then stop the local data services with:

```sh
docker compose down
```

## Voice Lab

The interactive local voice demo lives in `voice-lab/`. Start it from that
directory:

```sh
cd voice-lab
uv run python scripts/web_demo.py
```

Then open [http://127.0.0.1:8765/](http://127.0.0.1:8765/). Keep the server
running while you use the page; stop it with Ctrl+C. Do **not** open
`voice-lab/web/index.html` directly as a `file://` URL. The browser page needs
the local server for `/api/status` and `/api/turn/stream`; opening the file
directly causes “Failed to fetch.”

Whisper Tiny and Kokoro are the faster CPU options. Bark and YarnGPT2 are
available for local evaluation but can take longer on CPU. See
[voice-lab/README.md](voice-lab/README.md) for model setup and troubleshooting.
