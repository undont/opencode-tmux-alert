import { describe, expect, test } from "bun:test";
import { createStateMonitor } from "./state";
import type { Sessions } from "./tracker";

// child sessions are "<root>/child"; only ses_mine is owned by default
function sessions(overrides: Partial<Sessions> = {}): Sessions {
  return {
    root: (id) => id.replace(/\/child$/, ""),
    isChild: (id) => id.endsWith("/child"),
    owned: (root) => root === "ses_mine",
    ...overrides
  };
}

const execution = (kind: string, sessionID = "ses_mine", extra = {}) => ({
  type: `session.execution.${kind}`,
  data: { sessionID, ...extra }
});

// the monitor reads input state from the tracker; tests drive it directly
function setup(
  initialRunning: string[] = [],
  overrides: Partial<Sessions> = {}
) {
  const input = { pending: false };
  const monitor = createStateMonitor(
    sessions(overrides),
    () => input.pending,
    initialRunning
  );
  return { monitor, input };
}

describe("initial state", () => {
  test("idle by default", () => {
    expect(setup().monitor.snapshot("setup")).toEqual({
      state: "idle",
      sessionID: undefined,
      event: "setup"
    });
  });

  test("working when the routed session is running", () => {
    expect(setup(["ses_mine"]).monitor.snapshot("setup")).toEqual({
      state: "working",
      sessionID: "ses_mine",
      event: "setup"
    });
  });
});

describe("turns", () => {
  test("started on an owned root is working", () => {
    const { monitor } = setup();
    expect(monitor.handle(execution("started"))).toEqual({
      state: "working",
      sessionID: "ses_mine",
      event: "session.execution.started"
    });
  });

  test("another terminal's session is ignored", () => {
    const { monitor } = setup();
    expect(monitor.handle(execution("started", "ses_other"))).toBeUndefined();
  });

  test("succeeded is idle, failed is error until the next turn", () => {
    const { monitor } = setup();
    monitor.handle(execution("started"));
    expect(
      monitor.handle(execution("failed", "ses_mine", { error: {} }))?.state
    ).toBe("error");
    expect(monitor.handle(execution("started"))?.state).toBe("working");
    expect(monitor.handle(execution("succeeded"))?.state).toBe("idle");
  });

  test.each(["user", "shutdown", "superseded", "inactivity"])(
    "%s interrupt is idle",
    (reason) => {
      const { monitor } = setup();
      monitor.handle(execution("started"));
      expect(
        monitor.handle(execution("interrupted", "ses_mine", { reason }))?.state
      ).toBe("idle");
    }
  );

  test("a subagent finishing mid-turn stays working", () => {
    const { monitor } = setup();
    monitor.handle(execution("started"));
    expect(
      monitor.handle(execution("succeeded", "ses_mine/child"))
    ).toBeUndefined();
  });

  test("a turn ending after ownership moved stops running", () => {
    let owned = true;
    const { monitor } = setup([], { owned: () => owned });
    monitor.handle(execution("started"));
    owned = false;
    expect(monitor.handle(execution("succeeded"))?.state).toBe("idle");
  });

  test("no change reports nothing", () => {
    const { monitor } = setup();
    monitor.handle(execution("started"));
    expect(monitor.handle(execution("started"))).toBeUndefined();
  });

  test("sessionID follows the owned root of the last relevant event", () => {
    const { monitor } = setup([], {
      owned: (root) => root === "ses_mine" || root === "ses_tab"
    });
    monitor.handle(execution("started"));
    monitor.handle(execution("started", "ses_tab"));
    expect(monitor.sessionID()).toBe("ses_tab");
    monitor.handle(execution("succeeded", "ses_mine"));
    expect(monitor.sessionID()).toBe("ses_mine");
  });
});

describe("input", () => {
  test("permission while working is needs-input, reply returns to working", () => {
    const { monitor, input } = setup();
    monitor.handle(execution("started"));
    input.pending = true;
    expect(
      monitor.handle({
        type: "permission.asked",
        data: { id: "per_1", sessionID: "ses_mine/child" }
      })
    ).toEqual({
      state: "needs-input",
      sessionID: "ses_mine",
      event: "permission.asked"
    });
    input.pending = false;
    expect(
      monitor.handle({
        type: "permission.replied",
        data: { requestID: "per_1", sessionID: "ses_mine" }
      })?.state
    ).toBe("working");
  });

  test("form while idle is needs-input, cancel returns to idle", () => {
    const { monitor, input } = setup();
    input.pending = true;
    expect(
      monitor.handle({
        type: "form.created",
        data: { form: { id: "frm_1", sessionID: "ses_mine" } }
      })?.state
    ).toBe("needs-input");
    input.pending = false;
    expect(
      monitor.handle({
        type: "form.cancelled",
        data: { id: "frm_1", sessionID: "ses_mine" }
      })?.state
    ).toBe("idle");
  });
});

describe("ignored events", () => {
  test.each([
    { type: "session.tool.called", data: { sessionID: "ses_mine" } },
    { type: "session.idle", data: { sessionID: "ses_mine" } },
    { type: "some.unknown.event" }
  ])("$type returns nothing", (event) => {
    expect(setup().monitor.handle(event)).toBeUndefined();
  });
});
