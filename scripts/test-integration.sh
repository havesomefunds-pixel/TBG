#!/usr/bin/env bash
set -euo pipefail

# Keep the integration database completely separate from compose.yml's
# production-named postgres-data volume. Names include the process ID so
# concurrent local runs cannot collide.
test_id="tbg-integration-$$"
container_name="${test_id}-db"
volume_name="${test_id}-data"
database_url="postgresql://tbg_integration:integration-only@127.0.0.1:54329/tbg_integration?schema=public"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker volume create "$volume_name" >/dev/null
docker run -d --name "$container_name" \
  -e POSTGRES_USER=tbg_integration \
  -e POSTGRES_PASSWORD=integration-only \
  -e POSTGRES_DB=tbg_integration \
  -v "${volume_name}:/var/lib/postgresql/data" \
  -p 127.0.0.1:54329:5432 \
  postgres:17-bookworm >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$container_name" pg_isready -U tbg_integration -d tbg_integration >/dev/null 2>&1; then
    npx prisma generate
    DATABASE_URL="$database_url" npx prisma migrate deploy
    DATABASE_URL="$database_url" npx vitest run tests/postgres.integration.test.ts
    exit 0
  fi
  sleep 1
done

docker logs "$container_name" >&2 || true
exit 1
