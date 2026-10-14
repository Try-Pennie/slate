import { describe, it, expect } from "vitest";

// #3298: the 8 second mint deadline was borrowed, never measured, and two mints
// have run out of it with no per call timing to say how close ordinary mints run.
// So every real mint writes one line: how long it took, what it was allowed, and
// how it ended. The clock and the writer are injected, so nothing here waits.

import { timedMint, mintScopeName, type MintLine } from "./mint-log";
import { DeadlineExceededError, NO_DEADLINE } from "@/lib/fetch-within-deadline";
import { GoogleHttpError } from "@/lib/google/http-error";

const CALENDAR =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.readonly";

function harness(startAt = 1_000) {
  let t = startAt;
  const lines: MintLine[] = [];
  return {
    now: () => t,
    advance: (ms: number) => (t += ms),
    write: (line: MintLine) => lines.push(line),
    lines,
  };
}

describe("timedMint (#3298)", () => {
  it("records how long a mint that answered took, against what it was allowed", async () => {
    const h = harness();
    const token = await timedMint(
      async () => {
        h.advance(412);
        return "tok";
      },
      { scope: CALENDAR, deadlineMs: 8_000, limitMs: 8_000 },
      h.now,
      h.write,
    );
    expect(token).toBe("tok");
    expect(h.lines).toEqual([
      { scope: "calendar", outcome: "ok", duration_ms: 412, deadline_ms: 8_000, limit_ms: 8_000 },
    ]);
  });

  it("calls a mint that ran out of time a timeout, and says when a budget cut it short", async () => {
    const h = harness();
    const err = new DeadlineExceededError("google token mint", 3_100, { label: "the booking confirm", totalMs: 12_000 });
    await expect(
      timedMint(
        async () => {
          h.advance(3_100);
          throw err;
        },
        { scope: CALENDAR, deadlineMs: 8_000, limitMs: 3_100, request: "the booking confirm" },
        h.now,
        h.write,
      ),
    ).rejects.toBe(err);
    expect(h.lines).toEqual([
      {
        scope: "calendar",
        outcome: "timeout",
        duration_ms: 3_100,
        deadline_ms: 8_000,
        limit_ms: 3_100,
        request: "the booking confirm",
        cut_by_budget: true,
      },
    ]);
  });

  it("calls a refused mint an error and keeps the status, never the body or the address", async () => {
    const h = harness();
    const err = new GoogleHttpError(
      'Delegated token failed for someone@trypennie.com: 401 {"error":"unauthorized_client"}',
      401,
      "unauthorized_client",
    );
    await expect(
      timedMint(
        async () => {
          h.advance(90);
          throw err;
        },
        { scope: "https://www.googleapis.com/auth/gmail.send", deadlineMs: 8_000, limitMs: 8_000 },
        h.now,
        h.write,
      ),
    ).rejects.toBe(err);
    expect(h.lines).toEqual([
      {
        scope: "gmail.send",
        outcome: "error",
        duration_ms: 90,
        deadline_ms: 8_000,
        limit_ms: 8_000,
        status: 401,
        reason: "unauthorized_client",
      },
    ]);
    expect(JSON.stringify(h.lines)).not.toContain("@");
  });

  it("leaves out a limit that is not a number rather than writing Infinity", async () => {
    const h = harness();
    await timedMint(async () => "tok", { scope: CALENDAR, deadlineMs: NO_DEADLINE, limitMs: NO_DEADLINE }, h.now, h.write);
    expect(h.lines).toEqual([{ scope: "calendar", outcome: "ok", duration_ms: 0 }]);
  });

  it("writes exactly one line per mint, however it ends", async () => {
    const h = harness();
    await timedMint(async () => "a", { scope: CALENDAR, deadlineMs: 8_000, limitMs: 8_000 }, h.now, h.write);
    await timedMint(
      async () => {
        throw new Error("network");
      },
      { scope: CALENDAR, deadlineMs: 8_000, limitMs: 8_000 },
      h.now,
      h.write,
    ).catch(() => {});
    expect(h.lines.map((l) => l.outcome)).toEqual(["ok", "error"]);
  });

  // #3512: a mint says why the shared token holder did not answer instead, on success
  // and on failure alike, so a week of lines says how often and why a mint was needed.
  it("carries why the holder did not answer, however the mint ends", async () => {
    const h = harness();
    await timedMint(async () => "a", { scope: CALENDAR, deadlineMs: 8_000, limitMs: 8_000, holder: "miss" }, h.now, h.write);
    await timedMint(
      async () => {
        throw new GoogleHttpError("Delegated token failed: 503", 503, "backendError");
      },
      { scope: CALENDAR, deadlineMs: 8_000, limitMs: 8_000, holder: "timeout" },
      h.now,
      h.write,
    ).catch(() => {});
    expect(h.lines.map((l) => [l.outcome, l.holder])).toEqual([
      ["ok", "miss"],
      ["error", "timeout"],
    ]);
  });
});

describe("mintScopeName (#3298)", () => {
  it("names the scopes Slate mints for by their short names", () => {
    expect(mintScopeName(CALENDAR)).toBe("calendar");
    expect(mintScopeName("https://www.googleapis.com/auth/gmail.send")).toBe("gmail.send");
    expect(mintScopeName("https://www.googleapis.com/auth/admin.directory.user.readonly")).toBe(
      "admin.directory.user.readonly",
    );
  });
});
