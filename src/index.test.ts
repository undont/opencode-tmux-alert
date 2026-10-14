import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { actionFor, setupTmuxAlert } from "./index"

// --- Mock event stream ---

function createMockCtx(events: unknown[]) {
  const subscribe = async function* () {
    for (const event of events) yield event
  }
  return { event: { subscribe: () => subscribe() } } as any
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// --- Environment variable isolation ---

let savedTmux: string | undefined
let savedAlertScript: string | undefined
let savedClearScript: string | undefined

beforeEach(() => {
  savedTmux = process.env.TMUX
  savedAlertScript = process.env.OPENCODE_ALERT_SCRIPT
  savedClearScript = process.env.OPENCODE_CLEAR_SCRIPT

  // Default: running inside tmux
  process.env.TMUX = "/tmp/tmux-1000/default,12345,0"
  delete process.env.OPENCODE_ALERT_SCRIPT
  delete process.env.OPENCODE_CLEAR_SCRIPT
})

afterEach(() => {
  if (savedTmux !== undefined) {
    process.env.TMUX = savedTmux
  } else {
    delete process.env.TMUX
  }
  if (savedAlertScript !== undefined) {
    process.env.OPENCODE_ALERT_SCRIPT = savedAlertScript
  } else {
    delete process.env.OPENCODE_ALERT_SCRIPT
  }
  if (savedClearScript !== undefined) {
    process.env.OPENCODE_CLEAR_SCRIPT = savedClearScript
  } else {
    delete process.env.OPENCODE_CLEAR_SCRIPT
  }
})

// --- Tests ---

describe("TMUX guard", () => {
  test("runs nothing when TMUX is not set", async () => {
    delete process.env.TMUX
    const calls: string[] = []
    const spy = spyOn(console, "error").mockImplementation(() => {})
    const cleanup = await setupTmuxAlert(
      createMockCtx([{ type: "session.idle" }]),
      async (command) => {
        calls.push(command)
      },
    )
    await flush()
    expect(cleanup).toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(spy).toHaveBeenCalledWith(
      "[opencode-tmux-alert] Not running inside tmux, plugin disabled",
    )
    spy.mockRestore()
  })

  test("returns a cleanup function when TMUX is set", async () => {
    const cleanup = await setupTmuxAlert(createMockCtx([]), async () => {})
    expect(typeof cleanup).toBe("function")
    cleanup!()
  })
})

describe("Script path resolution", () => {
  test("uses bundled alert.sh by default", async () => {
    const calls: string[] = []
    await setupTmuxAlert(createMockCtx([{ type: "session.idle" }]), async (c) => {
      calls.push(c)
    })
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/scripts\/alert\.sh$/)
  })

  test("uses bundled clear.sh by default", async () => {
    const calls: string[] = []
    await setupTmuxAlert(
      createMockCtx([{ type: "session.inbox.enqueued", data: { item: { type: "user" } } }]),
      async (c) => {
        calls.push(c)
      },
    )
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/scripts\/clear\.sh$/)
  })

  test("uses OPENCODE_ALERT_SCRIPT env var when set", async () => {
    process.env.OPENCODE_ALERT_SCRIPT = "/custom/alert.sh"
    const calls: string[] = []
    await setupTmuxAlert(createMockCtx([{ type: "session.idle" }]), async (c) => {
      calls.push(c)
    })
    await flush()
    expect(calls).toEqual(["/custom/alert.sh"])
  })

  test("uses OPENCODE_CLEAR_SCRIPT env var when set", async () => {
    process.env.OPENCODE_CLEAR_SCRIPT = "/custom/clear.sh"
    const calls: string[] = []
    await setupTmuxAlert(
      createMockCtx([{ type: "session.inbox.enqueued", data: { item: { type: "user" } } }]),
      async (c) => {
        calls.push(c)
      },
    )
    await flush()
    expect(calls).toEqual(["/custom/clear.sh"])
  })
})

describe("Event routing", () => {
  test("session.idle maps to alert", () => {
    expect(actionFor({ type: "session.idle" })).toBe("alert")
  })

  test("permission.asked maps to alert", () => {
    expect(actionFor({ type: "permission.asked" })).toBe("alert")
  })

  test("tui.prompt.append maps to alert", () => {
    expect(actionFor({ type: "tui.prompt.append" })).toBe("alert")
  })

  test("session.tool.called awaiting approval maps to alert", () => {
    expect(
      actionFor({ type: "session.tool.called", data: { executed: false } }),
    ).toBe("alert")
  })

  test("user inbox item maps to clear", () => {
    expect(
      actionFor({ type: "session.inbox.enqueued", data: { item: { type: "user" } } }),
    ).toBe("clear")
  })
})

describe("Negative cases", () => {
  test("session.tool.called that already executed does NOT alert", () => {
    expect(
      actionFor({ type: "session.tool.called", data: { executed: true } }),
    ).toBeUndefined()
  })

  test("non-user inbox item does NOT clear", () => {
    expect(
      actionFor({ type: "session.inbox.enqueued", data: { item: { type: "synthetic" } } }),
    ).toBeUndefined()
  })

  test("unhandled event type triggers neither alert nor clear", () => {
    expect(actionFor({ type: "some.unknown.event" })).toBeUndefined()
  })

  test("unhandled events run no scripts", async () => {
    const calls: string[] = []
    await setupTmuxAlert(
      createMockCtx([{ type: "some.unknown.event" }, { type: "message.updated" }]),
      async (c) => {
        calls.push(c)
      },
    )
    await flush()
    expect(calls).toHaveLength(0)
  })
})

describe("Error handling", () => {
  test("script failure is caught and logged, and the loop keeps going", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    const calls: string[] = []
    await setupTmuxAlert(
      createMockCtx([{ type: "session.idle" }, { type: "tui.prompt.append" }]),
      async (c) => {
        calls.push(c)
        throw new Error("shell execution failed")
      },
    )
    await flush()
    expect(calls).toHaveLength(2)
    expect(spy).toHaveBeenCalledWith(
      "[opencode-tmux-alert] Error:",
      expect.any(Error),
    )
    spy.mockRestore()
  })
})
