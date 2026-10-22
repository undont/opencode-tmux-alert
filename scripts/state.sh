#!/usr/bin/env bash
# Record OpenCode's agent state on its tmux window.
#
# Sets the window option @opencode-state to working, needs-input, idle or
# error, and unsets it when OpenCode exits. Use #{@opencode-state} in your
# tmux window-status-format to show what each OpenCode is doing.
#
# The plugin also sets OPENCODE_STATE_EVENT, OPENCODE_SESSION_ID and
# OPENCODE_DIRECTORY for custom scripts; this one ignores them.

set -euo pipefail

PANE_ID="${TMUX_PANE:-}"
[ -z "$PANE_ID" ] && exit 0

case "${OPENCODE_AGENT_STATE:-}" in
  working | needs-input | idle | error)
    tmux set-option -w -t "$PANE_ID" @opencode-state "$OPENCODE_AGENT_STATE" 2>/dev/null || true
    ;;
  ended)
    tmux set-option -w -u -t "$PANE_ID" @opencode-state 2>/dev/null || true
    ;;
esac
