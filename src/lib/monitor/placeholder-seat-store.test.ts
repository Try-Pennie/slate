// The placeholder seat check's reads and probes (#4206): what each Google failure is
// classified as, and that the test placeholder never stands in for the real seat.
import { describe, expect, it, vi, beforeEach } from "vitest";

const google = vi.hoisted(() => ({
  getDelegatedToken: vi.fn(),
  classifyCalendarReachability: vi.fn(),
}));
vi.mock("@/lib/google/dwd", () => ({
  getDelegatedToken: google.getDelegatedToken,
  GMAIL_SEND_SCOPE: "https://www.googleapis.com/auth/gmail.send",
}));
vi.mock("@/lib/google/reachability", () => ({
  classifyCalendarReachability: google.classifyCalendarReachability,
  REACHABILITY_PROBE_TIMEOUT_MS: 8000,
}));
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { GoogleHttpError } from "@/lib/google/http-error";
import { DeadlineExceededError } from "@/lib/fetch-within-deadline";
import {
  countFutureCallsOnPlaceholders,
  loadRealPlaceholders,
  probePlaceholderCalendar,
  probePlaceholderGmail,
} from "./placeholder-seat-store";

/** A query builder that records its filters and answers one canned result. */
function fakeDb(result: { data?: unknown; count?: number | null; error: { message: string } | null }) {
  const calls: { table: string; select?: string; filters: [string, string, unknown][] } = { table: "", filters: [] };
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = (cols: string) => {
    calls.select = cols;
    return chain;
  };
  for (const op of ["eq", "in", "gt"] as const) {
    chain[op] = (col: string, val: unknown) => {
      calls.filters.push([op, col, val]);
      return chain;
    };
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
  const db = {
    from: (table: string) => {
      calls.table = table;
      return self();
    },
  };
  return { db: db as never, calls };
}

beforeEach(() => {
  google.getDelegatedToken.mockReset();
  google.classifyCalendarReachability.mockReset();
});

describe("probePlaceholderGmail", () => {
  it("answers reachable when the seat's send token mints", async () => {
    google.getDelegatedToken.mockResolvedValue("tok");
    expect(await probePlaceholderGmail("marcia@x.com")).toBe("reachable");
    expect(google.getDelegatedToken).toHaveBeenCalledWith("marcia@x.com", "https://www.googleapis.com/auth/gmail.send", 8000);
  });

  it("classifies a refused grant as gone, which is definitive", async () => {
    google.getDelegatedToken.mockRejectedValue(new GoogleHttpError("token 400", 400, "invalid_grant"));
    expect(await probePlaceholderGmail("marcia@x.com")).toBe("gone");
  });

  it("classifies a rate limit, a 5xx and a missed deadline as transient", async () => {
    google.getDelegatedToken.mockRejectedValueOnce(new GoogleHttpError("403", 403, "rateLimitExceeded"));
    expect(await probePlaceholderGmail("m@x")).toBe("transient");
    google.getDelegatedToken.mockRejectedValueOnce(new GoogleHttpError("503", 503));
    expect(await probePlaceholderGmail("m@x")).toBe("transient");
    google.getDelegatedToken.mockRejectedValueOnce(new DeadlineExceededError("google token mint", 8000));
    expect(await probePlaceholderGmail("m@x")).toBe("transient");
  });

  it("never throws: an unexpected error is transient, never reachable", async () => {
    google.getDelegatedToken.mockRejectedValue(new TypeError("fetch failed"));
    await expect(probePlaceholderGmail("m@x")).resolves.toBe("transient");
  });
});

describe("probePlaceholderCalendar", () => {
  it("is the activation gate's probe, logged under this check's tag", async () => {
    google.classifyCalendarReachability.mockResolvedValue("not-provisioned");
    expect(await probePlaceholderCalendar("marcia@x.com")).toBe("not-provisioned");
    expect(google.classifyCalendarReachability).toHaveBeenCalledWith("marcia@x.com", "placeholder-seat");
  });
});

describe("loadRealPlaceholders", () => {
  it("drops the test placeholder, so a drill seat never stands in for the real one", async () => {
    const { db, calls } = fakeDb({
      data: [
        { id: "u-real", name: "Marcia", email: "marcia@x.com", deactivated_at: null, is_test: false },
        { id: "u-test", name: "Marcia Test", email: "marcia.test@x.com", deactivated_at: null, is_test: true },
      ],
      error: null,
    });
    expect(await loadRealPlaceholders(db)).toEqual([{ id: "u-real", name: "Marcia", email: "marcia@x.com", deactivated_at: null }]);
    expect(calls.table).toBe("users");
    expect(calls.filters).toContainEqual(["eq", "is_placeholder", true]);
  });

  it("throws on a failed read, never answering no placeholder", async () => {
    const { db } = fakeDb({ data: null, error: { message: "boom" } });
    await expect(loadRealPlaceholders(db)).rejects.toThrow(/monitor placeholder seat rows/);
  });
});

describe("countFutureCallsOnPlaceholders", () => {
  it("counts the active calls on those placeholders that have not ended", async () => {
    const { db, calls } = fakeDb({ count: 3, error: null });
    expect(await countFutureCallsOnPlaceholders(db, ["u-real"], "2026-10-26T19:00:00.000Z")).toBe(3);
    expect(calls.table).toBe("bookings");
    expect(calls.filters).toEqual([
      ["in", "assigned_user_id", ["u-real"]],
      ["in", "status", ["confirmed", "rescheduled"]],
      ["gt", "ends_at", "2026-10-26T19:00:00.000Z"],
    ]);
  });

  it("throws on a failed count, never answering zero calls", async () => {
    const { db } = fakeDb({ count: null, error: { message: "boom" } });
    await expect(countFutureCallsOnPlaceholders(db, ["u-real"], "2026-10-26T19:00:00.000Z")).rejects.toThrow(/future calls/);
  });
});
