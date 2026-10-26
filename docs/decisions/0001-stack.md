# ADR 0001: Initial technology stack

- **Status:** Proposed; awaiting human review and merge
- **Date:** 2026-10-26
- **Decision owners:** Project maintainers

## Context

The project needs a consistent starting stack for the Nigerian AI receptionist.
The repository currently has no product requirements or infrastructure
documents, so this record captures only the technology choices already listed
in the supplied project guidance. It does not decide open questions.

## Decision

- Backend: Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2 and Alembic.
- Data: PostgreSQL with pgvector and row-level security; Valkey.
- Frontend: Next.js and strict TypeScript with Tailwind, shadcn/ui, TanStack
  Query, React Hook Form and Zod.
- Tooling: `uv`, `pnpm`, Docker Compose, GitHub Actions and Gitleaks.
- Speech components: free and open-source models and libraries only, with each
  model's weights and intended-use license checked before use.
- Temporal begins in M5. Choose the voice runtime in M4 through a separate ADR.
- Route LLM access through LiteLLM; do not hard-code a provider.

## Consequences

- Add frameworks, databases, queues, vendor SDKs and model families only after
  documenting the decision in an ADR.
- Model-specific choices remain open until the M1 benchmarks and ADR 0002.
- This ADR is proposed; M0 is not complete until maintainers review and merge it.

## References

- Supplied `AGENTS.md`, sections 2, 4, 5 and 18.
- Product requirements and infrastructure documents: not yet present in this
  repository; reconcile this ADR when they are added.
