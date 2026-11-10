# ADR 0006: Move the backend from FastAPI to NestJS (TypeScript)

- **Status:** Accepted by the project owner (2026-11-10)
- **Date:** 2026-11-10
- **Supersedes:** the backend row of ADR 0001

## Context

The first product goal is a real-time spoken conversation: the user talks, the
agent answers. Speech-to-text and text-to-speech now run as hosted streaming
services (ADR 0007), so the backend no longer needs PyTorch or local model
runtimes. The Python backend was a skeleton (health and readiness routes only).
The owner wants one language (TypeScript) across the backend and the Next.js
frontend.

## Options considered

| Option | Notes |
|---|---|
| Keep FastAPI | Works, but splits the codebase across two languages with no model code left to justify Python |
| Next.js route handlers only | Poor fit for long-lived WebSockets; no module system for a growing domain |
| **NestJS + `ws` gateway** | Module system, DI, first-class WebSocket gateways, MIT licence |

## Decision

- Backend: Node.js 22+, NestJS 11 (MIT), TypeScript strict, `@nestjs/platform-ws`.
- Data access: Drizzle ORM (Apache-2.0) with SQL migrations, `pg` driver (MIT).
- Validation: Zod (MIT) at every boundary (env, HTTP, WebSocket messages).
- Tests: Vitest (MIT). Integration and leak tests run against the real Docker Postgres.
- Postgres row-level security stays mandatory; the app connects as a non-owner role.
- `voice-lab/` stays in Python as the speech benchmark lab; it is not product code.

## Consequences

- `backend/` is rewritten; Alembic and SQLAlchemy are removed.
- AGENTS.md sections 4.1, 7 and 17 read "TypeScript/NestJS" for the backend.
- CI runs `pnpm` lint, type check and tests for `backend/`.
