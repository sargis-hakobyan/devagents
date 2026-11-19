#!/bin/sh
# Run on the operator host. Keep key material in the pipe into the chosen runtime.
set -eu
umask 077
test "$#" = 2 || { echo 'Usage: scripts/unlock-workspace.sh COMPOSE_FILE SERVICE' >&2; exit 2; }
file=$1
service=$2
case "$service" in ''|-*|*[!a-zA-Z0-9_-]*) exit 2 ;; esac
cli() { docker compose -f "$file" exec -T "$service" node dist/cli/main.js "$@"; }
owner=$(cli auth vault-owner)
case "$owner" in ''|*[!a-f0-9-]*) echo 'Invalid workspace owner' >&2; exit 1 ;; esac
existing=$(cli auth vault-exists)
case "$existing" in yes|no) ;; *) exit 1 ;; esac
scripts=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "${DEVAGENTS_KMS_KEY_ARN:-}" ]; then
  python3 "$scripts/kms-vault-key.py" "$DEVAGENTS_KMS_KEY_ARN" "$owner" "$existing" | cli auth unlock --kms-owner "$owner"
else
  "$scripts/vault-key.sh" "devagents-vault-workspace-$owner" "$existing" | cli auth unlock
fi
