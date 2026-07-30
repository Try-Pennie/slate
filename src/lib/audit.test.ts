import { describe, it, expect, vi, beforeEach } from "vitest";

// #1049: recordAudit went dark silently.
//
// The empty catch it used to carry was nearly unreachable. A supabase insert
// reports a database error by RETURNING it (`{ error }`), not by throwing, and
// the old code discarded the return value entirely. So the failure the issue was
// filed about (schema drift, an RLS change, a revoked grant) landed in the
// returned error and was thrown away without ever reaching the catch: the
// privileged-action trail stops being written and nothing anywhere says so.
//
// Both shapes are covered here, because fixing only the throw (what the issue
// literally asked for) would have left the real hole open.
//
// The contract that must NOT change: recordAudit never throws. It is called
// AFTER the mutation it records has already committed, so a raising audit write
// would turn a successful admin action into an error the admin cannot act on.
const insert = vi.hoisted(() =>
  vi.fn(async (): Promise<{ error: { message: string } | null }> => ({ error: null })),
);
const from = vi.hoisted(() => vi.fn(() => ({ insert })));
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _text: string): Promise<void> => {}),
);
const logError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert }));
vi.mock("@/lib/log", () => ({ log: { error: logError, warn: vi.fn(), info: vi.fn() } }));

import { recordAudit, AUDIT_WRITE_FAILED_KEY } from "./audit";

const entry = {
  orgId: "o1",
  actorId: "admin1",
  action: "role.set" as const,
  targetId: "u2",
  details: { role: "manager" },
};

beforeEach(() => {
  vi.clearAllMocks();
  insert.mockResolvedValue({ error: null });
});

describe("recordAudit", () => {
  it("writes the entry and stays silent when the insert succeeds", async () => {
    await recordAudit(entry);
    expect(from).toHaveBeenCalledWith("audit_log");
    expect(insert).toHaveBeenCalledTimes(1);
    // A healthy write must not page anyone.
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  // THE REAL FAILURE PATH. This is what a schema/RLS break looks like from here:
  // no exception, just an error object nobody read.
  it("reports a RETURNED insert error, the shape that actually happens", async () => {
    insert.mockResolvedValueOnce({
      error: { message: 'column "details" of relation "audit_log" does not exist' },
    });

    await recordAudit(entry);

    expect(logError).toHaveBeenCalledTimes(1);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldown, text] = sendThrottledAlert.mock.calls[0];
    expect(key).toBe(AUDIT_WRITE_FAILED_KEY);
    expect(cooldown).toBeGreaterThan(0);
    // Read on a phone mid-incident: it must name Slate and say what stopped.
    expect(text).toMatch(/^Slate:/);
    expect(text).toMatch(/audit/i);
    // It must name the action whose record was lost, so the reader knows the
    // blast radius rather than just "something failed".
    expect(text).toContain("role.set");
  });

  it("reports a THROWN insert error too", async () => {
    insert.mockRejectedValueOnce(new Error("connection reset"));

    await recordAudit(entry);

    expect(logError).toHaveBeenCalledTimes(1);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
  });

  it("never throws on a returned error, so the recorded operation still succeeds", async () => {
    insert.mockResolvedValueOnce({ error: { message: "permission denied" } });
    await expect(recordAudit(entry)).resolves.toBeUndefined();
  });

  it("never throws on a thrown error", async () => {
    insert.mockRejectedValueOnce(new Error("boom"));
    await expect(recordAudit(entry)).resolves.toBeUndefined();
  });

  // The alert writes to alert_state through the same database that just failed,
  // so it can fail too. A monitoring failure must not become an admin-facing
  // failure, and must not be silent either.
  it("survives its own alert failing, and logs that separately", async () => {
    insert.mockResolvedValueOnce({ error: { message: "permission denied" } });
    sendThrottledAlert.mockRejectedValueOnce(new Error("alert_state unreachable"));

    await expect(recordAudit(entry)).resolves.toBeUndefined();
    // Once for the audit failure, once for the alert that could not be sent.
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it("does not put a raw database error in the alert text (#1135)", async () => {
    // A postgres error can arrive as a multi-line body. The alert carries a short
    // human reason; the full text belongs in the log.
    insert.mockResolvedValueOnce({
      error: {
        message:
          'ERROR:  null value in column "actor_id" violates not-null constraint\nDETAIL:  Failing row contains (1, null, ...).\nCONTEXT:  SQL statement "insert into audit_log"',
      },
    });

    await recordAudit(entry);

    const text = sendThrottledAlert.mock.calls[0][2];
    // The contract the shared helper actually gives: collapsed to ONE line and
    // truncated on a word boundary. A postgres section label surviving as the
    // final token is the truncation marker, not a mid-word cut (#1133), so what
    // matters is that the BODY does not come along.
    expect(text).not.toContain("\n");
    expect(text).not.toContain("Failing row contains");
    expect(text).not.toContain("SQL statement");
    expect(text.length).toBeLessThan(400);
  });
});
