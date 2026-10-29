#!/bin/sh
# Called only by the launcher, with stdout captured. Never print this helper's output.
set -eu
service="$1"
existing="$2"
case "$service" in devagents-vault-*) ;; *) exit 2 ;; esac
case "$(uname -s)" in
  Darwin)
    if master=$(/usr/bin/security find-generic-password -a devagents -s "$service" -w 2>/dev/null); then
      printf '%s' "$master"; exit 0
    fi
    ;;
  Linux)
    command -v secret-tool >/dev/null 2>&1 || { echo 'Install libsecret secret-tool and unlock your desktop keyring before starting DevAgents.' >&2; exit 1; }
    if master=$(secret-tool lookup service "$service" account devagents); then
      printf '%s' "$master"; exit 0
    fi
    ;;
  *) echo 'Encrypted startup needs macOS Keychain or a Linux desktop secret service.' >&2; exit 1 ;;
esac
if [ "$existing" = yes ]; then
  echo 'The credential vault exists, but its OS keychain key is unavailable. Unlock or restore the keychain; no new key will be generated.' >&2
  exit 1
fi
master=$(openssl rand -hex 32)
case "$(uname -s)" in
  Darwin)
    # Interactive-command mode keeps the random hex key off process argv.
    # Do not allow arbitrary service text to enter the security command parser.
    case "$service" in *[!a-zA-Z0-9-]*) exit 2 ;; esac
    printf 'add-generic-password -a devagents -s %s -w %s\n' "$service" "$master" | /usr/bin/security -i >/dev/null 2>&1
    ;;
  Linux) printf '%s' "$master" | secret-tool store --label='DevAgents credential vault' service "$service" account devagents ;;
esac
# Verify persistence before letting the application encrypt credentials with this key.
case "$(uname -s)" in
  Darwin) stored=$(/usr/bin/security find-generic-password -a devagents -s "$service" -w) ;;
  Linux) stored=$(secret-tool lookup service "$service" account devagents) ;;
esac
[ "$stored" = "$master" ] || { echo 'Could not verify the OS credential-store entry.' >&2; exit 1; }
printf '%s' "$master"
