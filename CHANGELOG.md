# Changelog

## [Unreleased]

### Changed
- **Breaking:** runs as an OpenCode V2 CLI plugin. Move `opencode-tmux-alert` from `plugins` in `opencode.json` to `plugins` in `cli.json`. The server plugin sent every alert to whichever tmux window started the OpenCode background service
- Requires OpenCode V2.1 or newer
- Requires tmux 3.2 or newer
- Alerts on permission requests, questions, and finished, failed or stalled turns, using the V2 events OpenCode's own notifications use. It no longer alerts on every tool call or on text inserted into the prompt
- Only the session a terminal is showing alerts its window. The alert stays until nothing is pending

### Added
- `alertScript` and `clearScript` plugin options
- `OPENCODE_ALERT_REASON` and `OPENCODE_SESSION_ID` for alert scripts

### Fixed
- The bundled alert script now rings the terminal bell. Previously the bell was swallowed with the script's output
- With several OpenCodes in split panes of one window, clearing one no longer clears the window's alert while another is still waiting
- The README's status line example used `status-right`, which only reflects the current window. It now uses `window-status-format`. The README also documents the script contract for custom scripts

## [1.0.1] - 2026-10-17

### Changed
- No user-facing changes; republished via npm trusted publishing

## [1.0.0] - 2026-10-14

### Changed
- **Breaking:** migrate to the OpenCode V2 plugin API

## [0.1.1] - 2026-02-26

### Changed
- No user-facing changes; republished after release workflow fixes

## [0.1.0] - 2026-02-26

### Added
- Tmux alert when OpenCode finishes a task, requests permission, waits on tool approval or asks a question, cleared when you reply
- `OPENCODE_ALERT_SCRIPT` and `OPENCODE_CLEAR_SCRIPT` to override the bundled scripts
