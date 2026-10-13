#!/usr/bin/env bash
# Launch a phase owner for a run in Herdr.
#
#   harness/run.sh <runDir> <phase> <skillDir>
#
# The run lives in Herdr session `ctc-<basename runDir>` and in the workspace
# labelled `ctc-<basename runDir>`; an existing workspace is reused. See
# docs/notes/herdr.md for the verified Herdr commands and JSON paths.
set -euo pipefail

usage='usage: harness/run.sh <runDir> <phase> <skillDir>'

if [ "$#" -ne 3 ]; then
  echo "$usage" >&2
  exit 2
fi

if ! run_dir="$(realpath "$1")"; then
  echo "run.sh: run directory does not exist: $1" >&2
  exit 1
fi
phase="$2"
if ! skill_dir="$(realpath "$3")"; then
  echo "run.sh: skill directory does not exist: $3" >&2
  exit 1
fi
if ! [[ "$phase" =~ ^[0-9]+$ ]]; then
  echo "run.sh: phase must be a number, got: $phase" >&2
  exit 2
fi
if [ ! -f "$run_dir/node.json" ]; then
  echo "run.sh: $run_dir is not a run (no node.json); run node harness/init.ts first" >&2
  exit 1
fi
if [ ! -f "$skill_dir/SKILL.md" ]; then
  echo "run.sh: $skill_dir is not a skill directory (no SKILL.md)" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
owner_extension="$script_dir/owner-extension.ts"
phase_owner_skill="$script_dir/skills/phase-owner"
model="opencode-go/deepseek-v4.1-flash"

run_name="ctc-$(basename "$run_dir")"
owner="owner-p$phase"

# Run one herdr command against this run's named session; print stderr and stop
# on failure so a broken step is never mistaken for success.
herdr_session() {
  local out
  if ! out="$(herdr --session "$run_name" "$@" 2>&1)"; then
    printf 'run.sh: herdr %s failed:\n%s\n' "$*" "$out" >&2
    exit 1
  fi
  printf '%s' "$out"
}

session_running() {
  herdr session list --json 2>/dev/null |
    jq -e --arg s "$run_name" '.sessions[]? | select(.name == $s and .running)' >/dev/null 2>&1
}

# 1. A named Herdr session does not start its own server (verified 0.9.3:
#    `herdr --session X workspace list` fails with server_not_running).
if ! session_running; then
  echo "starting Herdr session $run_name" >&2
  herdr --session "$run_name" server >/dev/null 2>&1 &
  for _ in $(seq 1 100); do
    herdr --session "$run_name" workspace list >/dev/null 2>&1 && break
    sleep 0.2
  done
  if ! herdr --session "$run_name" workspace list >/dev/null 2>&1; then
    echo "run.sh: Herdr session $run_name did not start" >&2
    exit 1
  fi
fi

ws_id="$(herdr_session workspace list |
  jq -r --arg label "$run_name" '[.result.workspaces[]? | select(.label == $label) | .workspace_id] | first // empty')"

if [ -z "$ws_id" ]; then
  created="$(herdr_session workspace create --cwd "$run_dir" --label "$run_name" \
    --env "CTC_RUN_DIR=$run_dir" --no-focus)"
  ws_id="$(jq -r '.result.workspace.workspace_id' <<<"$created")"
else
  echo "reusing Herdr workspace $ws_id" >&2
fi

# 2. A workspace --env does not reach split panes (verified 0.9.3), so the
#    split carries CTC_RUN_DIR itself.
anchor="$(herdr_session pane list --workspace "$ws_id" | jq -r '.result.panes[0].pane_id')"
if [ -z "$anchor" ] || [ "$anchor" = "null" ]; then
  echo "run.sh: no pane found in Herdr workspace $ws_id" >&2
  exit 1
fi
split="$(herdr_session pane split --pane "$anchor" --direction right --cwd "$run_dir" \
  --env "CTC_RUN_DIR=$run_dir" --no-focus)"
pane="$(jq -r '.result.pane.pane_id' <<<"$split")"

# 3. Set the phase in the shell the owner will start from.
herdr_session pane run "$pane" "export CTC_PHASE=$phase" >/dev/null

# 4. Start the owner. It reads CTC_RUN_DIR/CTC_PHASE from the pane's env.
herdr_session agent start "$owner" --kind pi --pane "$pane" -- \
  --model "$model" \
  --extension "$owner_extension" \
  --skill "$phase_owner_skill" \
  --skill "$skill_dir" >/dev/null

# 5. Hand it the kick-off prompt and return without waiting.
herdr_session agent prompt "$owner" \
  "You own phase $phase of the run in $run_dir. Follow phase-owner and your phase skill. Start now." >/dev/null

printf 'attach: herdr session attach %s\n' "$run_name"
