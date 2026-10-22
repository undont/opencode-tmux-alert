#!/usr/bin/env bash
# Trigger a tmux alert for the window running OpenCode.
#
# Marks this pane with @opencode-alert-pane, sets the window option
# @opencode-alert to 1 and rings the terminal bell. Use #{@opencode-alert} in
# your tmux window-status-format to show which window needs attention.
#
# The plugin also sets OPENCODE_ALERT_REASON (permission, question, done or
# error) and OPENCODE_SESSION_ID for custom scripts; this one ignores them.

set -euo pipefail

PANE_ID="${TMUX_PANE:-}"
[ -z "$PANE_ID" ] && exit 0

# One command list, so another pane's clear can't interleave
tmux set-option -p -t "$PANE_ID" @opencode-alert-pane 1 \; \
  set-option -w -t "$PANE_ID" @opencode-alert 1 2>/dev/null || true

# The plugin captures stdout, so a plain printf never reached the terminal.
# Ring the bell on the pane's tty instead; this trips tmux monitor-bell
{ printf '\a' >/dev/tty; } 2>/dev/null || true
