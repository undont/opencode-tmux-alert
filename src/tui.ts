import type { Plugin } from "@opencode/plugin/tui";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createStateMonitor, type StateChange } from "./state";
import { createTracker, type Action, type Sessions } from "./tracker";

const execFileAsync = promisify(execFile);

export type Run = (
  script: string,
  env: Record<string, string>
) => Promise<unknown>;

type Host = Pick<Plugin.Context, "options" | "location" | "data" | "ui">;

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
 * the bundled scripts shipped next to dist/. `stateScript: false` turns state
 * reporting off.
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
    ),
    state:
      options.stateScript === false
        ? undefined
        : pick(
            options.stateScript,
            process.env.OPENCODE_STATE_SCRIPT,
            "state.sh"
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

// a TUI started on (or resumed into) a running session should report working
function initialRunning(context: Host): string[] {
  const route = context.ui.router.current();
  if (route.type !== "session") return [];
  const root = context.data.session.root(route.sessionID);
  return context.data.session.status(root) === "running" ? [root] : [];
}

function directoryFor(context: Host, sessionID: string | undefined): string {
  const session = sessionID ? context.data.session.get(sessionID) : undefined;
  return (
    session?.location?.directory ??
    context.location?.directory ??
    context.data.location.default().directory
  );
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

  // serialised so script runs reach tmux and the state consumer in event order
  const enqueue = (script: string, env: Record<string, string>) => {
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
            message: `Script failed: ${error instanceof Error ? error.message : String(error)}`,
            variant: "warning"
          });
        }
      );
    return queue;
  };

  const alert = (action: Action) =>
    action.type === "alert"
      ? enqueue(scripts.alert, {
          OPENCODE_ALERT_REASON: action.reason,
          OPENCODE_SESSION_ID: action.sessionID
        })
      : enqueue(scripts.clear, {});

  const stateScript = scripts.state;
  const report = (change: StateChange) => {
    if (!stateScript) return queue;
    return enqueue(stateScript, {
      OPENCODE_AGENT_STATE: change.state,
      OPENCODE_STATE_EVENT: change.event,
      OPENCODE_SESSION_ID: change.sessionID ?? "",
      OPENCODE_DIRECTORY: directoryFor(context, change.sessionID)
    });
  };

  const monitor = stateScript
    ? createStateMonitor(
        sessions,
        tracker.inputPending,
        initialRunning(context)
      )
    : undefined;
  if (monitor) void report(monitor.snapshot("setup"));

  const stop = context.data.listen(({ details }) => {
    sessions.observe();
    const action = tracker.handle(details);
    if (action) void alert(action);
    const change = monitor?.handle(details);
    if (change) void report(change);
  });

  return async () => {
    stop();
    // don't leave the window flagged or the state reported after OpenCode
    // exits or the plugin reloads
    if (tracker.active()) void alert({ type: "clear" });
    if (monitor)
      void report({
        state: "ended",
        sessionID: monitor.sessionID(),
        event: "cleanup"
      });
    await queue;
  };
}

const plugin: Plugin.Definition = {
  id: "opencode-tmux-alert",
  setup: (context) => setupTmuxAlert(context)
};

export default plugin;
