# Local development

## Start the stack

Create a local environment file from the example, then start the services:

```powershell
Copy-Item .env.example .env
docker compose up --build -d
```

Compose requires the PostgreSQL and MinIO credentials to be present. The example values are for local development only. Published ports bind to `127.0.0.1` so the services are not exposed to other machines on the network.

| Service | Local address |
| --- | --- |
| Web | http://127.0.0.1:3000 |
| API health (through web; the API port is not published, D28) | http://127.0.0.1:3000/api/v1/health |
| PostgreSQL | 127.0.0.1:5432 |
| MinIO S3 API | http://127.0.0.1:9000 |
| MinIO Console | http://127.0.0.1:9001 |
| Mailpit UI | http://127.0.0.1:8025 |
| Mailpit SMTP | 127.0.0.1:1025 |

PostgreSQL readiness is checked over TCP. The role bootstrap script runs during first-time database initialization, and the migration service starts only after PostgreSQL is healthy. API, worker, and web wait for successful migration/API readiness as configured in Compose.

## Credentials and persistent volumes

PostgreSQL roles are created only when the PostgreSQL data volume is empty. Editing a password in `.env` does not rotate the password stored in an existing database volume. Rotate the database credential while preserving the volume, or reset this disposable local stack and its data with:

```powershell
docker compose down -v
docker compose up --build -d
```

`down -v` permanently deletes the local PostgreSQL and MinIO data volumes. Do not use it when that data needs to be retained.

## Migration rollback

The migration runner rolls back only the latest applied migration. The M0 down migration removes its foundation functions and extensions; PostgreSQL refuses to drop extensions that have dependent objects. Use rollback only on a disposable or backed-up development database. To exercise the round trip locally:

```powershell
docker compose stop api worker web
docker compose run --rm migrate node dist/core/db/migrate.js down
docker compose run --rm migrate node dist/core/db/migrate.js up
docker compose up -d api worker web
```

The Compose MinIO service uses a digest-pinned community mirror to avoid compiling MinIO during a local build. The upstream MinIO community repository is archived and no longer maintained; review the storage-engine decision before using this fixture beyond local development.

## API routing

The web app proxies `/api/*` to the internal API service. Docker bakes `http://api:3001` into the web build so the rewrite works at runtime inside the Compose network. Local `next dev` defaults to `http://127.0.0.1:3001`. Swagger docs are registered only outside `NODE_ENV=production`.
