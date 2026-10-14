import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

type Exec = (command: string) => Promise<unknown>

type Action = "alert" | "clear"

type Event = { type: string; data?: any }

/**
 * Maps an OpenCode event to a tmux action, or undefined when the event is ignored.
 */
export function actionFor(event: Event): Action | undefined {
  switch (event.type) {
    // Task completed, session is now idle
    case "session.idle":
    // Permission requested
    case "permission.asked":
    // Agent asking a question
    case "tui.prompt.append":
      return "alert"
    // Tool waiting on approval
    case "session.tool.called":
      return event.data?.executed === false ? "alert" : undefined
    // User submitted a message, clear the alert
    case "session.inbox.enqueued":
      return event.data?.item?.type === "user" ? "clear" : undefined
    default:
      return undefined
  }
}

/**
 * Tmux alert plugin for OpenCode.
 *
 * Sends visual alerts to tmux when OpenCode needs attention:
 * - Task completed (session idle)
 * - Permission requested
 * - Question asked (prompt append)
 *
 * Clears the alert when the user submits a message.
 *
 * Customise alert/clear scripts via environment variables:
 *   OPENCODE_ALERT_SCRIPT: path to a custom alert script
 *   OPENCODE_CLEAR_SCRIPT: path to a custom clear script
 */
export async function setupTmuxAlert(
  ctx: Pick<Plugin.Context, "event">,
  exec: Exec = (command) => execFileAsync(command),
) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const scriptsDir = resolve(pluginDir, "../scripts")

  const alertScript =
    process.env.OPENCODE_ALERT_SCRIPT ?? resolve(scriptsDir, "alert.sh")
  const clearScript =
    process.env.OPENCODE_CLEAR_SCRIPT ?? resolve(scriptsDir, "clear.sh")

  if (!process.env.TMUX) {
    console.error(
      "[opencode-tmux-alert] Not running inside tmux, plugin disabled",
    )
    return
  }

  const controller = new AbortController()

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        const action = actionFor(event as Event)
        if (!action) continue
        try {
          await exec(action === "alert" ? alertScript : clearScript)
        } catch (error) {
          console.error("[opencode-tmux-alert] Error:", error)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("[opencode-tmux-alert] Error:", error)
      }
    }
  })()

  return () => controller.abort()
}

export default Plugin.define({
  id: "opencode-tmux-alert",
  setup: (ctx) => setupTmuxAlert(ctx),
})
