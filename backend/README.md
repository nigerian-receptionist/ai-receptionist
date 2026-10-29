# Backend

Local FastAPI starter for the dashboard. It currently exposes only a process
health route; it does not yet store contacts, agents, or call records.

```sh
cd ..
uv run --project backend uvicorn app.main:app --app-dir backend --reload --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/docs` for the generated API documentation or
`http://127.0.0.1:8000/v1/health` to check the API process. `/v1/ready` also
checks PostgreSQL and Valkey connectivity. Tenant models, RLS policies, and
migrations are not in place yet.
