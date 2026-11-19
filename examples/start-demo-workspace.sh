#!/bin/sh
# Only the example mounts a dedicated projects volume into this disposable runtime.
set -eu
if [ ! -e /projects/example ]; then
  scratch=$(mktemp -d /projects/.example-XXXXXX)
  git init -q -b main "$scratch"
  printf '# Example workspace\n\nA private repository for trying DevAgents.\n' > "$scratch/README.md"
  git -C "$scratch" add README.md
  git -C "$scratch" -c user.name=Fixture -c user.email=fixture@example.invalid -c core.hooksPath=/dev/null commit -qm 'Initial example'
  mv "$scratch" /projects/example
fi
exec node dist/cli/main.js serve --workspace-owner "$1" --socket-directory /run/devagents-workspace
