import type { Sessions } from "./tracker";

export type AgentState = "working" | "needs-input" | "idle" | "error";

export type StateChange = {
  readonly state: AgentState | "ended";
  readonly sessionID?: string;
  readonly event: string;
};

type Event = { type: string; data?: any };

const INPUT_EVENTS = new Set([
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled"
]);

const FINISHED = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted"
]);

/**
 * Derives the agent state for this terminal's window from the same events the
 * alert tracker sees. Precedence: needs-input, then working, then error, then
 * idle. Call handle() after tracker.handle() so inputPending() already
 * reflects the event.
 */
export function createStateMonitor(
  sessions: Sessions,
  inputPending: () => boolean,
  initialRunning: readonly string[] = []
) {
  // owned root sessions with a turn in flight
  const running = new Set(initialRunning);
  // the last owned turn to finish failed; cleared when the next one starts
  let failed = false;
  let sessionID: string | undefined = initialRunning[0];

  const derive = (): AgentState => {
    if (inputPending()) return "needs-input";
    if (running.size > 0) return "working";
    return failed ? "error" : "idle";
  };

  let current = derive();

  function started(id: string): boolean {
    if (sessions.isChild(id) || !sessions.owned(id)) return false;
    running.add(id);
    failed = false;
    sessionID = id;
    return true;
  }

  function finished(id: string, type: string): boolean {
    if (sessions.isChild(id)) return false;
    // a turn that ends after ownership moved still stops counting as running
    running.delete(id);
    if (sessions.owned(id)) {
      failed = type === "session.execution.failed";
      sessionID = id;
    }
    return true;
  }

  function noteInput(id: unknown) {
    if (typeof id !== "string") return;
    const root = sessions.root(id);
    if (sessions.owned(root)) sessionID = root;
  }

  function apply(event: Event): boolean {
    const data = event.data ?? {};
    if (event.type === "session.execution.started")
      return started(data.sessionID);
    if (FINISHED.has(event.type)) return finished(data.sessionID, event.type);
    if (!INPUT_EVENTS.has(event.type)) return false;
    noteInput(data.sessionID ?? data.form?.sessionID);
    return true;
  }

  function handle(event: Event): StateChange | undefined {
    if (!apply(event)) return undefined;
    const next = derive();
    if (next === current) return undefined;
    current = next;
    return { state: next, sessionID, event: event.type };
  }

  return {
    handle,
    /** The current state, for reporting at setup */
    snapshot: (event: string): StateChange => ({
      state: current,
      sessionID,
      event
    }),
    /** The root session the state last referred to */
    sessionID: () => sessionID
  };
}
