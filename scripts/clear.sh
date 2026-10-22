#!/usr/bin/env bash
# Clear the tmux alert for this pane.
#
# Unmarks the pane, then keeps the window option @opencode-alert at 1 while
# another OpenCode pane in the same window is still marked.

set -euo pipefail

PANE_ID="${TMUX_PANE:-}"
[ -z "$PANE_ID" ] && exit 0

# One command list, so another pane's alert can't land between the read and
# the write. #{P:...} loops over the window's panes (tmux 3.2+)
tmux set-option -p -u -t "$PANE_ID" @opencode-alert-pane \; \
  if-shell -F -t "$PANE_ID" '#{P:#{@opencode-alert-pane}}' \
  "set-option -w -t $PANE_ID @opencode-alert 1" \
  "set-option -w -t $PANE_ID @opencode-alert 0" 2>/dev/null || true
