#!/usr/bin/env bash
# Start a phase owner for a run in Herdr, creating the run first if needed.
#
#   harness/run.sh <runDir> <phase> <skillDir> [<dataset> "<interest>"]
#
# The first time, pass the dataset and research interest: the run folder is
# created (node harness/init.ts) and then the owner starts. To add another
# phase's owner to an existing run, leave them out.
#
# The run lives in Herdr session `ctc-<basename runDir>` and in the workspace
# labelled `ctc-<basename runDir>`; an existing workspace is reused. See
# docs/notes/herdr.md for the verified Herdr commands and JSON paths.
set -euo pipefail

usage='usage: harness/run.sh <runDir> <phase> <skillDir> [<dataset> "<interest>"]'

if [ "$#" -ne 3 ] && [ "$#" -ne 5 ]; then
  echo "$usage" >&2
  exit 2
fi

phase="$2"
if ! [[ "$phase" =~ ^[0-9]+$ ]]; then
  echo "run.sh: phase must be a number, got: $phase" >&2
  exit 2
fi
if ! skill_dir="$(realpath "$3")" || [ ! -f "$skill_dir/SKILL.md" ]; then
  echo "run.sh: $3 is not a skill directory (no SKILL.md)" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$1/node.json" ]; then
  if [ "$#" -ne 5 ]; then
    echo "run.sh: $1 is not a run yet; pass <dataset> \"<interest>\" to create it" >&2
    exit 2
  fi
  node "$script_dir/init.ts" "$1" "$4" "$5"
  echo "created run $1" >&2
elif [ "$#" -eq 5 ]; then
  echo "run.sh: $1 is already a run; leave out <dataset> \"<interest>\" to add an owner to it" >&2
  exit 2
fi
run_dir="$(realpath "$1")"

owner_extension="$script_dir/owner-extension.ts"
phase_owner_skill="$script_dir/skills/phase-owner"
model="opencode-go/deepseek-v4.1-flash"

run_name="ctc-$(basename "$run_dir")"
owner="owner-p$phase"

# 1. Refuse to start a second owner for a phase that is already running. This
#    comes before any pane is split or any agent started, so a duplicate run
#    leaves the session untouched. `agent get` exits non-zero when the agent is
#    gone, and that is the only state in which an owner may be started again.
if agent_json="$(herdr --session "$run_name" agent get "$owner" 2>/dev/null)"; then
  agent_status="$(jq -r '.result.agent.agent_status // empty' <<<"$agent_json" 2>/dev/null || true)"
  if [ -n "$agent_status" ] && [ "$agent_status" != "gone" ]; then
    echo "$owner is already running" >&2
    exit 1
  fi
fi

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

# 2. A named Herdr session does not start its own server (verified 0.9.3:
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

# 3. A workspace --env does not reach split panes (verified 0.9.3), so the
#    split carries CTC_RUN_DIR itself.
anchor="$(herdr_session pane list --workspace "$ws_id" | jq -r '.result.panes[0].pane_id')"
if [ -z "$anchor" ] || [ "$anchor" = "null" ]; then
  echo "run.sh: no pane found in Herdr workspace $ws_id" >&2
  exit 1
fi
split="$(herdr_session pane split --pane "$anchor" --direction right --cwd "$run_dir" \
  --env "CTC_RUN_DIR=$run_dir" --no-focus)"
pane="$(jq -r '.result.pane.pane_id' <<<"$split")"

# 4. Set the phase in the shell the owner will start from.
herdr_session pane run "$pane" "export CTC_PHASE=$phase" >/dev/null

# 5. Start the owner. It reads CTC_RUN_DIR/CTC_PHASE from the pane's env.
herdr_session agent start "$owner" --kind pi --pane "$pane" -- \
  --model "$model" \
  --extension "$owner_extension" \
  --skill "$phase_owner_skill" \
  --skill "$skill_dir" >/dev/null

# 6. Record the exact command that starts this phase again, so the supervisor
#    can restart a gone owner. The file belongs to the run (the owner may write
#    into owners/phase-N too) and is committed with the next tree change.
start_script="$run_dir/owners/phase-$phase/start.sh"
start_body="#!/usr/bin/env bash
exec \"$script_dir/run.sh\" \"$run_dir\" $phase \"$skill_dir\""
mkdir -p "$run_dir/owners/phase-$phase"
if [ ! -f "$start_script" ] || ! cmp -s <(printf '%s\n' "$start_body") "$start_script"; then
  printf '%s\n' "$start_body" > "$start_script"
  chmod +x "$start_script"
fi

# 7. Kick the owner off before the supervisor starts. `agent start` leaves it
#    idle until prompted, and a supervisor tick that beats the prompt sees an
#    owned phase with no nodes and an idle owner. The decision logic also
#    debounces done for one tick; the prompt goes first so the run is moving by
#    the time the loop's first tick lands.
herdr_session agent prompt "$owner" \
  "You own phase $phase of the run in $run_dir. Follow phase-owner and your phase skill. Start now." >/dev/null

# 8. Start the supervisor in its own pane unless one already watches this run.
#    The command line ends with the run dir, so compare that exact literal
#    suffix (quoted `case` pattern): a supervisor for …/runs/sup2 must not
#    hide the one for …/runs/sup, and path metacharacters match literally.
#    pgrep exits 1 when nothing matches; the loop and `if` handle it under
#    `set -e`. The split carries CTC_RUN_DIR because a workspace --env does
#    not reach it.
supervisor_running() {
  local line
  while IFS= read -r line; do
    case "$line" in
      *"supervise.ts $run_dir") return 0 ;;
    esac
  done < <(pgrep -af 'supervise\.ts' 2>/dev/null || true)
  return 1
}

if ! supervisor_running; then
  sup_split="$(herdr_session pane split --pane "$anchor" --direction right --cwd "$run_dir" \
    --env "CTC_RUN_DIR=$run_dir" --no-focus)"
  sup_pane="$(jq -r '.result.pane.pane_id' <<<"$sup_split")"
  herdr_session pane run "$sup_pane" "node $script_dir/supervise.ts $run_dir" >/dev/null
fi

printf 'attach: herdr session attach %s\n' "$run_name"
