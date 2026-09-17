import { describe, it, expect, vi, beforeEach } from "vitest";

// #2482: the reporter for a write that was ALLOWED to fail.
//
// Some writes genuinely degrade to something safe: a counter that did not advance,
// a lease that expires on its own timeout, a stamp the next pass rewrites. Those
// carry a written `// write-ok:` reason. This is what stops the refusal being
// invisible AS WELL AS tolerated, so the difference between "tolerated" and
// "nobody ever knew" is one line somebody can find.
const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { warn, info: vi.fn(), error: vi.fn() } }));

import { reportWriteFailure } from "./result";

beforeEach(() => warn.mockClear());

describe("reportWriteFailure", () => {
  it("says nothing when the write landed", () => {
    reportWriteFailure({ error: null }, "alert cooldown clear");
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a refusal, naming the site and the database's own reason", () => {
    reportWriteFailure(
      { error: { message: "permission denied for table alert_state" } },
      "alert firing marker",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const [tag, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(tag).toBe("db-write");
    expect(fields.context).toBe("alert firing marker");
    expect(String(fields.reason)).toMatch(/permission denied/);
  });

  // A result that never arrived is not a write that succeeded, and it is not a
  // failure this can describe either. It must not throw on the way past: this sits
  // on paths whose whole point is that they carry on.
  it("is silent, and does not throw, on a result it cannot read", () => {
    expect(() => reportWriteFailure(null, "x")).not.toThrow();
    expect(() => reportWriteFailure(undefined, "x")).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
