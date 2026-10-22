export type Reason = "permission" | "question" | "done" | "error";

export type Action =
  | {
      readonly type: "alert";
      readonly reason: Reason;
      readonly sessionID: string;
    }
  | { readonly type: "clear" };

/**
 * Session lookups the tracker needs from the host. Kept as an interface so the
 * state machine stays pure and testable without a TUI.
 */
export interface Sessions {
  /** Root session ID of the family a session belongs to */
  root(sessionID: string): string;
  /** True when the session is a subagent (has a parent) */
  isChild(sessionID: string): boolean;
  /** True when this terminal is showing the given root session's family */
  owned(rootID: string): boolean;
}

type Event = { type: string; data?: any };

type Pending = { key: string; root: string; reason: Reason };

// interrupts the user caused or that a new turn replaces need no attention
const QUIET_INTERRUPTS = new Set(["user", "shutdown", "superseded"]);

const none = () => false;

/**
 * Tracks what this terminal's window is waiting on: unanswered permission
 * requests, unanswered forms (questions) and finished turns. Raises an alert
 * whenever a new item becomes pending and a clear once nothing is.
 */
export function createTracker(sessions: Sessions) {
  // "permission:<id>" | "form:<id>" | "done:<root>" -> owning root session
  const pending = new Map<string, string>();

  function apply(
    drop: (key: string, root: string) => boolean,
    add?: Pending
  ): Action | undefined {
    let dropped = false;
    for (const [key, root] of pending) {
      if (!drop(key, root)) continue;
      pending.delete(key);
      dropped = true;
    }
    if (add && !pending.has(add.key)) {
      pending.set(add.key, add.root);
      return { type: "alert", reason: add.reason, sessionID: add.root };
    }
    return dropped && pending.size === 0 ? { type: "clear" } : undefined;
  }

  function ownedRoot(sessionID: unknown): string | undefined {
    if (typeof sessionID !== "string") return undefined;
    const root = sessions.root(sessionID);
    return sessions.owned(root) ? root : undefined;
  }

  function handle(event: Event): Action | undefined {
    const data = event.data ?? {};
    switch (event.type) {
      case "permission.asked": {
        const root = ownedRoot(data.sessionID);
        if (!root) return undefined;
        return apply(none, {
          key: `permission:${data.id}`,
          root,
          reason: "permission"
        });
      }
      case "permission.replied":
        return apply((key) => key === `permission:${data.requestID}`);
      case "form.created": {
        const root = ownedRoot(data.form?.sessionID);
        if (!root) return undefined;
        return apply(none, {
          key: `form:${data.form.id}`,
          root,
          reason: "question"
        });
      }
      case "form.replied":
      case "form.cancelled":
        return apply((key) => key === `form:${data.id}`);
      case "session.execution.started": {
        const sessionID: string = data.sessionID;
        if (sessions.isChild(sessionID)) return undefined;
        return apply((key) => key === `done:${sessionID}`);
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const sessionID: string = data.sessionID;
        if (sessions.isChild(sessionID)) return undefined;
        // the turn is over: requests it left unanswered are moot
        const settled = (key: string, root: string) =>
          root === sessionID && !key.startsWith("done:");
        const quiet =
          event.type === "session.execution.interrupted" &&
          QUIET_INTERRUPTS.has(data.reason);
        if (quiet || !sessions.owned(sessionID)) return apply(settled);
        const reason =
          event.type === "session.execution.failed" ? "error" : "done";
        return apply(settled, {
          key: `done:${sessionID}`,
          root: sessionID,
          reason
        });
      }
      default:
        return undefined;
    }
  }

  return {
    handle,
    /** True while anything is pending, i.e. the window alert should be on */
    active: () => pending.size > 0
  };
}
