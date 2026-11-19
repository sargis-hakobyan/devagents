#!/bin/sh
set -eu
# Keep the database administrator credential inside the database container.
export POSTGRES_PASSWORD="$(head -c 32 /dev/urandom | base64)"
if [ ! -s /run/secrets/workspace-db ]; then
  [ ! -s "$PGDATA/PG_VERSION" ] || { echo 'Restore the workspace database credential volume' >&2; exit 1; }
  umask 077
  head -c 32 /dev/urandom | base64 > /run/secrets/workspace-db.new
  chmod 0444 /run/secrets/workspace-db.new
  mv /run/secrets/workspace-db.new /run/secrets/workspace-db
fi
exec docker-entrypoint.sh postgres
