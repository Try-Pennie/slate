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
  // The error shape PostgREST really returns: a SQLSTATE `code`, the message, and
  // `details` carrying the offending key on a constraint rejection.
  vi.fn(
    async (): Promise<{ error: { code?: string; message: string; details?: string } | null }> => ({ error: null }),
  ),
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
  targetUserId: "u2",
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
    // Read on a phone mid-incident: it opens with what stopped, not with a
    // "Slate:" label repeating the Slack app name above it.
    expect(text).not.toMatch(/^\s*Slate\b/i);
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

  /**
   * #1223: the page may claim only what the check measured.
   *
   * In #1220 the audit_log schema and grants were both fine and the CALLER was
   * wrong (an ooo_requests id passed into target_id, which references users), so
   * advice to check schema and grants sent the investigation to the wrong place.
   * Only the six ooo.* actions were affected, so "further audit writes are likely
   * failing too" was false as well.
   *
   * The error fixtures below are MEASURED from Postgres, not invented: a
   * foreign-key rejection on this shape answers SQLSTATE 23503 with the constraint
   * named in the message and the offending key in DETAIL (probed 2026-08-03 on the
   * real project against temp tables of the same shape).
   */
  describe("a foreign key rejection (#1223)", () => {
    const fkError = {
      code: "23503",
      message:
        'insert or update on table "audit_log" violates foreign key constraint "audit_log_target_id_fkey"',
      details: 'Key (target_id)=(0f0e1d2c-3b4a-5968-8776-655443322110) is not present in table "users".',
    };

    it("names the constraint that rejected the row", async () => {
      // The raw message is 96 characters, so the constraint name is exactly what a
      // length-budgeted reason drops. It has to survive.
      insert.mockResolvedValueOnce({ error: fkError });

      await recordAudit(entry);

      const text = sendThrottledAlert.mock.calls[0][2];
      expect(text).toContain("audit_log_target_id_fkey");
    });

    it("does not send the reader to the schema and grants", async () => {
      insert.mockResolvedValueOnce({ error: fkError });

      await recordAudit(entry);

      const text = sendThrottledAlert.mock.calls[0][2];
      expect(text).not.toMatch(/grants/i);
      expect(text).not.toMatch(/schema/i);
    });

    it("puts the rejected value in the log, since the alert says that is where it is", async () => {
      insert.mockResolvedValueOnce({ error: fkError });

      await recordAudit(entry);

      const fields = logError.mock.calls[0][1] as Record<string, unknown>;
      expect(JSON.stringify(fields)).toContain("0f0e1d2c-3b4a-5968-8776-655443322110");
      expect(fields.code).toBe("23503");
    });
  });

  it("does not claim other audit writes are failing, which nothing here measures", async () => {
    insert.mockResolvedValueOnce({ error: { code: "42501", message: "permission denied for table audit_log" } });

    await recordAudit(entry);

    const text = sendThrottledAlert.mock.calls[0][2];
    expect(text).not.toMatch(/further audit writes/i);
    expect(text).not.toMatch(/likely failing/i);
  });

  it("keeps the short reason for a failure that is not a constraint rejection", async () => {
    insert.mockResolvedValueOnce({ error: { code: "42501", message: "permission denied for table audit_log" } });

    await recordAudit(entry);

    const text = sendThrottledAlert.mock.calls[0][2];
    expect(text).toContain("permission denied for table audit_log");
    // No constraint to name, so it must not imply there was one, and there is no
    // "rejected value" to promise the reader either.
    expect(text).not.toMatch(/foreign key/i);
    expect(text).not.toMatch(/rejected value/i);
    expect(text).toMatch(/full error is in the Worker logs/);
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
