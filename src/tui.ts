import type { Plugin } from "@opencode/plugin/tui";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTracker, type Action, type Sessions } from "./tracker";

const execFileAsync = promisify(execFile);

export type Run = (
  script: string,
  env: Record<string, string>
) => Promise<unknown>;

type Host = Pick<Plugin.Context, "options" | "data" | "ui">;

const defaultRun: Run = (script, env) =>
  execFileAsync(script, [], {
    env: { ...process.env, ...env },
    timeout: 10_000
  });

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// execFile doesn't go through a shell, so "~" in a cli.json option or a quoted
// export would otherwise be taken literally
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Script precedence: plugin options in cli.json, then the environment, then
 * the bundled scripts shipped next to dist/.
 */
export function resolveScripts(options: Readonly<Record<string, any>>) {
  const scriptsDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../scripts"
  );
  const pick = (option: unknown, env: string | undefined, bundled: string) => {
    const chosen = nonEmpty(option) ?? nonEmpty(env);
    return chosen ? expandHome(chosen) : resolve(scriptsDir, bundled);
  };
  return {
    alert: pick(
      options.alertScript,
      process.env.OPENCODE_ALERT_SCRIPT,
      "alert.sh"
    ),
    clear: pick(
      options.clearScript,
      process.env.OPENCODE_CLEAR_SCRIPT,
      "clear.sh"
    )
  };
}

/**
 * A terminal owns the session family it is showing: the routed session, any
 * open tabs, and the last routed session while it is on another route (home,
 * a full-screen plugin page such as /diff).
 *
 * The router has no change subscription, so `observe` samples the route; call
 * it on every event so the last routed session is known before leaving it.
 */
export function sessionsFor(context: Host): Sessions & { observe(): void } {
  let lastRoot: string | undefined;
  const observe = () => {
    const route = context.ui.router.current();
    if (route.type === "session")
      lastRoot = context.data.session.root(route.sessionID);
  };
  return {
    observe,
    root: (sessionID) => context.data.session.root(sessionID),
    isChild: (sessionID) =>
      context.data.session.get(sessionID)?.parentID !== undefined,
    owned(rootID) {
      observe();
      if (rootID === lastRoot) return true;
      return (
        context.ui.tabs.enabled() &&
        context.ui.tabs.list().some((tab) => tab.sessionID === rootID)
      );
    }
  };
}

export function setupTmuxAlert(context: Host, run: Run = defaultRun) {
  // outside tmux there is no window to alert; stay silent rather than toast
  // on every launch
  if (!process.env.TMUX || !process.env.TMUX_PANE) return;

  const scripts = resolveScripts(context.options);
  const sessions = sessionsFor(context);
  const tracker = createTracker(sessions);
  let queue: Promise<void> = Promise.resolve();
  let warned = false;

  // serialised so an alert and its clear can't reach tmux out of order
  const perform = (action: Action) => {
    const [script, env] =
      action.type === "alert"
        ? [
            scripts.alert,
            {
              OPENCODE_ALERT_REASON: action.reason,
              OPENCODE_SESSION_ID: action.sessionID
            }
          ]
        : [scripts.clear, {}];
    queue = queue
      .then(() => run(script, env))
      .then(
        () => {},
        (error: unknown) => {
          // stderr would corrupt the TUI; surface the first failure only
          if (warned) return;
          warned = true;
          context.ui.toast.show({
            title: "opencode-tmux-alert",
            message: `Alert script failed: ${error instanceof Error ? error.message : String(error)}`,
            variant: "warning"
          });
        }
      );
    return queue;
  };

  const stop = context.data.listen(({ details }) => {
    sessions.observe();
    const action = tracker.handle(details);
    if (action) void perform(action);
  });

  return async () => {
    stop();
    // don't leave the window flagged after OpenCode exits or the plugin reloads
    if (tracker.active()) await perform({ type: "clear" });
  };
}

const plugin: Plugin.Definition = {
  id: "opencode-tmux-alert",
  setup: (context) => setupTmuxAlert(context)
};

export default plugin;
