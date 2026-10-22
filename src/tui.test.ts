import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { setupTmuxAlert } from "./tui";

type Route = { type: "home" } | { type: "session"; sessionID: string };

function createHost(
  opts: {
    route?: Route;
    tabs?: string[];
    parents?: Record<string, string>;
    options?: Record<string, unknown>;
  } = {}
) {
  const listeners = new Set<(event: { details: any }) => void>();
  const toasts: unknown[] = [];
  const state: { route: Route } = {
    route: opts.route ?? { type: "session", sessionID: "ses_mine" }
  };
  const parents = opts.parents ?? {};
  const host = {
    options: opts.options ?? {},
    data: {
      listen: (handler: (event: { details: any }) => void) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
      session: {
        root: (id: string) => parents[id] ?? id,
        get: (id: string) => ({ id, parentID: parents[id] })
      }
    },
    ui: {
      router: { current: () => state.route },
      tabs: {
        enabled: () => opts.tabs !== undefined,
        list: () =>
          (opts.tabs ?? []).map((sessionID) => ({
            sessionID,
            active: false,
            busy: false,
            attention: false
          }))
      },
      toast: { show: (toast: unknown) => toasts.push(toast) }
    }
  };
  const emit = (details: unknown) =>
    listeners.forEach((listener) => listener({ details }));
  return { host: host as any, emit, listeners, toasts, state };
}

function recorder(fail = false) {
  const calls: { script: string; env: Record<string, string> }[] = [];
  const run = async (script: string, env: Record<string, string>) => {
    calls.push({ script, env });
    if (fail) throw new Error("boom");
  };
  return { calls, run };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const asked = (id: string, sessionID = "ses_mine") => ({
  type: "permission.asked",
  data: { id, sessionID }
});
const replied = (requestID: string) => ({
  type: "permission.replied",
  data: { requestID, sessionID: "ses_mine", reply: "once" }
});

const ENV = [
  "TMUX",
  "TMUX_PANE",
  "OPENCODE_ALERT_SCRIPT",
  "OPENCODE_CLEAR_SCRIPT"
] as const;
let saved: Partial<Record<(typeof ENV)[number], string>> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
  process.env.TMUX_PANE = "%1";
  delete process.env.OPENCODE_ALERT_SCRIPT;
  delete process.env.OPENCODE_CLEAR_SCRIPT;
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("tmux guard", () => {
  test.each(["TMUX", "TMUX_PANE"])("disabled without %s", (key) => {
    delete process.env[key];
    const { host, listeners } = createHost();
    expect(setupTmuxAlert(host, recorder().run)).toBeUndefined();
    expect(listeners.size).toBe(0);
  });
});

describe("scripts", () => {
  test("bundled alert.sh with reason and session", async () => {
    const { host, emit } = createHost();
    const { calls, run } = recorder();
    setupTmuxAlert(host, run);
    emit(asked("per_1"));
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toMatch(/scripts\/alert\.sh$/);
    expect(calls[0].env).toEqual({
      OPENCODE_ALERT_REASON: "permission",
      OPENCODE_SESSION_ID: "ses_mine"
    });
  });

  test("bundled clear.sh once nothing is pending", async () => {
    const { host, emit } = createHost();
    const { calls, run } = recorder();
    setupTmuxAlert(host, run);
    emit(asked("per_1"));
    emit(replied("per_1"));
    await flush();
    expect(calls.map((call) => call.script)).toEqual([
      expect.stringMatching(/scripts\/alert\.sh$/),
      expect.stringMatching(/scripts\/clear\.sh$/)
    ]);
  });

  test("environment overrides bundled scripts", async () => {
    process.env.OPENCODE_ALERT_SCRIPT = "/env/alert.sh";
    process.env.OPENCODE_CLEAR_SCRIPT = "/env/clear.sh";
    const { host, emit } = createHost();
    const { calls, run } = recorder();
    setupTmuxAlert(host, run);
    emit(asked("per_1"));
    emit(replied("per_1"));
    await flush();
    expect(calls.map((call) => call.script)).toEqual([
      "/env/alert.sh",
      "/env/clear.sh"
    ]);
  });

  test("options override the environment", async () => {
    process.env.OPENCODE_ALERT_SCRIPT = "/env/alert.sh";
    const { host, emit } = createHost({
      options: { alertScript: "/opt/alert.sh", clearScript: "/opt/clear.sh" }
    });
    const { calls, run } = recorder();
    setupTmuxAlert(host, run);
    emit(asked("per_1"));
    emit(replied("per_1"));
    await flush();
    expect(calls.map((call) => call.script)).toEqual([
      "/opt/alert.sh",
      "/opt/clear.sh"
    ]);
  });

  test("expands ~ in options and the environment", async () => {
    process.env.OPENCODE_CLEAR_SCRIPT = "~/env/clear.sh";
    const { host, emit } = createHost({
      options: { alertScript: "~/opt/alert.sh" }
    });
    const { calls, run } = recorder();
    setupTmuxAlert(host, run);
    emit(asked("per_1"));
    emit(replied("per_1"));
    await flush();
    expect(calls.map((call) => call.script)).toEqual([
      join(homedir(), "opt/alert.sh"),
      join(homedir(), "env/clear.sh")
    ]);
  });
});

describe("ownership", () => {
  test("ignores sessions this terminal isn't showing", async () => {
    const { host, emit } = createHost();
    const { calls, run } = recorder();
    setupTmuxAlert(host, run);
    emit(asked("per_1", "ses_other"));
    await flush();
    expect(calls).toHaveLength(0);
  });

  test("a child of the routed session is owned", async () => {
    const { host, emit } = createHost({ parents: { ses_child: "ses_mine" } });
    const { calls, run } = recorder();
    setupTmuxAlert(host, run);
    emit(asked("per_1", "ses_child"));
    await flush();
    expect(calls[0].env.OPENCODE_SESSION_ID).toBe("ses_mine");
  });

  test("open tabs are owned", async () => {
    const { host, emit } = createHost({ tabs: ["ses_tab"] });
    const { calls, run } = recorder();
    setupTmuxAlert(host, run);
    emit(asked("per_1", "ses_tab"));
    await flush();
    expect(calls).toHaveLength(1);
  });

  test("last routed session stays owned on home", async () => {
    const { host, emit, state } = createHost();
    const { calls, run } = recorder();
    setupTmuxAlert(host, run);
    emit({
      type: "session.execution.started",
      data: { sessionID: "ses_mine" }
    });
    state.route = { type: "home" };
    emit({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_mine" }
    });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].env.OPENCODE_ALERT_REASON).toBe("done");
  });
});

