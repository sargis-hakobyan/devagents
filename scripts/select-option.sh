#!/usr/bin/env bash
# Host-side menu: no Node installation or Docker round trip needed.
# Render to stderr so callers can capture only the selected number on stdout.
set -eu
question=$1
shift
options=("$@")
count=${#options[@]}
(( count > 0 && count <= 9 )) || exit 2
selected=0
trap 'printf "\nSetup cancelled.\n" >&2; exit 130' INT
trap 'printf "\nSetup cancelled.\n" >&2; exit 143' TERM
printf '\n%s\n' "$question" >&2

# Preserve plain numbered input for redirected output and limited terminals.
if [[ ! -t 0 || ! -t 2 || ${TERM:-dumb} == dumb ]]; then
  for ((i=0; i<count; i++)); do printf '%s. %s\n' "$((i+1))" "${options[i]}" >&2; done
  while true; do
    printf 'Choose [1-%s, Enter = 1]: ' "$count" >&2
    IFS= read -r answer || exit 130
    answer=${answer:-1}
    if [[ $answer =~ ^[1-9]$ ]] && (( answer <= count )); then printf '%s\n' "$answer"; exit; fi
    printf 'Choose one of the displayed numbers.\n' >&2
  done
fi

terminal_state=$(stty -g)
trap 'stty "$terminal_state"' EXIT
stty -echo -icanon min 1 time 0
printf 'Use ↑/↓ or a number, then Enter. Ctrl+C cancels.\n' >&2
render() {
  for ((i=0; i<count; i++)); do
    if (( i == selected )); then marker='>'; else marker=' '; fi
    printf '\r\033[2K%s %s. %s\n' "$marker" "$((i+1))" "${options[i]}" >&2
  done
}
render
while true; do
  key=''
  IFS= read -rn1 key || exit 130
  case "$key" in
    $'\004') exit 130 ;;
    '') printf '%s\n' "$((selected+1))"; exit ;;
    $'\033')
      sequence=''
      IFS= read -rn2 -t 1 sequence || true
      case "$sequence" in
        '[A'|'OA') selected=$(((selected+count-1)%count)) ;;
        '[B'|'OB') selected=$(((selected+1)%count)) ;;
        *) continue ;;
      esac ;;
    [1-9]) if (( key <= count )); then selected=$((key-1)); else continue; fi ;;
    *) continue ;;
  esac
  printf '\033[%sA' "$count" >&2
  render
done
