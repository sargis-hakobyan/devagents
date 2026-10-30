#!/bin/sh
# Match the backend's ASCII ID contract regardless of the user's locale.
set -eu
LC_ALL=C
export LC_ALL
project_id=$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z' | sed -e 's/^ *//' -e 's/ *$//' -e 's/  */-/g')
case "$project_id" in
  ''|*[!a-z0-9-]*|[!a-z]*) echo 'Use a project name starting with an English letter, with only letters, digits, spaces or dashes.' >&2; exit 1 ;;
esac
[ "${#project_id}" -le 64 ] || { echo 'The project ID must be at most 64 characters.' >&2; exit 1; }
printf '%s\n' "$project_id"
