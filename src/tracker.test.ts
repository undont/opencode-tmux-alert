import { describe, expect, test } from "bun:test";
import { createTracker, type Sessions } from "./tracker";

// child sessions are "<root>/child"; only ses_mine is owned by default
function sessions(overrides: Partial<Sessions> = {}): Sessions {
  return {
    root: (id) => id.replace(/\/child$/, ""),
    isChild: (id) => id.endsWith("/child"),
    owned: (root) => root === "ses_mine",
    ...overrides
  };
}

const asked = (id: string, sessionID = "ses_mine") => ({
  type: "permission.asked",
  data: { id, sessionID }
});
const replied = (requestID: string) => ({
  type: "permission.replied",
  data: { requestID, sessionID: "ses_mine", reply: "once" }
});
const form = (id: string, sessionID = "ses_mine") => ({
  type: "form.created",
  data: { form: { id, sessionID } }
});
const execution = (kind: string, sessionID = "ses_mine", extra = {}) => ({
  type: `session.execution.${kind}`,
  data: { sessionID, ...extra }
});

describe("permissions", () => {
  test("alert on an owned session, clear on reply", () => {
    const tracker = createTracker(sessions());
    expect(tracker.handle(asked("per_1"))).toEqual({
      type: "alert",
      reason: "permission",
      sessionID: "ses_mine"
    });
    expect(tracker.handle(replied("per_1"))).toEqual({ type: "clear" });
  });

  test("subagent permission alerts with the root session", () => {
    const tracker = createTracker(sessions());
    expect(tracker.handle(asked("per_1", "ses_mine/child"))).toEqual({
      type: "alert",
      reason: "permission",
      sessionID: "ses_mine"
    });
  });

  test("another terminal's session is ignored", () => {
    const tracker = createTracker(sessions());
    expect(tracker.handle(asked("per_1", "ses_other"))).toBeUndefined();
    expect(tracker.active()).toBe(false);
  });

  test("duplicate asks alert once", () => {
    const tracker = createTracker(sessions());
    tracker.handle(asked("per_1"));
    expect(tracker.handle(asked("per_1"))).toBeUndefined();
  });
});

describe("forms", () => {
  test("alert as a question", () => {
    const tracker = createTracker(sessions());
    expect(tracker.handle(form("frm_1"))).toEqual({
      type: "alert",
      reason: "question",
      sessionID: "ses_mine"
    });
  });

  test.each(["form.replied", "form.cancelled"])("%s clears", (type) => {
    const tracker = createTracker(sessions());
    tracker.handle(form("frm_1"));
    expect(
      tracker.handle({ type, data: { id: "frm_1", sessionID: "ses_mine" } })
    ).toEqual({
      type: "clear"
    });
  });
});

describe("turns", () => {
  test("succeeded alerts done, started clears", () => {
    const tracker = createTracker(sessions());
    expect(tracker.handle(execution("succeeded"))).toEqual({
      type: "alert",
      reason: "done",
      sessionID: "ses_mine"
    });
    expect(tracker.handle(execution("started"))).toEqual({ type: "clear" });
  });

  test("failed alerts error once", () => {
    const tracker = createTracker(sessions());
    expect(
      tracker.handle(execution("failed", "ses_mine", { error: {} }))
    ).toEqual({
      type: "alert",
      reason: "error",
      sessionID: "ses_mine"
    });
    expect(tracker.handle(execution("succeeded"))).toBeUndefined();
  });

  test.each(["user", "shutdown", "superseded"])(
    "%s interrupt is quiet",
    (reason) => {
      const tracker = createTracker(sessions());
      expect(
        tracker.handle(execution("interrupted", "ses_mine", { reason }))
      ).toBeUndefined();
    }
  );

  test("inactivity interrupt alerts", () => {
    const tracker = createTracker(sessions());
    expect(
      tracker.handle(
        execution("interrupted", "ses_mine", { reason: "inactivity" })
      )
    ).toEqual({ type: "alert", reason: "done", sessionID: "ses_mine" });
  });

  test("subagent completion is ignored", () => {
    const tracker = createTracker(sessions());
    expect(
      tracker.handle(execution("succeeded", "ses_mine/child"))
    ).toBeUndefined();
  });
});

describe("pending set", () => {
  test("clears only when the last item resolves", () => {
    const tracker = createTracker(sessions());
    tracker.handle(asked("per_1"));
    tracker.handle(form("frm_1"));
    expect(tracker.handle(replied("per_1"))).toBeUndefined();
    expect(tracker.active()).toBe(true);
    expect(
      tracker.handle({
        type: "form.replied",
        data: { id: "frm_1", sessionID: "ses_mine" }
      })
    ).toEqual({ type: "clear" });
    expect(tracker.active()).toBe(false);
  });

  test("finished turn swaps an unanswered permission for done", () => {
    const tracker = createTracker(sessions());
    tracker.handle(asked("per_1"));
    expect(tracker.handle(execution("succeeded"))).toEqual({
      type: "alert",
      reason: "done",
      sessionID: "ses_mine"
    });
    // per_1 was dropped: starting the next turn leaves nothing pending
    expect(tracker.handle(execution("started"))).toEqual({ type: "clear" });
  });

  test("quiet interrupt clears a pending permission", () => {
    const tracker = createTracker(sessions());
    tracker.handle(asked("per_1"));
    expect(
      tracker.handle(execution("interrupted", "ses_mine", { reason: "user" }))
    ).toEqual({
      type: "clear"
    });
  });

  test("lost ownership clears without alerting done", () => {
    let owned = true;
    const tracker = createTracker(sessions({ owned: () => owned }));
    tracker.handle(asked("per_1"));
    owned = false;
    expect(tracker.handle(execution("succeeded"))).toEqual({ type: "clear" });
  });
});

describe("ignored events", () => {
  test.each([
    {
      type: "session.tool.called",
      data: { executed: false, sessionID: "ses_mine" }
    },
    { type: "tui.prompt.append", data: { text: "hi" } },
    { type: "session.idle", data: { sessionID: "ses_mine" } },
    { type: "some.unknown.event" }
  ])("$type does nothing", (event) => {
    const tracker = createTracker(sessions());
    expect(tracker.handle(event)).toBeUndefined();
    expect(tracker.active()).toBe(false);
  });
});