describe("runner", () => {
  test("runs scripts in event order", async () => {
    const { host, emit } = createHost();
    const order: string[] = [];
    setupTmuxAlert(host, async (script) => {
      // the first call resolves last if runs were not serialised
      await new Promise((resolve) =>
        setTimeout(resolve, order.length === 0 ? 5 : 0)
      );
      order.push(script);
    });
    emit(asked("per_1"));
    emit(replied("per_1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([
      expect.stringMatching(/alert\.sh$/),
      expect.stringMatching(/clear\.sh$/)
    ]);
  });

  test("a failing script toasts once and keeps going", async () => {
    const { host, emit, toasts } = createHost();
    const { calls, run } = recorder(true);
    setupTmuxAlert(host, run);
    emit(asked("per_1"));
    emit(replied("per_1"));
    emit(asked("per_2"));
    await flush();
    expect(calls).toHaveLength(3);
    expect(toasts).toHaveLength(1);
  });
});

describe("cleanup", () => {
  test("unsubscribes and clears a pending alert", async () => {
    const { host, emit, listeners } = createHost();
    const { calls, run } = recorder();
    const cleanup = setupTmuxAlert(host, run)!;
    emit(asked("per_1"));
    await cleanup();
    expect(listeners.size).toBe(0);
    expect(calls.map((call) => call.script)).toEqual([
      expect.stringMatching(/alert\.sh$/),
      expect.stringMatching(/clear\.sh$/)
    ]);
  });

  test("does not clear when nothing is pending", async () => {
    const { host } = createHost();
    const { calls, run } = recorder();
    const cleanup = setupTmuxAlert(host, run)!;
    await cleanup();
    expect(calls).toHaveLength(0);
  });
});
