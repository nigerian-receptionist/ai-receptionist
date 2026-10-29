# Database migrations

Create schema changes here with Alembic after adding the first SQLAlchemy
models. Migrations and tenant row-level security policies are not implemented
yet; keep tenant records out of application endpoints until isolation is in
place.

From the repository root, after models are added:

```sh
uv run --project backend alembic -c backend/alembic.ini revision --autogenerate -m "describe change"
uv run --project backend alembic -c backend/alembic.ini upgrade head
```
