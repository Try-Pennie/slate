import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Type only, so it is erased and cannot pull the real module in ahead of the mocks.
import type { TwilioSyncResult } from "@/lib/twilio/sync";

// Denial branches for the two escalation-sensitive admin server actions (#676).
// setUserRole composes canSetRole / isSelfDemotion / canChangeRole; the role
// helpers are unit-tested on their own, so this pins that the action WIRES them
// as gates (rejects and never writes) rather than re-testing the predicates.
// startImpersonation's admin-floor and role-ceiling (#588) guards are pinned the
// same way. The real role helpers are exercised; only auth, DB, cookies, redirect
// and audit are mocked.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireManager: vi.fn(),
  requireSuperAdmin: vi.fn(),
  realCurrentUser: vi.fn(),
  currentUser: vi.fn(),
}));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const revalidatePath = vi.hoisted(() => vi.fn());
const cookieStore = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }));
// Typed with its ENTRY, so a test can read back what was recorded. Untyped, the
// mock's calls are empty tuples and `calls.at(-1)?.[0]` does not typecheck, which
// is how "it was called" became the only assertion anybody wrote about the trail.
const recordAudit = vi.hoisted(() =>
  vi.fn(async (_entry: Record<string, unknown>) => {}),
);

const emit = vi.hoisted(() => ({
  // #1076: the outcome is what the admin is shown, so the mock has to be able to
  // return each one rather than resolving void.
  resendDelivery: vi.fn(async (): Promise<string> => "sent"),
  replayDeadLetteredDeliveries: vi.fn(async () => 0),
}));
const offboarding = vi.hoisted(() => ({
  applyLifecycleByUserId: vi.fn(async () => ({ status: "applied", userId: "u2", deactivate: true })),
  applyLifecycleByEmail: vi.fn(),
}));
const bookable = vi.hoisted(() => ({
  applyBookableByUserId: vi.fn(
    async (): Promise<{ status: string; userId?: string; bookable?: boolean; reason?: string }> => ({
      status: "applied",
      userId: "u2",
      bookable: true,
    }),
  ),
  applyBookableByEmail: vi.fn(),
  writeBookable: vi.fn(async () => {}),
  BookableLookupError: class BookableLookupError extends Error {},
}));
const salesforce = vi.hoisted(() => ({
  syncSalesforceAgents: vi.fn(),
  AGENTS_SYNC_STREAK_KEY: "cron_agents_failures",
}));
// #2071: the button runs the whole hourly job through this, under its lock.
const rosterSync = vi.hoisted(() => ({ runRosterSync: vi.fn() }));
/**
 * A finished run with the counts the banner reads, all zero unless overridden.
 *
 * `twilio` defaults to a healthy read that changed nothing (#2097). It is a
 * discriminated pair rather than a bag of counts, because a Twilio read that FAILED
 * and one that found nobody tagged are different facts and the banner has to say
 * different things about them.
 */
// TYPED as the real result, so a field added to `TwilioSyncResult` fails the build
// here rather than at run time. It was a bag of unknowns, and #2098's four new
// fields turned every banner test into "Cannot read properties of undefined",
// which says nothing about which fixture is short (L52).
const twilioOk = (over: Partial<TwilioSyncResult> = {}) => ({
  ok: true as const,
  result: {
    workers: 142,
    addresses: 140,
    turnedOff: [],
    turnedBackOn: [],
    reactivationRefused: [],
  reactivationDeferred: [],
    markedWithNoWorker: [],
    coverageSweeps: [],
    coverageSweepFailures: 0,
    tiersChanged: [],
    backendChanged: [],
    redistributeTagLanded: [],
    redistributeTagCleared: [],
    withoutWorker: [],
    attributeWriteFailures: 0,
    corruptAttributes: 0,
    noEmail: 0,
    unmappedTags: [],
    flipFailures: 0,
    demotionStamped: [],
    demotionSwept: [],
    demotionCleared: [],
    demotionSweeps: [],
    demotionSweepFailures: 0,
    demotionWriteFailures: 0,
    demotionEvalFailures: 0,
    demotionSwitchUnreadable: false,
    ...over,
  } satisfies TwilioSyncResult,
});
const syncOutcome = (over: Record<string, unknown> = {}, twilio: unknown = twilioOk()) => ({
  hoursApplied: 0,
  emptyBuckets: [],
  emptyBucketsAggregated: false,
  twilio,
  sync: {
    updated: 0,
    inserted: 0,
    deactivated: 0,
    createdUntiered: 0,
    salesNotBookableUnexplained: 0,
    bookableFlipped: [],
    bookablePending: [],
    bookableHeldByTwilio: [],
    bookableDeferredToNextRun: [],
    managersCreated: 0,
    managersLinked: 0,
    managersUnlinked: 0,
    managersUnresolved: 0,
    managersAmbiguous: 0,
    managerNamesAmbiguous: 0,
    managersPromoted: 0,
    rosterRowsReconciled: 0,
    rosterUnconfirmedInactive: 0,
    rosterUnconfirmedUnmatched: 0,
    rosterUnconfirmedAbsent: 0,
    rosterUnconfirmedBookable: [],
    ...over,
  },
});
const streak = vi.hoisted(() => ({
  clearFailureStreak: vi.fn(async () => {}),
  recordFailureStreak: vi.fn(async () => 1),
  recordConsecutiveStreak: vi.fn(async () => 1),
}));
const rateLimit = vi.hoisted(() => ({
  allowRequest: vi.fn(async () => true),
}));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "claim" as string | null),
  releaseLock: vi.fn(async () => {}),
}));

const dbState = vi.hoisted(() => ({
  single: null as unknown,
  singleError: null as { message: string } | null,
  insertError: null as { message: string } | null,
  count: 0,
  countError: null as { message: string } | null,
  /**
   * Per TABLE read seams (#1649). The single `singleError` above fails EVERY
   * read at once, which cannot tell "this action refuses when its authorization
   * read fails" from "this action refuses when anything fails": the assertion
   * would pass on a version that only guarded a different read. Each action here
   * reads at most one row per table, so the table name is a sufficient key, and a
   * test can break exactly one read and leave its neighbours healthy.
   */
  rowsByTable: {} as Record<string, unknown>,
  errorByTable: {} as Record<string, { message: string } | undefined>,
  /**
   * The RPC behind a schedule write. `null` means "report back the number of
   * rules you were handed", which is what a working database does; a test that
   * wants the count check to FAIL sets a number here instead.
   */
  rpcWritten: null as number | null,
  rpcError: null as { message: string } | null,
  /** What an `insert(...).select(...).single()` returns, and its error, kept
   *  apart from `single`/`rowsByTable` so a create's RETURNED row cannot be
   *  confused with a read of the same table (#1930). */
  insertReturns: null as unknown,
  insertReturnError: null as { message: string; code?: string } | null,
  /**
   * What an `update(...).eq(...)` resolves its `error` to (#2379).
   *
   * It resolved `{}` before, so every write in every test was a write that could
   * only succeed, and a guard asserting an action refuses a REFUSED write could
   * not be written at all. supabase-js does not throw on a refused statement; it
   * resolves `{ error }`, which is exactly why these were swallowed.
   */
  updateError: null as { message: string; code?: string } | null,
}));
const updateEq = vi.hoisted(() => vi.fn(async () => ({ error: dbState.updateError })));
const update = vi.hoisted(() =>
  vi.fn((_patch: Record<string, unknown> = {}) => ({ eq: updateEq })),
);
/**
 * An insert that is BOTH awaitable and chainable (#1930).
 *
 * Most callers `await db.from(t).insert(rows)` and read `{ error }`.
 * `createBucket` does `.insert(row).select("id").single()`, which needs a
 * builder back. A promise-only fake made that call throw "select is not a
 * function", which is a fixture failure wearing the costume of a code defect.
 */
const insert = vi.hoisted(() =>
  vi.fn((_rows: unknown) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      single: async () =>
        dbState.insertReturnError
          ? { data: null, error: dbState.insertReturnError }
          : { data: dbState.insertReturns, error: null },
      then: (resolve: (v: { error: unknown }) => unknown) =>
        Promise.resolve({ error: dbState.insertError }).then(resolve),
    };
    chain.maybeSingle = chain.single;
    return chain;
  }),
);
const upsert = vi.hoisted(() =>
  vi.fn(async (_rows: unknown, _opts?: { onConflict: string }) => ({})),
);
const rpc = vi.hoisted(() =>
  vi.fn(async (_name: string, args?: { p_rules?: unknown[]; p_user_ids?: unknown[] }) => ({
    data: dbState.rpcError
      ? null
      : (dbState.rpcWritten ??
        // What a working database reports back: the number of rows it landed.
        // `replace_bucket_members` inserts DISTINCT (#1930), so the fake
        // deduplicates too, or a test posting one id twice would see a count
        // mismatch the real function does not produce.
        (args?.p_user_ids ? new Set(args.p_user_ids).size : undefined) ??
        args?.p_rules?.length ??
        0),
    error: dbState.rpcError,
  })),
);

const from = vi.hoisted(() =>
  vi.fn((_table: string) => {
    // A per-table seam wins over the shared one, so a test can fail ONE read.
    // Falls through to `single` / `singleError` when the table is not registered,
    // which is what keeps every test written before #1649 working unchanged.
    const readOne = async () => {
      const err = dbState.errorByTable[_table];
      if (err) return { data: null, error: err };
      if (Object.hasOwn(dbState.rowsByTable, _table)) {
        return { data: dbState.rowsByTable[_table], error: null };
      }
      return { data: dbState.singleError ? null : dbState.single, error: dbState.singleError };
    };
    const q: Record<string, unknown> = {
      select: vi.fn(() => q),
      eq: vi.fn(() => q),
      in: vi.fn(async () => ({
        count: dbState.countError ? null : dbState.count,
        error: dbState.countError,
      })),
      maybeSingle: vi.fn(readOne),
      single: vi.fn(readOne),
      limit: vi.fn(() => q),
      // The primary webhook endpoint read orders by age (#4381).
      order: vi.fn(() => q),
      // A LIST read is awaited straight off the chain with no terminal, so the
      // builder itself has to be thenable. Without this the awaited value is the
      // builder, `unwrap` sees no error and no data, and a failed read arrives as
      // an EMPTY LIST: exactly the swallow #1629 removed, reintroduced inside the
      // test double, where it would have made the guard pass on the bug (L143).
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          // A table seeded with one row object still answers a LIST read as a list,
          // as PostgREST does (#4381: the test send reads every endpoint's url).
          data: dbState.errorByTable[_table]
            ? null
            : [dbState.rowsByTable[_table] ?? []].flat(),
          error: dbState.errorByTable[_table] ?? null,
        }).then(resolve),
      update,
      insert,
      upsert,
    };
    return q;
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from, rpc }) }));
const schedule = vi.hoisted(() => ({
  ensureDefaultSchedules: vi.fn(async () => 0),
}));
vi.mock("@/lib/schedule", () => schedule);
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/webhooks/emit", () => emit);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/offboarding/service", () => offboarding);
vi.mock("@/lib/bookable/service", () => bookable);
vi.mock("@/lib/salesforce/sync", () => salesforce);
vi.mock("@/lib/salesforce/run-roster-sync", () => rosterSync);
vi.mock("@/lib/notify/streak", () => streak);
// #1922: the booker copy write, seamed so the redirect TARGET can be asserted
// without driving the whole event-type store through the table fake. What is
// under test here is where the action sends you, not what it wrote.
const eventTypeStore = vi.hoisted(() => ({
  updateEventType: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/lib/availability/event-type-store", () => eventTypeStore);

import { EVENT_TYPE_DEFAULTS } from "@/lib/booking/event-type-defaults";
import {
  grantStaffAccess,
  setUserRole,
  startImpersonation,
  stopImpersonation,
  endDroppedImpersonation,
  resendWebhookDelivery,
  replayFailedWebhooks,
  setWebhookEndpoint,
  setMonitorSettings,
  setVolumeRampEnd,
  setUserLifecycle,
  setBookable,
  syncSalesforceNow,
  setWorkingHours,
  setOooCalendarId,
  useDefaultHours,
  setDefaultBucket,
  setDaysOffered,
  setEventDescription,
  createBucket,
  updateBucket,
  createEventType,
  sendTestWebhook,
} from "./actions";
import { ALERT_KEYS } from "@/lib/monitor/settings";
import {
  encodeImpersonationCookie,
  impersonationCookieOutcome,
} from "@/lib/auth/impersonation";

const admin = { id: "admin1", role: "admin", org_id: "o1" };

/**
 * A submitted form.
 *
 * An ARRAY value appends one entry per item, because that is what a repeated
 * field posts and what `form.getAll(...)` reads back (the bucket members and the
 * per day hours both rely on it). Joining them into one comma separated value,
 * which `fd.set` does to an array, produces a single member id of "u1,u2" that
 * every assertion downstream then agrees with (L52).
 */
function form(entries: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  // #3122: every guarded edit form carries the version it was drawn from. Present by
  // default so these cases stay about what they test; the refusals are pinned in the
  // per action suites.
  fd.set("loaded_updated_at", "2026-10-03T10:00:00.123456+00:00");
  // #3798: the event type editors carry their fields' loaded values instead.
  fd.set("loaded_description", "null");
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) for (const item of v) fd.append(k, item);
    else fd.set(k, v);
  }
  return fd;
}

// The "view as" cookie is signed with the key impersonationSigningSecret reads (#3113).
afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv("SUPABASE_SECRET_KEY", "test-signing-secret");
  // The sign-in domain fails closed when unset (#3083), as production carries it.
  vi.stubEnv("GOOGLE_HOSTED_DOMAIN", "trypennie.com");
  vi.clearAllMocks();
  dbState.single = null;
  dbState.singleError = null;
  dbState.insertError = null;
  dbState.insertReturns = null;
  dbState.insertReturnError = null;
  dbState.updateError = null;
  dbState.count = 0;
  dbState.countError = null;
  dbState.rowsByTable = {};
  dbState.errorByTable = {};
  dbState.rpcWritten = null;
  dbState.rpcError = null;
  locks.acquireLock.mockResolvedValue("claim");
});

describe("setUserRole denial branches", () => {
  it("rejects a non-admin caller and never touches the DB", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setUserRole(form({ user_id: "u2", role: "agent" }))).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  // #2385: each of these REFUSALS now travels back to the agent's own page as a
  // sentence, where the page draws it. They used to throw, and Next replaces a
  // thrown message in production, so every one of them arrived as the generic
  // error boundary saying it could not tell whether the change had gone through.
  // "Cannot remove the last admin" had never been read by anybody.
  //
  // Asserted on the redirect TARGET and on the SENTENCE, never on the fact of a
  // redirect: a test that only checks a redirect happened passes on every wrong
  // target and on a refusal that says nothing (L63).
  /** Where the action sent the caller, decoded, from the thrown NEXT_REDIRECT. */
  const refusalOf = async (run: () => Promise<unknown>): Promise<string> => {
    await run().catch(() => {});
    const call = redirect.mock.calls.at(-1);
    return call ? decodeURIComponent(String(call[0])) : "(no redirect)";
  };

  it("refuses on the page when a regular admin tries to grant super_admin, and does not write", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "agent" };
    const to = await refusalOf(() => setUserRole(form({ user_id: "u2", role: "super_admin" })));
    expect(to).toMatch(/^\/admin\/agents\/u2\?error=/);
    expect(to).toMatch(/cannot set somebody to/i);
    expect(update).not.toHaveBeenCalled();
  });

  // #4205: a coordinator is never bookable (users_coordinator_never_bookable), so the
  // write would fail as a database refusal. Said on the page instead, beside the same
  // change admitted for an advisor who is out of the pool.
  it("refuses on the page to make a bookable advisor a coordinator, and does not write", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "agent", bookable: true };
    const to = await refusalOf(() => setUserRole(form({ user_id: "u2", role: "coordinator" })));
    expect(to).toMatch(/^\/admin\/agents\/u2\?error=/);
    expect(to).toMatch(/booking pool/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("makes an advisor who is out of the pool a coordinator", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "agent", bookable: false };
    dbState.count = 5;
    await setUserRole(form({ user_id: "u2", role: "coordinator" })).catch(() => {});
    expect(update).toHaveBeenCalledWith({ role: "coordinator" });
  });

  it("refuses on the page when an admin demotes themselves, and does not write", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "admin" };
    const to = await refusalOf(() => setUserRole(form({ user_id: admin.id, role: "agent" })));
    expect(to).toMatch(new RegExp(`^/admin/agents/${admin.id}\\?error=`));
    expect(to).toMatch(/your own admin access/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses on the page when it would remove the last admin, and does not write", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "admin" };
    dbState.count = 1;
    const to = await refusalOf(() => setUserRole(form({ user_id: "u2", role: "agent" })));
    expect(to).toMatch(/^\/admin\/agents\/u2\?error=/);
    expect(to).toMatch(/last admin/i);
    expect(update).not.toHaveBeenCalled();
  });

  // #1165: the admin count ignored `error`, so a FAILED read scored as count 0
  // and the refusal claimed "Cannot remove the last admin", a fact the check
  // never measured (L11: distinct causes get distinct messages). Refusing is the
  // right direction (fail closed), but the operator must be told the count could
  // not be read, not handed a false claim about the roster.
  it("refuses with a could-not-verify message, not a last-admin claim, when the count read fails", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "admin" };
    dbState.count = 5; // plenty of admins; only the READ is broken
    dbState.countError = { message: "permission denied for table users" };

    const to = await refusalOf(() => setUserRole(form({ user_id: "u2", role: "agent" })));

    expect(to).toMatch(/^\/admin\/agents\/u2\?error=/);
    expect(to).toMatch(/could not (be )?verif/i);
    expect(to).not.toMatch(/last admin/i);
    expect(update).not.toHaveBeenCalled();
  });

  // #2379: the revocation twin of the kill switch. supabase-js does not throw on
  // a refused statement, so the action awaited the update, read nothing off it,
  // and recorded `role.set { from: "admin", to: "agent" }` for a role that never
  // changed. An admin removing a departing admin's access is told it is done, the
  // trail says it is done, and the person keeps admin (L12, L529).
  //
  // #2385: this one still THROWS while the four guards above it redirect, and
  // the split is the rule rather than an oversight. Those four are sentences
  // about the REQUEST, which the reader can act on. A write Postgres refused is a
  // sentence about the system: no role the admin picks changes it, so the
  // boundary saying the state is unknown is the honest screen and the detail goes
  // to the log.
  it("refuses when the database declines the role write, with no audit entry", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "agent" };
    dbState.count = 5; // plenty of admins; only the WRITE is refused
    dbState.updateError = { message: "permission denied for table users", code: "42501" };

    const err = await setUserRole(form({ user_id: "u2", role: "manager" })).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/role/i);
    expect(update).toHaveBeenCalledWith({ role: "manager" });
    expect(recordAudit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("startImpersonation denial branches", () => {
  it("rejects a non-admin caller before any lookup or cookie is set", async () => {
    auth.realCurrentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    await expect(startImpersonation(form({ email: "someone@x.com" }))).rejects.toThrow(
      /not authorized/i,
    );
    expect(from).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("refuses to impersonate a peer of equal rank (role ceiling), setting no cookie", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    dbState.single = { id: "peer1", role: "admin" };
    await expect(
      startImpersonation(form({ email: "peer@x.com" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    const target = redirect.mock.calls.find(([u]) => String(u).includes("imp_error"));
    expect(target).toBeTruthy();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  // #1795: the enforcement point already refuses a departed target (auth.ts
  // filters the impersonation lookup on deactivated_at, "never act as a departed
  // user"), so this was never an escalation. What it WAS: a cookie got set, an
  // `impersonate.start` audit row got written, and the next request silently
  // reverted the admin to themselves. So the audit log recorded a session that
  // never existed and the admin got a round trip with nothing said. Refusing here
  // gives the cause its own message (L11) and stops the false audit row.
  it("refuses an offboarded target by name, setting no cookie", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    dbState.single = {
      id: "gone1",
      role: "agent",
      deactivated_at: "2026-01-01T00:00:00Z",
    };
    await expect(
      startImpersonation(form({ email: "gone@x.com" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    const target = redirect.mock.calls.find(([u]) => String(u).includes("imp_error"));
    expect(target).toBeTruthy();
    expect(decodeURIComponent(String(target![0]))).toMatch(/offboarded/i);
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("still lets an active target through, so the check is not refusing everyone", async () => {
    // The control for the case above (L1): a refusal that fires on every target
    // would satisfy the assertion there and break the feature.
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    dbState.single = { id: "agent1", role: "agent", deactivated_at: null };
    await expect(startImpersonation(form({ email: "agent@x.com" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/me/,
    );
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
  });

  // #653: a "view as" session must be bounded so a forgotten one auto-ends.
  it("sets a bounded, timestamped cookie on the success path", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    dbState.single = { id: "agent1", role: "agent" };
    await expect(startImpersonation(form({ email: "agent@x.com" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/me/,
    );
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
    const [name, value, opts] = cookieStore.set.mock.calls[0];
    expect(name).toBe("slate_impersonate");
    // Value carries the target id, an issued-at timestamp and a signature
    // (id.timestamp.mac, #3113), and verifies for THIS admin under the key.
    expect(value).toMatch(/^agent1\.\d+\.[A-Za-z0-9_-]+$/);
    const verdict = await impersonationCookieOutcome({
      realRole: "admin",
      realId: admin.id,
      cookie: value,
      nowMs: Date.now(),
      secret: "test-signing-secret",
    });
    expect(verdict).toEqual({ kind: "candidate", targetId: "agent1" });
    // A finite maxAge bounds the cookie's own lifetime as defense in depth.
    expect(opts.maxAge).toBeGreaterThan(0);
    expect(Number.isFinite(opts.maxAge)).toBe(true);
  });

  // #3113: the start is audited BEFORE the cookie exists, so no session can be
  // live that the trail does not record starting.
  it("records impersonate.start before it sets the cookie", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    dbState.single = { id: "agent1", role: "agent" };
    await expect(startImpersonation(form({ email: "agent@x.com" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/me/,
    );
    const startCall = recordAudit.mock.calls.findIndex(
      ([e]) => (e as { action: string }).action === "impersonate.start",
    );
    expect(startCall).toBeGreaterThanOrEqual(0);
    expect(recordAudit.mock.invocationCallOrder[startCall]).toBeLessThan(
      cookieStore.set.mock.invocationCallOrder[0],
    );
  });

  // The cookie now carries "id.timestamp" (#653); the stop audit must record the
  // clean target id, not the encoded value.
  it("records the decoded target id in the stop audit, not the raw cookie", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    cookieStore.get.mockReturnValueOnce({
      value: await encodeImpersonationCookie({
        issuerId: admin.id,
        targetId: "agent1",
        issuedAtMs: 1_700_000_000_000,
        secret: "test-signing-secret",
      }),
    });
    await expect(stopImpersonation()).rejects.toThrow(/NEXT_REDIRECT:\/admin/);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "impersonate.stop", targetUserId: "agent1" }),
    );
  });
});

// #652: the page auto-clears a dropped session in the background. This action
// deletes the cookie and records the auto-end WITHOUT redirecting, so the notice
// stays visible on the current page.
describe("endDroppedImpersonation (#652)", () => {
  it("clears the cookie and audits the auto-end with the reason and decoded target", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    cookieStore.get.mockReturnValueOnce({
      value: await encodeImpersonationCookie({
        issuerId: admin.id,
        targetId: "agent1",
        issuedAtMs: 1_700_000_000_000,
        secret: "test-signing-secret",
      }),
    });
    await endDroppedImpersonation("expired");
    expect(cookieStore.delete).toHaveBeenCalledWith("slate_impersonate");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "impersonate.ended",
        targetUserId: "agent1",
        details: expect.objectContaining({ reason: "expired" }),
      }),
    );
    expect(redirect).not.toHaveBeenCalled();
  });

  it("is a safe no-op when there is no cookie (does not audit)", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    cookieStore.get.mockReturnValueOnce(undefined);
    await endDroppedImpersonation("expired");
    expect(cookieStore.delete).toHaveBeenCalledWith("slate_impersonate");
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

// #674: the SubmitButton's client-side disable (#630) can't stop a flaky-network
// retry or a racing request from firing these non-idempotent re-delivery actions
// twice. A DB-backed claim (acquireLock) makes a duplicate within the window a
// no-op regardless of the client.
describe("webhook re-delivery duplicate guard", () => {
  beforeEach(() => {
    auth.requireAdmin.mockResolvedValue(admin);
  });

  it("resendWebhookDelivery re-fires when it wins the claim", async () => {
    await expect(resendWebhookDelivery(form({ delivery_id: "d1" }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(locks.acquireLock).toHaveBeenCalledWith(
      "webhook_resend:o1:d1",
      expect.any(Number),
    );
    expect(emit.resendDelivery).toHaveBeenCalledWith("d1", "o1");
  });

  // #1076: the outcome reaches the admin, not just the server logs. Every one of
  // these used to re-render the log unchanged, so a refusal looked exactly like a
  // success and the button looked broken.
  //
  // #2384: and it reaches the WEBHOOKS page, which is the page the button is on
  // and the only page that reads `?resend=`. It named `/admin`, the Overview,
  // which declares no search params, so every sentence #1076 wrote was encoded,
  // attached to a URL and thrown away while the admin was moved off the delivery
  // log they pressed it in. The target is asserted here, not just the parameter:
  // a redirect carrying the right value to a page that cannot read it is the
  // defect, and it looks identical to a working one from inside the action (L63).
  it.each(["sent", "payload-erased", "suppressed", "not-found"] as const)(
    "resendWebhookDelivery reports %s back on the webhooks page",
    async (result) => {
      emit.resendDelivery.mockResolvedValueOnce(result);
      await expect(resendWebhookDelivery(form({ delivery_id: "d1" }))).rejects.toThrow(
        `NEXT_REDIRECT:/admin/webhooks?resend=${encodeURIComponent(result)}`,
      );
    },
  );

  it("resendWebhookDelivery tells the admin when a duplicate lost the claim", async () => {
    // Not a silent no-op any more. A second press that says nothing is
    // indistinguishable from a broken button, and the truthful thing to say is that
    // the receiver already has it.
    locks.acquireLock.mockResolvedValueOnce(null);
    await expect(resendWebhookDelivery(form({ delivery_id: "d1" }))).rejects.toThrow(
      "NEXT_REDIRECT:/admin/webhooks?resend=deduped",
    );
    expect(emit.resendDelivery).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not release the claim on success, so a later retry stays deduped", async () => {
    await expect(resendWebhookDelivery(form({ delivery_id: "d1" }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(locks.releaseLock).not.toHaveBeenCalled();
  });

  it("replayFailedWebhooks replays when it wins the claim, keyed by org and window", async () => {
    emit.replayDeadLetteredDeliveries.mockResolvedValueOnce(3);
    await expect(replayFailedWebhooks(form({ hours: "24" }))).rejects.toThrow(
      "NEXT_REDIRECT:/admin/webhooks?replay=3",
    );
    expect(locks.acquireLock).toHaveBeenCalledWith(
      "webhook_replay:o1:24",
      expect.any(Number),
    );
    expect(emit.replayDeadLetteredDeliveries).toHaveBeenCalledTimes(1);
  });

  // #2384: the batch control said NOTHING on either ending. Success revalidated
  // the Overview and returned void; a duplicate press inside the five minute
  // window returned in silence. So the one thing that re-fires a receiver's whole
  // backlog after an outage was indistinguishable from a broken button on exactly
  // the press somebody makes when they are unsure the first one worked.
  it("replayFailedWebhooks says how many it queued, on the page the button is on", async () => {
    emit.replayDeadLetteredDeliveries.mockResolvedValueOnce(0);
    await expect(replayFailedWebhooks(form({ hours: "24" }))).rejects.toThrow(
      "NEXT_REDIRECT:/admin/webhooks?replay=0",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/admin/webhooks");
  });

  it("replayFailedWebhooks tells the admin when a duplicate lost the claim", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    await expect(replayFailedWebhooks(form({ hours: "24" }))).rejects.toThrow(
      "NEXT_REDIRECT:/admin/webhooks?replay=deduped",
    );
    expect(emit.replayDeadLetteredDeliveries).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// #600: the Regal API key is the ONLY thing authenticating Slate's booking events to
// Regal. The admin form used to round-trip it as an input's defaultValue and treat a
// blank field as "set it to null", so an admin who edited the webhook URL without
// retyping the key silently wiped it, and every booking event afterwards posted an
// empty Authorization header. Blank must now mean "keep what is there".
describe("setWebhookEndpoint key handling (#600)", () => {
  it("does NOT wipe the stored key when the field is left blank", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { id: "ep1" };

    // #2384: a successful save redirects now, so the call rejects with the
    // NEXT_REDIRECT the mocked `redirect` throws. It used to return void and
    // revalidate the Overview, so the page the admin was looking at redrew with
    // the URL and key marker it showed before they pressed Save.
    await expect(
      setWebhookEndpoint(
        form({ url: "https://events.regalvoice.com/events", format: "regal", auth_header: "" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/admin/webhooks?ok=webhook-endpoint");

    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    // The whole bug: `auth_header: null` here takes Regal offline silently.
    expect(patch).not.toHaveProperty("auth_header");
    expect(patch.url).toBe("https://events.regalvoice.com/events");
    expect(patch.format).toBe("regal");
  });

  it("treats a whitespace-only field as blank, not as a new key", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { id: "ep1" };

    await expect(
      setWebhookEndpoint(
        form({ url: "https://events.regalvoice.com/events", format: "regal", auth_header: "   " }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("auth_header");
  });

  // #3091: the key is a Worker secret now, so the form writes neither credential
  // column, even when a request carries one. Changing the key is a deploy step.
  it("never writes the key or the signing secret, even when a value is posted", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { id: "ep1", url: "https://events.regalvoice.com/events", format: "regal" };

    await expect(
      setWebhookEndpoint(
        form({
          url: "https://events.regalvoice.com/events",
          format: "regal",
          auth_header: "fixture-posted-key",
          secret: "fixture-posted-secret",
        }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("auth_header");
    expect(patch).not.toHaveProperty("secret");
  });

  it("creates a new endpoint with no credential in the database", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = null;

    await expect(
      setWebhookEndpoint(
        form({ url: "https://events.regalvoice.com/events", format: "regal", auth_header: "fixture-posted-key" }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row).not.toHaveProperty("auth_header");
    // Never a generated value: minting one would put a credential back in the
    // table the move took them out of (the column is nullable since 0163).
    expect(row).not.toHaveProperty("secret");
  });
});

// #3089: where lead contact data is POSTed changed with no trace in the trail.
describe("webhook changes are audited after they happen (#3089)", () => {
  it("records the endpoint host and format before and after, never the path, query or a key", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { id: "ep1", url: "https://old.example.com/hook?token=abc", format: "generic" };

    await expect(
      setWebhookEndpoint(form({ url: "https://events.regalvoice.com/events?key=zzz", format: "regal" })),
    ).rejects.toThrow("NEXT_REDIRECT:/admin/webhooks?ok=webhook-endpoint");

    const entry = recordAudit.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(entry.action).toBe("webhook.endpoint_set");
    expect(entry.details).toEqual({
      host: { from: "old.example.com", to: "events.regalvoice.com" },
      format: { from: "generic", to: "regal" },
      key_changed: false,
    });
    expect(JSON.stringify(entry)).not.toMatch(/token|abc|zzz|\/hook|\/events/);
    // After the write, never before it.
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(recordAudit.mock.invocationCallOrder[0]);
  });

  it("records nothing when the write is refused", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { id: "ep1", url: "https://events.regalvoice.com/events", format: "regal" };
    dbState.updateError = { message: "permission denied" };

    await expect(
      setWebhookEndpoint(form({ url: "https://events.regalvoice.com/events", format: "regal" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("records a new endpoint with no host before it", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = null;
    await expect(
      setWebhookEndpoint(form({ url: "https://events.regalvoice.com/events", format: "regal" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    const entry = recordAudit.mock.calls.at(-1)?.[0] as { details: { host: { from: unknown } } };
    expect(entry.details.host.from).toBeNull();
  });

  it("records a resend with its outcome and the count sent", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    emit.resendDelivery.mockResolvedValueOnce("payload-erased");
    await expect(resendWebhookDelivery(form({ delivery_id: "d1" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook.resent",
        details: { delivery_id: "d1", result: "payload-erased", sent: 0 },
      }),
    );
  });

  it("records nothing for a deduped resend, which did nothing", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    locks.acquireLock.mockResolvedValueOnce(null);
    await expect(resendWebhookDelivery(form({ delivery_id: "d1" }))).rejects.toThrow(/deduped/);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("records a replay with its window and how many it queued", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    emit.replayDeadLetteredDeliveries.mockResolvedValueOnce(9);
    await expect(replayFailedWebhooks(form({ hours: "48" }))).rejects.toThrow(/replay=9/);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "webhook.replayed", details: { hours: 48, queued: 9 } }),
    );
  });
});

// #3089: the agent.* entries used to be written by the authorization guard, BEFORE
// the change ran and with no details, so a refused save read as an edit that
// happened. Each is now written after its change, with the value before and after.
describe("agent audits follow the change and carry before and after (#3089)", () => {
  beforeEach(() => {
    auth.requireManager.mockResolvedValue(admin);
  });

  it("an applied bookable flip records the value it moved from and to, after the write", async () => {
    dbState.single = { role: "agent" };
    bookable.applyBookableByUserId.mockResolvedValueOnce({ status: "applied", userId: "u2", bookable: true });
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(/bookable=on/);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent.bookable",
        targetUserId: "u2",
        details: { bookable: { from: false, to: true } },
      }),
    );
    expect(bookable.applyBookableByUserId.mock.invocationCallOrder[0]).toBeLessThan(
      recordAudit.mock.invocationCallOrder[0],
    );
  });

  it("a refused or unchanged bookable flip records nothing", async () => {
    dbState.single = { role: "agent" };
    bookable.applyBookableByUserId.mockResolvedValueOnce({
      status: "blocked",
      userId: "u2",
      reason: "google_unreachable",
    });
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(/blocked-gone/);
    bookable.applyBookableByUserId.mockResolvedValueOnce({ status: "noop", userId: "u2", bookable: true });
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(/bookable=on/);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("a deactivation records the state before and after, after the service ran", async () => {
    dbState.single = { role: "agent" };
    await setUserLifecycle(form({ user_id: "u2", action: "deactivate", coverage: "move" }));
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent.deactivate",
        details: { deactivated: { from: false, to: true }, moved_upcoming_bookings: true },
      }),
    );
    expect(offboarding.applyLifecycleByUserId.mock.invocationCallOrder[0]).toBeLessThan(
      recordAudit.mock.invocationCallOrder[0],
    );
  });

  it("a lifecycle noop records nothing", async () => {
    dbState.single = { role: "agent" };
    offboarding.applyLifecycleByUserId.mockResolvedValueOnce({ status: "noop", userId: "u2" } as never);
    await setUserLifecycle(form({ user_id: "u2", action: "deactivate" }));
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("an hours save records the week before and the week after, once the write landed", async () => {
    dbState.rowsByTable.users = { role: "agent" };
    dbState.rowsByTable.availability_schedules = {
      timezone: "America/Denver",
      availability_rules: [{ weekday: 2, start_minute: 600, end_minute: 960, id: "r2" }],
    };
    await expect(
      setWorkingHours(
        form({ user_id: "u2", timezone: "America/New_York", day_1: "on", start_1: "09:00", end_1: "17:00" }),
      ),
    ).rejects.toThrow(/ok=working-hours/);
    const entry = recordAudit.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(entry).toMatchObject({ action: "agent.hours", targetUserId: "u2" });
    expect(entry.details).toEqual({
      schedule: {
        from: { timezone: "America/Denver", rules: [{ weekday: 2, start_minute: 600, end_minute: 960 }] },
        to: { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 540, end_minute: 1020 }] },
      },
    });
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(recordAudit.mock.invocationCallOrder[0]);
  });

  it("an hours save the database refuses records nothing", async () => {
    dbState.rowsByTable.users = { role: "agent" };
    dbState.rowsByTable.availability_schedules = null;
    dbState.rpcError = { message: "permission denied" };
    await expect(
      setWorkingHours(
        form({ user_id: "u2", timezone: "America/New_York", day_1: "on", start_1: "09:00", end_1: "17:00" }),
      ),
    ).rejects.toThrow(/could not be saved/);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("an unreadable week before is recorded as unreadable, not as no hours, and the save still happens", async () => {
    dbState.rowsByTable.users = { role: "agent" };
    dbState.errorByTable.availability_schedules = { message: "deadlock detected" };
    await expect(
      setWorkingHours(
        form({ user_id: "u2", timezone: "America/New_York", day_1: "on", start_1: "09:00", end_1: "17:00" }),
      ),
    ).rejects.toThrow(/ok=working-hours/);
    const entry = recordAudit.mock.calls.at(-1)?.[0] as { details: { schedule: { from: unknown } } };
    expect(entry.details.schedule.from).toBe("unreadable");
  });

  // A client call that REJECTS (a network fault, rather than a returned error) must
  // not escape either: the read exists for the trail, never to gate the save.
  it("a before read that rejects still saves, and records the week before as unreadable", async () => {
    dbState.rowsByTable.users = { role: "agent" };
    const real = from.getMockImplementation()!;
    from.mockImplementation((table: string) =>
      table === "availability_schedules"
        ? ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  throw new Error("fetch failed");
                },
              }),
            }),
          } as unknown as ReturnType<typeof real>)
        : real(table),
    );
    try {
      await expect(
        setWorkingHours(
          form({ user_id: "u2", timezone: "America/New_York", day_1: "on", start_1: "09:00", end_1: "17:00" }),
        ),
      ).rejects.toThrow(/ok=working-hours/);
    } finally {
      from.mockImplementation(real);
    }
    expect(rpc).toHaveBeenCalledTimes(1);
    const entry = recordAudit.mock.calls.at(-1)?.[0] as { details: { schedule: { from: unknown } } };
    expect(entry.details.schedule.from).toBe("unreadable");
  });
});

// #1032: the endpoint URL receives every booking event (lead name, email, phone)
// plus the Regal API key Authorization header, so an http:// URL would send all
// of it in plaintext. Reject a non-https scheme before any write.
describe("setWebhookEndpoint URL scheme guard (#1032)", () => {
  it("rejects an http:// URL with an error redirect and writes nothing", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = null; // would be the insert path if it got that far

    await expect(
      setWebhookEndpoint(form({ url: "http://events.regalvoice.com/events", format: "regal" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // #2384: on the page that hosts the form, carrying the reason. It used to go
    // to `/admin?webhook_error=`, and the Overview reads neither the name nor the
    // value, so the refusal was destroyed and the admin was left believing the
    // `http://` URL they had typed was live. Nothing had been written.
    const to = decodeURIComponent(String(redirect.mock.calls.at(-1)?.[0]));
    expect(to).toMatch(/^\/admin\/webhooks\?error=/);
    expect(to).toMatch(/https/i);
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("accepts an https:// URL, inserts the endpoint, and confirms it on the page", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = null;

    await expect(
      setWebhookEndpoint(form({ url: "https://events.regalvoice.com/events", format: "regal" })),
    ).rejects.toThrow("NEXT_REDIRECT:/admin/webhooks?ok=webhook-endpoint");

    expect(insert).toHaveBeenCalledTimes(1);
  });
});

// #582: the monitor alert-settings save path (#571). The pure parser
// (parseMonitorSettingsForm) is unit-tested on its own; this pins that the action
// WIRES it correctly end to end (form parsing to full-row upsert to audit) so the
// red-team S1/S2 fixes can't quietly regress: a blank field must persist as
// explicit null (never 0), an out-of-range value must refuse to save, each row is
// written whole so clearing one field can't wipe a sibling, and the actor is
// stamped. The real parser runs; only auth, DB, audit and redirect are mocked.
// #2739: the day the booking ramp ended, which starts the low volume floors
// learning from Slate's own bookings. Its own action, confirmed on the page, and
// audited with the date before and after.
describe("setVolumeRampEnd (#2739)", () => {
  beforeEach(() => {
    auth.requireAdmin.mockResolvedValue(admin);
    dbState.rowsByTable.monitor_alert_config = { volume_ramp_end_on: "2026-10-05" };
  });

  const configWrite = () => upsert.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;

  it("stores the date, stamps the admin, audits before and after, and says it saved", async () => {
    await expect(setVolumeRampEnd(form({ intent: "set", ramp_end: "2026-10-12" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/alerts\?ok=volume-ramp-end-set#volume-learning/,
    );
    expect(configWrite()).toMatchObject({ id: 1, volume_ramp_end_on: "2026-10-12", updated_by: admin.id });
    expect(upsert.mock.calls.at(-1)?.[1]).toEqual({ onConflict: "id" });
    // Only its own columns: a ramp end save must never rewrite a floor or a switch,
    // and changing the date keeps the stored refit, which the lane replaces at once.
    expect(Object.keys(configWrite() ?? {}).sort()).toEqual(["id", "updated_at", "updated_by", "volume_ramp_end_on"]);
    expect(recordAudit.mock.calls.at(-1)?.[0]).toMatchObject({
      action: "monitor.volume_ramp_end",
      actorId: admin.id,
      details: { from: "2026-10-05", to: "2026-10-12" },
    });
  });

  it("clears the date and the stored refit together", async () => {
    await expect(setVolumeRampEnd(form({ intent: "clear" }))).rejects.toThrow(/ok=volume-ramp-end-cleared/);
    expect(configWrite()).toMatchObject({ volume_ramp_end_on: null, volume_learning: null });
    expect(recordAudit.mock.calls.at(-1)?.[0]).toMatchObject({ details: { from: "2026-10-05", to: null } });
  });

  it("refuses a set press with no date, and writes nothing", async () => {
    await expect(setVolumeRampEnd(form({ intent: "set", ramp_end: "" }))).rejects.toThrow(/\?error=.*&form=volume-ramp-end#volume-learning/);
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a refused write before the audit entry and the saved notice", async () => {
    upsert.mockResolvedValueOnce({ error: { message: "permission denied" } } as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(setVolumeRampEnd(form({ intent: "set", ramp_end: "2026-10-12" }))).rejects.toThrow(/\?error=/);
    log.mockRestore();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses when the current date cannot be read, rather than auditing a guessed one", async () => {
    dbState.errorByTable.monitor_alert_config = { message: "read timeout" };
    await expect(setVolumeRampEnd(form({ intent: "set", ramp_end: "2026-10-12" }))).rejects.toThrow(/read timeout|volume ramp end/);
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("setMonitorSettings save path (#582)", () => {
  beforeEach(() => {
    auth.requireAdmin.mockResolvedValue(admin);
  });

  // Every cooldown field plus floors and channels, all valid, as a baseline the
  // individual cases override one field at a time.
  function monitorForm(overrides: Record<string, string> = {}): FormData {
    const base: Record<string, string> = {
      floor_30: "5",
      floor_120: "20",
      // Ids, as the picker submits (#2438). A NAME here would be resolved against
      // Slack's channel list, which this file does not stand up, and refused.
      alerts_channel: "C0ALERTS01",
      info_channel: "C0INFO0001",
    };
    for (const k of ALERT_KEYS) base[`cooldown_${k}`] = "30";
    return form({ ...base, ...overrides });
  }

  function settingsUpsertPayload(): Record<string, unknown>[] {
    const call = upsert.mock.calls.find(([payload]) => Array.isArray(payload));
    return (call?.[0] ?? []) as Record<string, unknown>[];
  }

  function configUpsertPayload(): Record<string, unknown> {
    const call = upsert.mock.calls.find(([payload]) => !Array.isArray(payload));
    return (call?.[0] ?? {}) as Record<string, unknown>;
  }

  // S1: a blank field is "revert to fallback", which must be an explicit null so
  // the resolver falls through to the coded default. Writing 0 would instead pin a
  // real (broken) value: a 0-minute cooldown or a 0 low-volume floor.
  it("persists a blank field as explicit null, never 0", async () => {
    const key = ALERT_KEYS[0];
    await expect(
      setMonitorSettings(monitorForm({ [`cooldown_${key}`]: "", floor_30: "" })),
    ).rejects.toThrow(/NEXT_REDIRECT:\/admin\/alerts\?ok=alerts/);

    const rows = settingsUpsertPayload();
    const blankRow = rows.find((r) => r.key === key);
    expect(blankRow?.cooldown_min).toBeNull();
    expect(blankRow?.cooldown_min).not.toBe(0);
    // A sibling with a real value is untouched by the blank one.
    const otherRow = rows.find((r) => r.key === ALERT_KEYS[1]);
    expect(otherRow?.cooldown_min).toBe(30);

    const config = configUpsertPayload();
    expect(config.floor_30).toBeNull();
    expect(config.floor_30).not.toBe(0);
  });

  // S2: an out-of-range value is refused, not coerced. The action redirects to the
  // error page and must NOT write anything (a partial save would be worse).
  it("refuses an out-of-range value and writes nothing", async () => {
    const key = ALERT_KEYS[0];
    // 0 is below the 1-minute floor; the parser rejects it.
    await expect(
      setMonitorSettings(monitorForm({ [`cooldown_${key}`]: "0" })),
    ).rejects.toThrow(/NEXT_REDIRECT:\/admin\/alerts\?error=/);

    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // A full row is written per key (onConflict: "key"), each a complete object, so
  // saving one field can never blank a sibling column.
  it("upserts a complete row per key on the key conflict target", async () => {
    await expect(setMonitorSettings(monitorForm())).rejects.toThrow(/ok=alerts/);

    const settingsCall = upsert.mock.calls.find(([payload]) => Array.isArray(payload));
    expect(settingsCall).toBeTruthy();
    expect(settingsCall?.[1]).toEqual({ onConflict: "key" });

    const rows = settingsUpsertPayload();
    expect(rows).toHaveLength(ALERT_KEYS.length);
    for (const row of rows) {
      expect(row).toHaveProperty("key");
      expect(row).toHaveProperty("cooldown_min");
      expect(row).toHaveProperty("updated_at");
      expect(row).toHaveProperty("updated_by");
    }
    expect(rows.map((r) => r.key).sort()).toEqual([...ALERT_KEYS].sort());

    // The config row is a single upsert on id=1.
    const configCall = upsert.mock.calls.find(([payload]) => !Array.isArray(payload));
    expect(configCall?.[0]).toMatchObject({ id: 1 });
    expect(configCall?.[1]).toEqual({ onConflict: "id" });
  });

  // Dan, 2026-10-26: the below tier alert has no cooldown any more. A page opened
  // before that deploy still posts its old field, so the save must go through and
  // write no row for it, leaving whatever is stored alone rather than refusing.
  it("saves without the below tier cooldown, and passes over the field from a page opened before it went", async () => {
    await expect(
      setMonitorSettings(monitorForm({ cooldown_booking_below_lead_tier: "720" })),
    ).rejects.toThrow(/NEXT_REDIRECT:\/admin\/alerts\?ok=alerts/);

    const keys = settingsUpsertPayload().map((r) => r.key);
    expect(keys).not.toContain("booking_below_lead_tier");
    expect(keys).toHaveLength(ALERT_KEYS.length);
  });

  // The acting admin is stamped on both writes and in the audit trail.
  it("stamps updated_by with the acting admin and audits the change", async () => {
    await expect(setMonitorSettings(monitorForm())).rejects.toThrow(/ok=alerts/);

    const rows = settingsUpsertPayload();
    expect(rows.every((r) => r.updated_by === admin.id)).toBe(true);
    expect(configUpsertPayload().updated_by).toBe(admin.id);

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: admin.id,
        action: "monitor.settings",
      }),
    );
  });
});

// #278: the admin deactivate/reactivate action. The escalation guard
// (requireManageAgent) is unit-tested via its predicates elsewhere; here we pin
// the action-specific gates: a bad action is a no-op, deactivating YOURSELF is
// refused before any write (self-lockout), and a valid call reaches the service
// with the right direction and audits it.
describe("setUserLifecycle (#278)", () => {
  beforeEach(() => {
    auth.requireManager.mockResolvedValue(admin);
  });

  // #2124: the confirm asks whether to move the agent's upcoming bookings, and
  // the answer arrives as the pressed button's own value. These four are the
  // whole contract, and the asymmetry is the safety argument: only the explicit
  // "move" sweeps.
  it("sweeps when the admin pressed the move choice", async () => {
    dbState.single = { role: "agent" };
    await setUserLifecycle(form({ user_id: "u2", action: "deactivate", coverage: "move" }));
    expect(offboarding.applyLifecycleByUserId).toHaveBeenCalledWith("u2", "deactivate", {
      sweepCoverage: true,
    });
  });

  it("does not sweep when the admin pressed the leave choice", async () => {
    dbState.single = { role: "agent" };
    await setUserLifecycle(form({ user_id: "u2", action: "deactivate", coverage: "leave" }));
    expect(offboarding.applyLifecycleByUserId).toHaveBeenCalledWith("u2", "deactivate", {
      sweepCoverage: false,
    });
  });

  // A form carrying no answer must not move anybody's appointment: nobody asked,
  // and nothing on the screen would say it happened. The opposite mistake is
  // loud, since the agent is left deactivated holding bookings and the
  // inactive_agent_bookings monitor pages within the hour (L72).
  it("does not sweep when no choice was posted at all", async () => {
    dbState.single = { role: "agent" };
    await setUserLifecycle(form({ user_id: "u2", action: "deactivate" }));
    expect(offboarding.applyLifecycleByUserId).toHaveBeenCalledWith("u2", "deactivate", {
      sweepCoverage: false,
    });
  });

  it("does not sweep on a value it does not recognise", async () => {
    dbState.single = { role: "agent" };
    await setUserLifecycle(form({ user_id: "u2", action: "deactivate", coverage: "MOVE" }));
    expect(offboarding.applyLifecycleByUserId).toHaveBeenCalledWith("u2", "deactivate", {
      sweepCoverage: false,
    });
  });

  // The choice is still read after the authorization gate, never before it: a
  // caller who may not manage this agent must be refused whatever they asked for.
  it("refuses before reading the choice when the actor may not manage the target", async () => {
    // A target the admin does not strictly outrank, so the real escalation gate
    // refuses. Driven through the REAL guard rather than a mocked rejection, or
    // the test would prove only that a rejected promise rejects.
    dbState.single = { role: "super_admin" };
    await expect(
      setUserLifecycle(form({ user_id: "u2", action: "deactivate", coverage: "move" })),
    ).rejects.toThrow();
    expect(offboarding.applyLifecycleByUserId).not.toHaveBeenCalled();
  });

  it("ignores an unknown action without touching auth or the service", async () => {
    await setUserLifecycle(form({ user_id: "u2", action: "frobnicate" }));
    expect(auth.requireManager).not.toHaveBeenCalled();
    expect(offboarding.applyLifecycleByUserId).not.toHaveBeenCalled();
  });

  // #2385: the refusal reaches the person, on the page the button is on. It used
  // to throw, so an admin who pressed Deactivate on their own row met the generic
  // error boundary and could not tell a refusal from the page breaking, on the
  // one control whose whole point is that it would lock them out.
  it("refuses to deactivate your own account on the page, and never calls the service", async () => {
    await setUserLifecycle(form({ user_id: admin.id, action: "deactivate" })).catch(() => {});
    const to = decodeURIComponent(String(redirect.mock.calls.at(-1)?.[0]));
    expect(to).toMatch(new RegExp(`^/admin/agents/${admin.id}\\?error=`));
    expect(to).toMatch(/your own account/i);
    expect(offboarding.applyLifecycleByUserId).not.toHaveBeenCalled();
  });

  it("deactivates a lower-ranked target and audits agent.deactivate", async () => {
    dbState.single = { role: "agent" };
    await setUserLifecycle(form({ user_id: "u2", action: "deactivate" }));
    // #2124: the third argument is the admin's answer to "move their upcoming
    // bookings?", and the default is NOT moving.
    expect(offboarding.applyLifecycleByUserId).toHaveBeenCalledWith("u2", "deactivate", {
      sweepCoverage: false,
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.deactivate", targetUserId: "u2" }),
    );
  });

  it("reactivates through the service with the reactivate direction", async () => {
    dbState.single = { role: "agent" };
    await setUserLifecycle(form({ user_id: "u2", action: "reactivate" }));
    expect(offboarding.applyLifecycleByUserId).toHaveBeenCalledWith("u2", "reactivate", {
      sweepCoverage: false,
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.reactivate", targetUserId: "u2" }),
    );
  });
});

// #1046: `requireManageAgent` is the escalation guard on every agent-edit action,
// and it was the one guard in the file that did not fail closed. #1629 stopped it
// swallowing a read ERROR, but a read that succeeds and finds NOTHING still fell
// back to the role `agent`, which is exactly the role a manager is allowed to edit.
// So a target id that does not exist passed the guard, and an audit row was written
// naming a user that is not there. Nothing downstream corrupted anything (the
// service writes match zero rows), which is why it survived: the only visible trace
// was an audit trail asserting an edit to a nonexistent person.
//
// Driven through setUserLifecycle because it is the shortest path to the guard; the
// guard is shared, so refusing here refuses for every action that calls it.
describe("requireManageAgent fails closed on a target that does not exist (#1046)", () => {
  beforeEach(() => {
    auth.requireManager.mockResolvedValue(admin);
  });

  it("refuses when the target user row is absent, and writes nothing", async () => {
    dbState.single = null; // read succeeded, no such user
    dbState.singleError = null;

    await expect(
      setUserLifecycle(form({ user_id: "ghost", action: "deactivate" })),
    ).rejects.toThrow(/not authorized/i);

    expect(offboarding.applyLifecycleByUserId).not.toHaveBeenCalled();
    // No audit row either: an audit entry against an id with no user is worse than
    // no entry, because it reads as a real edit that happened.
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("still permits a target that DOES exist and outranks nobody", async () => {
    // The positive control. Without it, a guard that refused every call would pass
    // the test above while making the whole admin surface unusable.
    dbState.single = { role: "agent" };

    await setUserLifecycle(form({ user_id: "u2", action: "deactivate" }));

    // #2124: the third argument is the admin's answer to "move their upcoming
    // bookings?", and the default is NOT moving.
    expect(offboarding.applyLifecycleByUserId).toHaveBeenCalledWith("u2", "deactivate", {
      sweepCoverage: false,
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.deactivate", targetUserId: "u2" }),
    );
  });
});

// #912: the admin bookable toggle now runs the same Google-reachability gate as
// the API (via applyBookableByUserId). A blocked result must HARD-BLOCK: throw a
// clear error and NOT revalidate (nothing changed), so a manager can't put a
// calendar-less agent into the pool from the UI.
describe("setBookable Google guard (#912)", () => {
  beforeEach(() => {
    auth.requireManager.mockResolvedValue(admin);
    dbState.single = { role: "agent" };
  });

  it("routes the flip through the guarded service and comes back SAYING it worked", async () => {
    bookable.applyBookableByUserId.mockResolvedValueOnce({ status: "applied", userId: "u2", bookable: true });
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/agents\/u2\?bookable=on/,
    );
    expect(bookable.applyBookableByUserId).toHaveBeenCalledWith("u2", true);
    // #1769: it used to return void and revalidate /admin, which is not the page
    // this form is on. So the only thing that changed on screen was one button
    // being replaced by another in a dense row: a difference you would have to
    // already be looking for, not a confirmation.
    expect(revalidatePath).toHaveBeenCalledWith("/admin/agents/u2");
  });

  it("says which way it went, so the page does not have to be read for a swapped button", async () => {
    bookable.applyBookableByUserId.mockResolvedValueOnce({ status: "applied", userId: "u2", bookable: false });
    await expect(setBookable(form({ user_id: "u2", bookable: "false" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/agents\/u2\?bookable=off/,
    );
  });

  // The two refusals keep their own outcomes, because they need DIFFERENT actions
  // from the reader: an account gone from the Workspace is a credential repair, a
  // transient Google failure is worth retrying. They used to THROW, and there is
  // no error boundary on this route, so Next scrubbed the message in production
  // and the most useful sentence in this action reached nobody.
  it("refuses an unreachable calendar with its own outcome, and writes nothing", async () => {
    bookable.applyBookableByUserId.mockResolvedValueOnce({
      status: "blocked",
      userId: "u2",
      reason: "google_unreachable",
    });
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/agents\/u2\?bookable=blocked-gone/,
    );
    // Nothing was written: the gate refused before the update ran.
    expect(bookable.applyBookableByUserId).toHaveBeenCalledWith("u2", true);
  });

  it("tells a transient block APART from a gone one", async () => {
    bookable.applyBookableByUserId.mockResolvedValueOnce({
      status: "blocked",
      userId: "u2",
      reason: "google_unverified",
    });
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/agents\/u2\?bookable=blocked-transient/,
    );
    // One code answering for both would send somebody to re-authenticate an
    // account that is fine, or to retry a repair that can never work (L11).
    expect(redirect).not.toHaveBeenCalledWith("/admin/agents/u2?bookable=blocked-gone");
  });

  it("gives an unprovisioned account its own outcome, not the retry one", async () => {
    // The two-way branch sent everything that was not `gone` to the transient code,
    // whose copy says to try again shortly. Nothing changes for an account that has
    // never been given Calendar until a Workspace admin acts, so that is advice
    // which can never work (AGENTS.md, "Three ways a Google calendar can fail").
    bookable.applyBookableByUserId.mockResolvedValueOnce({
      status: "blocked",
      userId: "u2",
      reason: "google_not_provisioned",
    });
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/agents\/u2\?bookable=blocked-not-provisioned/,
    );
  });

  it("gives a calendar it could not READ its own outcome (#2302)", async () => {
    // Reachable is not readable. This one sends the reader to the calendar sync
    // lane rather than to the credentials or to a Workspace admin, so it cannot
    // share a code with any of the three above.
    bookable.applyBookableByUserId.mockResolvedValueOnce({
      status: "blocked",
      userId: "u2",
      reason: "calendar_unhydrated",
    });
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/agents\/u2\?bookable=blocked-unread/,
    );
  });

  it("says so rather than silently doing nothing when the agent is not found", async () => {
    bookable.applyBookableByUserId.mockResolvedValueOnce({ status: "not_found" });
    await expect(setBookable(form({ user_id: "ghost", bookable: "true" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/agents\/ghost\?bookable=missing/,
    );
  });

  // #3028: the hourly Twilio sync turns off every bookable advisor whose worker
  // carries Redistribute, so a hand flip into the pool is undone within the hour.
  // The SERVICE refuses it, so the machine API and the Salesforce activation are
  // held by the same rule; this action's job is to say so on the page.
  it("says Twilio holds them when the service refuses for Redistribute", async () => {
    bookable.applyBookableByUserId.mockResolvedValueOnce({ status: "blocked", userId: "u2", reason: "twilio_redistribute" });
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/agents\/u2\?bookable=blocked-redistribute/,
    );
    expect(bookable.applyBookableByUserId).toHaveBeenCalledWith("u2", true);
  });

  // A row the service could not read used to throw, and on this route a throw is
  // Next's generic error page with the message scrubbed. It is refused (nothing is
  // written on an unread row) and it lands as an outcome the page can say.
  it("lands an unreadable row as its own outcome rather than an error page", async () => {
    bookable.applyBookableByUserId.mockRejectedValueOnce(new bookable.BookableLookupError("connection reset"));
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/agents\/u2\?bookable=unreadable/,
    );
  });

  it("still throws on a failure that is not the lookup, rather than claiming nothing changed", async () => {
    bookable.applyBookableByUserId.mockRejectedValueOnce(new Error("bookable write for u2 failed"));
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(/bookable write for u2 failed/);
  });

  it("passes bookable=false straight through (deactivation is never gated)", async () => {
    bookable.applyBookableByUserId.mockResolvedValueOnce({ status: "applied", userId: "u2", bookable: false });
    await expect(setBookable(form({ user_id: "u2", bookable: "false" }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(bookable.applyBookableByUserId).toHaveBeenCalledWith("u2", false);
  });
});

// #491 and #2071: "Sync from Salesforce" runs the WHOLE hourly job through
// runRosterSync (which owns the lock and the streak clear), lands back on the page
// the button is on, and is open to managers. The streak behaviour itself is pinned
// where the runner is exercised, in the cron route's suite.
describe("syncSalesforceNow (#491, #2071)", () => {
  beforeEach(() => {
    auth.requireManager.mockResolvedValue(admin);
    rosterSync.runRosterSync.mockReset();
  });

  it("is gated at manager, not admin, and lands back on the roster page", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(syncOutcome({ updated: 2 }));
    await expect(syncSalesforceNow()).rejects.toThrow(/NEXT_REDIRECT:\/admin\/agents\?synced/);
    expect(auth.requireManager).toHaveBeenCalled();
    expect(auth.requireAdmin).not.toHaveBeenCalled();
    expect(rosterSync.runRosterSync).toHaveBeenCalledTimes(1);
  });

  it("reports a failure on the same page, as a failure", async () => {
    rosterSync.runRosterSync.mockRejectedValueOnce(new Error("SF down"));
    await expect(syncSalesforceNow()).rejects.toThrow(/NEXT_REDIRECT:\/admin\/agents\?sync_error=SF%20down/);
  });

  it("says a run is already under way rather than starting a second one", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce({ skipped: "overlapping-run" });
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("/admin/agents?sync_error=");
    expect(redirected).toContain("already running");
  });

  it("says how many Sales agents are not bookable with no recorded reason (#2621)", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(syncOutcome({ salesNotBookableUnexplained: 2 }));
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("2 agents on the Sales profile are not bookable and nothing records why");
  });

  // #2071: the three onboarding facts the presser is usually asking about.
  it("names who was added, who became bookable, and who is waiting on a calendar", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({
        inserted: 2,
        createdUntiered: 2,
        bookableFlipped: ["a@x", "b@x", "c@x"],
        bookablePending: ["d@x"],
      }),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("2 new hires added not yet bookable");
    expect(redirected).toContain("3 agents made bookable");
    // #2302: an activation left for the next run is its own state, and the presser
    // cannot tell it from a run where everybody came through unless it is said.
    expect(redirected).not.toContain("still waiting to be made bookable");
    expect(redirected).toContain("1 agent waiting to become bookable until a Google calendar exists");
    // Counts, never addresses: an email in a URL is an identity in browser history.
    expect(redirected).not.toContain("@x");
    expect(redirected).not.toContain("undefined");
  });

  // #3028: an activation refused because Twilio holds them on Redistribute is its
  // own fact, and not a calendar wait, so it gets its own line rather than being
  // folded into one that would send the presser to Google.
  it("says who Twilio is holding back from becoming bookable (#3028)", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(syncOutcome({ bookableHeldByTwilio: ["e@x", "f@x"] }));
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("2 agents held out of the pool by the Twilio Redistribute tag");
    expect(redirected).not.toContain("Google calendar");
    expect(redirected).not.toContain("@x");
  });

  it("says when an activation was left for the next run (#2302)", async () => {
    // A mass licence upgrade can plan more activations than one run attempts, since
    // each now reads the agent's calendar before admitting them. The presser has to
    // be told which of the two states they are looking at, and told the next run
    // picks them up, or a queue reads as an error.
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({
        bookableFlipped: ["a@x"],
        bookableDeferredToNextRun: ["b@x"],
      }),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("1 agent still waiting to be made bookable");
    expect(redirected).toContain("next hourly sync");
    expect(redirected).not.toContain("@x");
    expect(redirected).not.toContain("undefined");
  });

  // #2097: the button now runs the Twilio half too, so the banner has to name what
  // Twilio changed. A label saying Salesforce over a run that also flipped agents
  // out of the pool for a Twilio tag reports half of what happened.
  it("names who Twilio took out of the pool and who it put back", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({ updated: 2 }, twilioOk({ turnedOff: ["a@x", "b@x"], turnedBackOn: ["c@x"] })),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("2 agents");
    expect(redirected).toMatch(/redistribute/i);
    expect(redirected).toContain("1 agent");
    // Counts, never addresses: an email in a URL is an identity in browser history.
    expect(redirected).not.toContain("@x");
    expect(redirected).not.toContain("undefined");
  });

  it("says when an activation was left for the next run (#2302)", async () => {
    // A mass licence upgrade can plan more activations than one run attempts, since
    // each now reads the agent's calendar before admitting them. The presser has to
    // be told which of the two states they are looking at, and told the next run
    // picks them up, or a queue reads as an error.
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({
        bookableFlipped: ["a@x"],
        bookableDeferredToNextRun: ["b@x"],
      }),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("1 agent still waiting to be made bookable");
    expect(redirected).toContain("next hourly sync");
    expect(redirected).not.toContain("@x");
    expect(redirected).not.toContain("undefined");
  });

  // Dan, 2026-09-08: the refusal has to be on the page the presser is on, not only
  // in Slack an hour later. The activation gate turns down an agent with no
  // reachable Google calendar, and that is the ORDINARY case for somebody whose tag
  // was removed before their Google account was provisioned.
  it("says on the page when somebody could not be put back in the pool", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({ updated: 2 }, twilioOk({ reactivationRefused: ["a@x", "b@x"] })),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("2 agents");
    expect(redirected).toContain("Google calendar");
    expect(redirected).not.toContain("@x");
  });

  // The half-failed run. The Salesforce banner must still report what Salesforce
  // did, AND the page must say the Twilio half did not happen, because a silent
  // Twilio half has every symptom of a healthy one.
  it("reports a failed Twilio half beside a successful Salesforce one, not instead of it", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({ updated: 7 }, { ok: false, reason: "Twilio refused the credentials (401)." }),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("synced=");
    expect(redirected).toContain("7 agents synced");
    // Its own parameter, so the page can draw it as a refusal rather than burying a
    // failure sentence inside a green success wash.
    expect(redirected).toContain("twilio_error=");
    expect(redirected).toContain("401");
  });

  it("says when a flip threw, because the counts above are the only evidence anybody reads", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({ updated: 2 }, twilioOk({ turnedOff: ["a@x"], flipFailures: 1 })),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("1 agent could not be flipped at all");
  });


  it("says when an attribute write threw, separately from a flip that threw", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({ updated: 0 }, twilioOk({ attributeWriteFailures: 2 })),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("2 agents whose routing attributes could not be recorded");
    // The two failures send a reader to different places, so one line must never
    // answer for the other (L11).
    expect(redirected).not.toContain("could not be flipped at all");
  });

  // #2115: taking somebody out of the pool strands what they have booked, so the
  // flip queues the move and the banner says how much is moving.
  it("says how many upcoming calls are moving off the agents who left the pool", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome(
        { updated: 0 },
        twilioOk({
          turnedOff: ["a@x", "b@x"],
          coverageSweeps: [
            { email: "a@x", bookings: 3 },
            { email: "b@x", bookings: 1 },
          ],
        }),
      ),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("4 upcoming calls being moved off 2 agents who left the pool");
  });

  it("names a sweep that could not be queued and where to go instead", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({ updated: 0 }, twilioOk({ turnedOff: ["a@x"], coverageSweepFailures: 1 })),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("could not be queued for a move");
    expect(redirected).toContain("coverage panel");
  });

  // #3615: a demotion sweep moves only the calls in the pool somebody lost, and the reroute's own
  // faults (including a switch that could not be read) are said on the page, not only in Slack.
  // It says QUEUED, never "being moved": the run only queues the moves, and on 2026-10-21 the
  // Slack line in the same tense said a call was moving that nobody was free to take.
  it("says how many calls are queued to move off agents whose Twilio tiers narrowed", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome(
        { updated: 0 },
        twilioOk({
          demotionSweeps: [
            { email: "a@x", userId: "u1", jobId: "j1", bookings: 2, change: null },
            { email: "b@x", userId: "u2", jobId: "j2", bookings: 1, change: null },
          ],
        }),
      ),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("3 upcoming calls queued to move off 2 agents whose Twilio tiers no longer cover them");
    expect(redirected).not.toMatch(/demoted|being moved off 2/);
  });

  it("names a reroute that could not finish, and a switch that could not be read", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({ updated: 0 }, twilioOk({ demotionEvalFailures: 1, demotionSweepFailures: 1, demotionSwitchUnreadable: true })),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("could not read whether the automatic reroute is switched on");
    expect(redirected).toContain("2 agents the automatic reroute could not finish for");
  });

  // #2735: the tag is what silences the Regal call page, so a run that moved it for
  // somebody already out of the pool has to say so. Somebody whose tag moved WITH a
  // flip is already named by the flip's own line, so they are not counted twice.
  it("names Redistribute tags that landed or came off without a flip", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome(
        { updated: 0 },
        twilioOk({
          turnedOff: ["a@x"],
          redistributeTagLanded: ["a@x", "b@x", "c@x"],
          turnedBackOn: ["d@x"],
          reactivationRefused: ["e@x"],
          redistributeTagCleared: ["d@x", "e@x", "f@x"],
        }),
      ),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("2 agents newly tagged Redistribute in Twilio");
    expect(redirected).toContain("1 agent whose Redistribute tag came off in Twilio");
    expect(redirected).not.toContain("@x");
  });

  it("says nothing about Twilio when it read fine and changed nobody", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(syncOutcome({ updated: 2 }));
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).not.toMatch(/redistribute/i);
    expect(redirected).not.toContain("twilio_error=");
  });

  // #1653: the admin who presses this button is usually pressing it BECAUSE a
  // manager link looks wrong, so the summary is where they find out what the run
  // refused to do. A manager name answering to two Salesforce users and one
  // answering to nobody need opposite fixes, so they are two sentences (L11); one
  // line covering both told the reader neither.
  it("says separately that a manager name was shared and that one matched nobody", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({ updated: 2, managersUnresolved: 1, managersAmbiguous: 15, managerNamesAmbiguous: 1 }),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("15 agents left unlinked");
    expect(redirected).toContain("1 manager name in Salesforce answers to more than one user");
    expect(redirected).toContain("1 agent has a manager name nothing in Salesforce matched");
    expect(redirected).not.toContain("undefined");
    expect(redirected).not.toContain("NaN");
  });

  // The count has always been per AGENT. The old line called it a manager name, so
  // one unmatched name shared by a team of fifteen rendered as fifteen names.
  it("counts the unmatched refusal in agents, not in picklist names", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(syncOutcome({ managersUnresolved: 15 }));
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("15 agents have a manager name nothing in Salesforce matched");
    expect(redirected).not.toContain("15 manager names");
  });

  // #1833: the admin pressing this button is the person who can act on a bookable
  // agent the roster query stopped returning, because the toggle that takes them
  // out of the pool is on this very screen. The line says the run left them alone,
  // since a bare count sitting in a list of things the run DID would read as
  // another thing it did.
  it("names a bookable agent Salesforce no longer confirms, and says nothing was changed", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({ updated: 2, rosterUnconfirmedUnmatched: 1, rosterUnconfirmedBookable: ["onleave@x.com"] }),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("1 bookable agent no longer returned by the Salesforce roster query");
    expect(redirected).toContain("left exactly as they are");
    expect(redirected).not.toContain("undefined");
    expect(redirected).not.toContain("NaN");
  });

  // The quiet half, on the screen as well as in Slack. Every unconfirmed row
  // measured on the live roster is non bookable, so a line about them would be
  // permanent furniture on a page whose job is to report what the run did.
  it("says nothing when the unconfirmed rows are all out of the pool", async () => {
    rosterSync.runRosterSync.mockResolvedValueOnce(
      syncOutcome({ updated: 2, rosterUnconfirmedUnmatched: 20, rosterUnconfirmedAbsent: 12 }),
    );
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).not.toContain("no longer returned by the Salesforce roster query");
  });
});

// Granting elevated access by email (#160). The surface exists because seeding a
// privileged row used to mean a developer editing the users table, so the guards
// on it ARE the feature: this pins that the action refuses server side rather
// than relying on the button being hidden, and that an admin count it could not
// read never becomes a confident answer in either direction.
describe("grantStaffAccess", () => {
  const superAdmin = { id: "sa1", role: "super_admin", org_id: "o1" };

  function staffForm(over: Record<string, string> = {}): FormData {
    return form({ email: "new.person@trypennie.com", role: "admin", ...over });
  }

  function redirectedTo(): string {
    const call = redirect.mock.calls.at(-1);
    return String(call?.[0] ?? "");
  }

  it("refuses a caller who is not a super admin, and never touches the DB", async () => {
    auth.requireSuperAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(grantStaffAccess(staffForm())).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  // The plan refuses independently of the route guard, so a second entry point
  // wired to requireAdmin could not open the door by accident.
  it("refuses an ordinary admin even if the route guard let them through", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(admin);
    await expect(grantStaffAccess(staffForm())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=not_authorized");
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  // The positive control, in the same fixture: without it every refusal above is
  // satisfied by an action that can never write at all.
  it("creates the account, never bookable, and reports the address it wrote", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.single = null;
    await expect(grantStaffAccess(staffForm())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.email).toBe("new.person@trypennie.com");
    expect(row.role).toBe("admin");
    expect(row.org_id).toBe("o1");
    expect(row.bookable).toBe(false);
    expect(redirectedTo()).toContain("staff=granted");
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it("normalizes the address, because login matches on exactly what is stored", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    await expect(
      grantStaffAccess(staffForm({ email: "  New.Person@TryPennie.com " })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.email).toBe("new.person@trypennie.com");
  });

  it("refuses an address held by another org rather than colliding on the unique index", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.single = {
      id: "u9",
      org_id: "other-org",
      role: "agent",
      deactivated_at: null,
      auth_user_id: null,
    };
    await expect(grantStaffAccess(staffForm())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=other_org");
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  // An unreadable lookup is not an absent row. Reading it as absence would send
  // the action down the create path on an address that may already exist.
  it("refuses when the existing-account lookup fails, and writes nothing", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.singleError = { message: "permission denied for table users" };
    await expect(grantStaffAccess(staffForm())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=lookup_failed");
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("blocks a change that would leave the org with no admin", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.single = {
      id: "u9",
      org_id: "o1",
      role: "admin",
      deactivated_at: null,
      auth_user_id: "a9",
    };
    dbState.count = 1;
    await expect(grantStaffAccess(staffForm({ role: "manager" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=last_admin");
    expect(update).not.toHaveBeenCalled();
  });

  // #1165 again, on a new surface. A FAILED count read must refuse in its own
  // words: scoring it as zero produces a confident "no admin would remain" about
  // a roster nothing measured, and scoring it as plenty would let the change
  // through on the same non-answer.
  it("refuses with an unreadable-count message, not a last-admin claim, when the count read fails", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    // Unclaimed on purpose: a row somebody HAS signed in to is refused by the
    // #1669 surface rule before the count is ever consulted, so an unreadable
    // count only decides for a grant nobody has used.
    dbState.single = {
      id: "u9",
      org_id: "o1",
      role: "admin",
      deactivated_at: null,
      auth_user_id: null,
    };
    dbState.count = 5; // plenty of admins; only the READ is broken
    dbState.countError = { message: "permission denied for table users" };
    await expect(grantStaffAccess(staffForm({ role: "manager" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=admin_count_unreadable");
    expect(redirectedTo()).not.toContain("last_admin");
    expect(update).not.toHaveBeenCalled();
  });

  // #1669: the lookalike remedy posted the PENDING row's role and nothing read
  // the target's own, so one click could drop a signed in admin to manager as an
  // ordinary success. Nothing may be written.
  it("refuses to lower a colleague who has signed in, and writes nothing", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.single = {
      id: "u9",
      org_id: "o1",
      role: "admin",
      deactivated_at: null,
      auth_user_id: "a9",
    };
    dbState.count = 5; // plenty of admins, so the last-admin rule is not what refuses
    await expect(grantStaffAccess(staffForm({ role: "manager" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=signed_in_demotion");
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  // The healthy control in the same fixture, so the refusal above cannot be
  // passing because this surface stopped writing at all.
  it("still raises a signed in colleague's access, which is what the panel is for", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.single = {
      id: "u9",
      org_id: "o1",
      role: "manager",
      deactivated_at: null,
      auth_user_id: "a9",
    };
    dbState.count = 5;
    await expect(grantStaffAccess(staffForm({ role: "admin" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=updated");
    expect(update).toHaveBeenCalled();
  });

  // The count only decides a change that TAKES org power away, so a broken count
  // read must not block a grant that never depended on it.
  it("still grants when the count read fails but the change adds org power", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.single = {
      id: "u9",
      org_id: "o1",
      role: "manager",
      deactivated_at: null,
      auth_user_id: "a9",
    };
    dbState.countError = { message: "permission denied for table users" };
    await expect(grantStaffAccess(staffForm({ role: "admin" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=updated");
    expect(update).toHaveBeenCalledTimes(1);
  });

  // A write that failed must not be reported as access somebody now has: the
  // person would be told they are set up and find out at the login screen.
  it("reports a failed write as a failure, and records no audit row for it", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.insertError = { message: "duplicate key value violates unique constraint" };
    await expect(grantStaffAccess(staffForm())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=write_failed");
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #1649: the fail open fixes #1629 shipped, driven
// ---------------------------------------------------------------------------
//
// #1629 turned nine swallowed reads in this file into `unwrap`, and touched no
// test file. Each one is the reason that PR was written, and a guard is only real
// once it has been seen to fail (L1).
//
// Every case below FAILS ONE READ and leaves its neighbours healthy, using the
// per table seam, because a fixture that fails everything at once cannot tell
// "this action refuses when its authorization read fails" from "this action
// refuses when anything fails": the assertion would pass on a version that only
// guarded a different read.
//
// Each failing case is asserted on the SPECIFIC refusal, never merely that
// something threw (L140): a test satisfied by any throw is satisfied by its own
// fixture throwing. And each sits beside a healthy control in the same fixture,
// so the refusal cannot pass vacuously on an action that stopped working (L159).
//
// WHY THE PUSH GATE PASSED #1629, which the issue asks about. The gate blocks a
// push whose source changes carry ZERO tests, and otherwise asks a model whether
// each DISTINCT logical change is covered. #1629 carried six test files with real
// content (page-unreadable.test.tsx alone was 294 lines), so the zero-test floor
// never fired, and to a judge grading distinct changes the PR was ONE change:
// "stop the admin surface reading an unreadable table as an empty one", tested.
// The nine sites in this file were, at that altitude, the same change as the
// sites in page.tsx that did get tests.
//
// So the gap is not that the gate was switched off. It is that a sweep touching
// twenty sites under one heading reads as one covered change however few of the
// sites are actually driven, and the more files a sweep touches the more
// convincing that reads. Worth knowing when the next sweep is written: a change
// that alters AUTHORIZATION is its own distinct change no matter what heading it
// arrived under.
describe("the reads that decide authorization or a write must refuse, not guess (#1649)", () => {
  const manager = { id: "m1", role: "manager", org_id: "o1" };

  beforeEach(() => {
    auth.requireManager.mockResolvedValue(manager);
    auth.requireAdmin.mockResolvedValue(admin);
  });

  // 1. requireManageAgent. The sharpest of the nine: a null `data` defaulted the
  //    TARGET's role to "agent", which is the role a manager may edit, so an
  //    unreadable users row let a manager edit an admin.
  describe("requireManageAgent, the escalation guard", () => {
    it("refuses when the target's role cannot be read, and writes NOTHING", async () => {
      dbState.errorByTable.users = { message: "permission denied for table users" };
      await expect(
        setBookable(form({ user_id: "u2", bookable: "true" })),
      ).rejects.toThrow(/manage-agent target role/);
      // The whole point: no bookable write, no audit row, nothing revalidated as
      // though something had changed.
      expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    });

    it("still lets a manager edit an agent when the read works", async () => {
      dbState.rowsByTable.users = { role: "agent" };
      // The action reports its outcome by redirecting now (#1769), and this file's
      // redirect mock throws the way the real one does. Reaching the redirect IS
      // reaching the end of the action.
      await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(
        /NEXT_REDIRECT/,
      );
      expect(bookable.applyBookableByUserId).toHaveBeenCalled();
    });

    // The guard's own job, proved in the same fixture as the refusal above, so
    // "it refused" cannot be read as "it refuses everything".
    it("refuses a manager editing an admin when the read works fine", async () => {
      dbState.rowsByTable.users = { role: "admin" };
      await expect(
        setBookable(form({ user_id: "u2", bookable: "true" })),
      ).rejects.toThrow(/Not authorized/);
      expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();
    });

    // #1046, riding in the same guard: a read that finds NOTHING is not a role
    // either. Absent used to default to "agent" and recorded an audit row against
    // a user that does not exist.
    it("refuses a target that does not exist, rather than treating absent as agent", async () => {
      dbState.rowsByTable.users = null;
      await expect(
        setBookable(form({ user_id: "ghost", bookable: "true" })),
      ).rejects.toThrow(/Not authorized/);
      expect(recordAudit).not.toHaveBeenCalled();
    });

    // The guard is shared, so the refusal has to hold on every action behind it,
    // not just the one a test happened to pick.
    it("refuses on every action that goes through it", async () => {
      for (const drive of [
        () => setBookable(form({ user_id: "u2", bookable: "true" })),
        () => setUserLifecycle(form({ user_id: "u2", action: "deactivate" })),
        () => setWorkingHours(form({ user_id: "u2", day_1: "on", start_1: "09:00", end_1: "17:00" })),
      ]) {
        vi.clearAllMocks();
        auth.requireManager.mockResolvedValue(manager);
        dbState.errorByTable = { users: { message: "permission denied for table users" } };
        await expect(drive()).rejects.toThrow(/manage-agent target role/);
        expect(recordAudit).not.toHaveBeenCalled();
      }
    });
  });

  // 2 and 3. The timezone overwrite pair. An unreadable schedule read as "this
  //    agent has no timezone of their own", and the write then REPLACED their
  //    real one with the org default, which moves every hour they are bookable.
  describe("the timezone overwrite pair", () => {
    const orgDefaults = {
      default_timezone: "America/Chicago",
      default_start_minute: 540,
      default_end_minute: 1020,
      default_weekdays: [1, 2, 3, 4, 5],
    };

    it("refuses when the agent's own schedule cannot be read, and writes no schedule", async () => {
      dbState.rowsByTable.users = { role: "agent" };
      dbState.rowsByTable.organizations = orgDefaults;
      dbState.errorByTable.availability_schedules = { message: "deadlock detected" };
      await expect(useDefaultHours(form({ user_id: "u2" }))).rejects.toThrow(
        /agent schedule timezone/,
      );
      expect(upsert).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });

    it("refuses when the org defaults cannot be read", async () => {
      dbState.rowsByTable.users = { role: "agent" };
      dbState.errorByTable.organizations = { message: "column default_weekdays does not exist" };
      dbState.rowsByTable.availability_schedules = { timezone: "America/Denver" };
      await expect(useDefaultHours(form({ user_id: "u2" }))).rejects.toThrow(
        /org default schedule/,
      );
      expect(upsert).not.toHaveBeenCalled();
      // #1988: and no confirmation. A refusal that still carried a save outcome
      // would put "Hours saved." over a week nobody wrote, which is worse than
      // the silence this replaced.
      expect(redirect).not.toHaveBeenCalled();
    });

    // The control, and the behaviour the pair exists to protect: with both reads
    // healthy the agent KEEPS their own zone rather than adopting the org's.
    // #1988: a successful write now ENDS in a redirect, which the mock throws
    // the way the real one does, so these two await the rejection rather than a
    // clean resolve. That is not incidental to what they assert: the redirect
    // is the confirmation, and a test that resolved here would be describing an
    // action that saved and then said nothing.
    it("keeps the agent's own timezone when both reads work", async () => {
      dbState.rowsByTable.users = { role: "agent" };
      dbState.rowsByTable.organizations = orgDefaults;
      dbState.rowsByTable.availability_schedules = { timezone: "America/Denver" };
      await expect(useDefaultHours(form({ user_id: "u2" }))).rejects.toThrow(
        "NEXT_REDIRECT:/admin/agents/u2?ok=working-hours",
      );
      // #2002: the zone now rides on the one transactional call, so it is read off
      // that call rather than off a separate upsert that used to commit alone.
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0][1]).toMatchObject({ p_user_id: "u2", p_timezone: "America/Denver" });
    });

    it("adopts the org default only when the agent genuinely has no schedule", async () => {
      dbState.rowsByTable.users = { role: "agent" };
      dbState.rowsByTable.organizations = orgDefaults;
      dbState.rowsByTable.availability_schedules = null;
      await expect(useDefaultHours(form({ user_id: "u2" }))).rejects.toThrow(
        "NEXT_REDIRECT:/admin/agents/u2?ok=working-hours",
      );
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0][1]).toMatchObject({ p_user_id: "u2", p_timezone: "America/Chicago" });
    });

    // #2103: the self service path this paired with is gone, along with the
    // server action behind it AND the shared helper, which turned out to have
    // no other caller. The admin's own default hours action carries its own
    // copy of those reads and is covered above.
  });

  // 4. setDefaultBucket. An empty valid set makes EVERY code invalid, so a failed
  //    read told the admin their real bucket code does not exist, sending them
  //    hunting for a typo that is not there.
  describe("the default bucket's valid code set", () => {
    it("refuses when the bucket list cannot be read, rather than calling the code invalid", async () => {
      dbState.errorByTable.buckets = { message: "permission denied for table buckets" };
      await expect(
        setDefaultBucket(form({ default_bucket_code: "120" })),
      ).rejects.toThrow(/default bucket valid codes/);
      // And specifically NOT the "not a current bucket code" redirect, which is
      // the false reason this replaced.
      expect(redirect).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    });

    it("still refuses a genuinely unknown code when the read works", async () => {
      dbState.rowsByTable.buckets = [{ code: "120", is_test: false }];
      await expect(
        setDefaultBucket(form({ default_bucket_code: "999" })),
      ).rejects.toThrow(/NEXT_REDIRECT/);
      expect(upsert).not.toHaveBeenCalled();
    });

    it("stores a code that really exists", async () => {
      dbState.rowsByTable.buckets = [{ code: "120", is_test: false }];
      // The success path redirects too, so the difference between the three cases
      // is WHICH redirect and whether the write happened, never whether one threw.
      await expect(
        setDefaultBucket(form({ default_bucket_code: "120" })),
      // #1922: back to the page the form is on, not the dead /admin/settings.
      ).rejects.toThrow(/NEXT_REDIRECT:\/admin\/buckets\?ok=bucket-routing/);
      expect(upsert).toHaveBeenCalled();
    });
  });

  // 7. startImpersonation. A null on error took the "No user with email X" branch,
  //    which tells an admin the person does not exist when the read merely failed.
  //    The next thing somebody does with that answer is create the account again.
  describe("the impersonation target lookup", () => {
    it("refuses when the lookup fails, and never claims the person does not exist", async () => {
      auth.realCurrentUser.mockResolvedValueOnce(admin);
      dbState.errorByTable.users = { message: "permission denied for table users" };
      await expect(
        startImpersonation(form({ email: "someone@trypennie.com" })),
      ).rejects.toThrow(/impersonation target lookup/);
      expect(cookieStore.set).not.toHaveBeenCalled();
      const said = redirect.mock.calls.map((c) => String(c[0])).join(" ");
      expect(said).not.toMatch(/No\+user\+with\+email/);
    });

    it("still says so when the person really is absent", async () => {
      auth.realCurrentUser.mockResolvedValueOnce(admin);
      dbState.rowsByTable.users = null;
      await expect(
        startImpersonation(form({ email: "nobody@trypennie.com" })),
      ).rejects.toThrow(/NEXT_REDIRECT/);
      // URLSearchParams encodes a space as `+`, not `%20`.
      expect(redirect.mock.calls.map((c) => String(c[0])).join(" ")).toMatch(
        /No\+user\+with\+email/,
      );
      expect(cookieStore.set).not.toHaveBeenCalled();
    });
  });

  // 8. setUserRole. The read feeds `canSetRole`, so guessing it is a guess at an
  //    authorization input, and the swallow made the action return SILENTLY: the
  //    admin pressed the button, the page re-rendered unchanged, nothing said why.
  describe("the set-role target read", () => {
    it("refuses when the target's current role cannot be read, and writes nothing", async () => {
      dbState.errorByTable.users = { message: "permission denied for table users" };
      await expect(
        setUserRole(form({ user_id: "u2", role: "manager" })),
      ).rejects.toThrow(/set-role target role/);
      expect(update).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it("writes the role when the read works", async () => {
      dbState.rowsByTable.users = { role: "agent" };
      dbState.count = 5;
      await setUserRole(form({ user_id: "u2", role: "manager" }));
      expect(update).toHaveBeenCalledWith({ role: "manager" });
      expect(recordAudit).toHaveBeenCalled();
    });
  });

  // 9. setWebhookEndpoint. The swallow decided UPDATE versus INSERT, so a failed
  //    read created a SECOND endpoint row and every event was then delivered twice.
  describe("the webhook endpoint's update-versus-insert decision", () => {
    const endpointForm = () =>
      form({ url: "https://example.com/hook", events: "booking.created", active: "true" });

    it("refuses when the existing endpoint read fails, so it cannot create a duplicate", async () => {
      dbState.errorByTable.webhook_endpoints = { message: "permission denied" };
      await expect(setWebhookEndpoint(endpointForm())).rejects.toThrow(
        /webhook endpoint/,
      );
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it("updates the endpoint that already exists", async () => {
      dbState.rowsByTable.webhook_endpoints = { id: "ep1" };
      await setWebhookEndpoint(endpointForm()).catch(() => {});
      expect(update).toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    });

    it("inserts only when the read really found nothing", async () => {
      dbState.rowsByTable.webhook_endpoints = null;
      await setWebhookEndpoint(endpointForm()).catch(() => {});
      expect(insert).toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });
  });
});

// #1874. The routing attributes panel is read only for the three keys Salesforce
// owns, so this action writes exactly one.
//

// #1922. Six actions redirected to `/admin/settings`, which since #1748 is not a
// screen: it is a bare redirect to `/admin`, kept so an old bookmark lands
// somewhere real. So a save on `/admin/buckets` or `/admin/business-hours` ended
// on the HEALTH page and the outcome query was dropped by the second redirect.
// Measured in a browser before the fix: `/admin/settings?ok=1` and
// `/admin/settings?error=...` both landed on `/admin` with no notice anywhere.
//
// A successful save therefore said nothing, and a REFUSED save destroyed the
// sentence explaining why, which is a fail-silent on the exact path built to fail
// loud. That is L586.
//
// Asserted on the redirect TARGET, never on the fact of a redirect: a test that
// only checks a redirect happened passes on every wrong target (L63).
describe("a save returns to the page its own form is on (#1922)", () => {
  beforeEach(() => {
    auth.requireAdmin.mockResolvedValue(admin);
    auth.requireSuperAdmin.mockResolvedValue(admin);
    dbState.single = { id: "b1", code: "411", name: "Pool" };
    dbState.rowsByTable = { buckets: { id: "b1", code: "411", name: "Pool" } };
  });

  /** The URL an action redirected to, from the thrown NEXT_REDIRECT. */
  const targetOf = async (run: () => Promise<unknown>): Promise<string> => {
    await run().catch(() => {});
    const call = redirect.mock.calls.at(-1);
    return call ? String(call[0]) : "(no redirect)";
  };

  it("sends a saved default bucket back to the buckets page", async () => {
    dbState.rowsByTable.buckets = [{ code: "411", is_test: false }];
    const to = await targetOf(() => setDefaultBucket(form({ default_bucket_code: "411" })));
    expect(to).toMatch(/^\/admin\/buckets\?ok=/);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/buckets");
  });

  it("sends saved days offered back to the hours page", async () => {
    const to = await targetOf(() => setDaysOffered(form({ offered_open_days: "3", last_resort_extra_days: "2" })));
    expect(to).toMatch(/^\/admin\/business-hours\?ok=/);
  });

  it("sends saved booker copy back to the booker copy page", async () => {
    const to = await targetOf(() =>
      setEventDescription(form({ event_type_id: "et1", description: "Hello" })),
    );
    expect(to).toMatch(/^\/admin\/booker-copy\?ok=/);
  });

  it("sends saved monitor settings back to the alerts page", async () => {
    const to = await targetOf(() =>
      setMonitorSettings(form(Object.fromEntries(ALERT_KEYS.map((k) => [`cooldown_${k}`, "15"])))),
    );
    expect(to).toMatch(/^\/admin\/alerts\?ok=/);
  });

  // The half that mattered most: a REFUSAL has to reach the page too, or the
  // sentence explaining why the value was rejected goes nowhere.
  it("returns a refusal to the page that can show it, with the reason intact", async () => {
    const to = await targetOf(() => setDaysOffered(form({ offered_open_days: "9999", last_resort_extra_days: "0" })));
    expect(to).toMatch(/^\/admin\/business-hours\?error=/);
    expect(decodeURIComponent(to)).toMatch(/\d/);
  });

  // The route that swallowed them. Nothing may point at it again: it renders no
  // notice and drops the query on its way to /admin.
  it("points nothing at the route that is itself a redirect", async () => {
    dbState.rowsByTable.buckets = [{ code: "411", is_test: false }];
    for (const run of [
      () => setDefaultBucket(form({ default_bucket_code: "411" })),
      () => setDaysOffered(form({ offered_open_days: "3", last_resort_extra_days: "2" })),
      () => setDaysOffered(form({ offered_open_days: "9999", last_resort_extra_days: "0" })),
      () => setEventDescription(form({ event_type_id: "et1", description: "Hello" })),
    ]) {
      redirect.mockClear();
      revalidatePath.mockClear();
      await run().catch(() => {});
      for (const call of [...redirect.mock.calls, ...revalidatePath.mock.calls]) {
        expect(String(call[0])).not.toMatch(/\/admin\/settings/);
      }
    }
  });
});

// #1930 / #1932 / #1934. Saving a bucket was three writes binding no error, with
// no transaction: a failed insert left the pool with NOBODY in it while the action
// returned normally and the page redrew as saved. A routing pool with nobody in it
// turns every matching lead away. And nothing was recorded anywhere, on the one
// action that decides where leads get sent.
describe("saving a bucket is atomic, refuses loudly, and is recorded (#1930)", () => {
  beforeEach(() => {
    auth.requireAdmin.mockResolvedValue(admin);
    dbState.single = {
      code: "411",
      name: "Old name",
      event_type_id: "et1",
      criteria: { debt_team: ["high"] },
      routing_form_id: null,
      fallback_user_id: null,
    };
    dbState.rowsByTable = {
      buckets: {
        code: "411",
        name: "Old name",
        event_type_id: "et1",
        criteria: { debt_team: ["high"] },
        routing_form_id: null,
        fallback_user_id: null,
      },
      bucket_members: [{ user_id: "u1" }, { user_id: "u2" }],
    };
  });

  const edit = (over: Record<string, string | string[]> = {}) =>
    form({
      bucket_id: "b1",
      code: "411",
      name: "Old name",
      event_type_id: "et1",
      crit_debt_team: "high",
      members: ["u1", "u2"],
      ...over,
    });

  it("replaces the members through the transaction, not a delete then an insert", async () => {
    await expect(updateBucket(edit())).rejects.toThrow(/ok=bucket-updated/);
    expect(rpc).toHaveBeenCalledWith("replace_bucket_members", {
      p_bucket_id: "b1",
      p_user_ids: ["u1", "u2"],
    });
  });

  it("refuses when the member replace fails, rather than reporting a save", async () => {
    dbState.rpcError = { message: "deadlock detected" };
    await expect(updateBucket(edit())).rejects.toThrow(/members could not be saved/i);
    // Nothing may claim success, so nothing may be recorded either.
    expect(recordAudit).not.toHaveBeenCalled();
  });

  // The last place that can tell. A replace that landed a different number than
  // asked for is a silently wrong pool.
  it("refuses on a count it did not ask for, not only on an error", async () => {
    dbState.rpcWritten = 1;
    await expect(updateBucket(edit({ members: ["u1", "u2", "u3"] }))).rejects.toThrow(
      /expected 3, the database recorded 1/i,
    );
  });

  // #1762: the form can post one id twice, when a membership is both matched from
  // the roster and carried over as an off roster id. The function inserts
  // `distinct`, so the count is compared against the deduplicated input or every
  // such save would refuse itself.
  // #1990: reaching the redirect IS reaching the end of a successful save, so
  // these two assert the confirmation rather than a clean resolve. A resolve
  // would now mean the action returned early without saving.
  it("does not refuse a save that posted the same member twice", async () => {
    await expect(updateBucket(edit({ members: ["u1", "u2", "u2"] }))).rejects.toThrow(
      /ok=bucket-updated/,
    );
  });

  // An empty set is the ORDINARY case for a bucket: it routes by criteria. That is
  // the deliberate difference from migration 0097, which refuses one.
  it("allows a bucket with no manual members at all", async () => {
    await expect(updateBucket(edit({ members: [] }))).rejects.toThrow(/ok=bucket-updated/);
    expect(rpc).toHaveBeenCalledWith("replace_bucket_members", {
      p_bucket_id: "b1",
      p_user_ids: [],
    });
  });

  it("refuses a rejected bucket update BEFORE touching the members", async () => {
    updateEq.mockResolvedValueOnce({ error: { message: "permission denied" } });
    await expect(updateBucket(edit())).rejects.toThrow(/could not be saved/i);
    // The half apply this ordering exists to prevent: the pool must not change
    // when the bucket row was refused.
    expect(rpc).not.toHaveBeenCalledWith("replace_bucket_members", expect.anything());
  });

  // #1935: THE DUPLICATE CODE REFUSAL IS GONE FROM THIS ACTION, and its test with
  // it (L252): an update writes back the code the row already has, so a unique
  // violation on (org_id, code) can no longer be reached from here. Creating a
  // bucket still can, and still names it, in its own block below.
  //
  // What replaced it is the reason: a posted code is ignored entirely.
  // #2006: and a bucket the seeder does NOT write keeps its own fields. The
  // seeder writes only the sixty XBC codes, so freezing every existing bucket
  // took the hand created ones with it, whose fields are set nowhere but the
  // create form (L615).
  it("accepts an edit to a bucket the seeder does not write", async () => {
    dbState.rowsByTable.buckets = { code: "SMOKE", name: "Old", criteria: {}, event_type_id: "et1" };
    await expect(
      updateBucket(edit({ code: "SMOKE", name: "Corrected" })),
    ).rejects.toThrow(/ok=bucket-updated/);
    const wrote = update.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(wrote.name).toBe("Corrected");
    expect(wrote.code).toBe("SMOKE");
  });

  it("ignores a posted code, because the seeder owns it", async () => {
    await expect(updateBucket(edit({ code: "412" }))).rejects.toThrow(/ok=bucket-updated/);
    const wrote = update.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(wrote.code).toBe("411");
  });

  it("ignores a posted name and posted criteria for the same reason", async () => {
    await expect(updateBucket(edit({ name: "New name" }))).rejects.toThrow(/ok=bucket-updated/);
    const wrote = update.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(wrote.name).toBe("Old name");
  });

  // #1932: the trail has to answer what the configuration WAS, so both values.
  it("records what changed, with the old and the new value", async () => {
    await expect(
      updateBucket(edit({ event_type_id: "et9", members: ["u2", "u9"] })),
    ).rejects.toThrow(/ok=bucket-updated/);

    const entry = recordAudit.mock.calls.at(-1)![0] as {
      action: string;
      details: Record<string, unknown>;
    };
    expect(entry.action).toBe("bucket.updated");
    expect(entry.details.changed).toEqual({
      event_type_id: { from: "et1", to: "et9" },
    });
    // The membership change is the one with no other trace anywhere.
    expect(entry.details.members_added).toEqual(["u9"]);
    expect(entry.details.members_removed).toEqual(["u1"]);
  });

  it("records nothing as changed when nothing changed", async () => {
    await expect(updateBucket(edit())).rejects.toThrow(/ok=bucket-updated/);
    const entry = recordAudit.mock.calls.at(-1)![0] as {
      details: Record<string, unknown>;
    };
    expect(entry.details.changed).toEqual({});
    expect(entry.details.members_added).toEqual([]);
    expect(entry.details.members_removed).toEqual([]);
  });

  it("refreshes the page the form is on, not the one it used to be on", async () => {
    await expect(updateBucket(edit())).rejects.toThrow(/ok=bucket-updated/);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/buckets");
  });

  // Creating had the same silence: the insert's error was bound and then ignored,
  // so a duplicate XBC against the `(org_id, code)` unique index the seeder
  // upserts on was indistinguishable from a successful create.
  describe("creating one", () => {
    const create = (over: Record<string, string | string[]> = {}) =>
      form({ code: "412", name: "New pool", event_type_id: "et1", members: ["u1"], ...over });

    // #2385: the duplicate is the one refusal here an admin can act on, so it
    // comes back to the buckets page as a sentence rather than throwing. #1930
    // wrote this wording and delivered it to nobody: a thrown message is replaced
    // in production, so an admin typing an XBC that already had a bucket was told
    // to reload and check whether it had gone through, found no bucket, and typed
    // the same code again.
    it("names a duplicate code on the page, apart from any other refusal", async () => {
      dbState.insertReturnError = { message: "duplicate key value", code: "23505" };
      await createBucket(create()).catch(() => {});
      const to = decodeURIComponent(String(redirect.mock.calls.at(-1)?.[0]));
      expect(to).toMatch(/^\/admin\/buckets\?error=/);
      expect(to).toMatch(/bucket with code 412 already exists/i);
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it("refuses any other database error in its own words", async () => {
      dbState.insertReturnError = { message: "permission denied for table buckets" };
      await expect(createBucket(create())).rejects.toThrow(/could not be created/i);
      await expect(createBucket(create())).rejects.not.toThrow(/already exists/i);
    });

    it("records the creation with the code and who is in it", async () => {
      dbState.insertReturns = { id: "b9" };
      await expect(createBucket(create({ members: ["u1", "u2"] }))).rejects.toThrow(/ok=bucket-created/);

      const entry = recordAudit.mock.calls.at(-1)![0] as {
        action: string;
        details: Record<string, unknown>;
      };
      expect(entry.action).toBe("bucket.created");
      expect(entry.details.code).toBe("412");
      expect(entry.details.members_added).toEqual(["u1", "u2"]);
    });
  });
});

// #1769: every one of these is submitted from a form on /admin/agents/[id], and
// every one of them revalidated only /admin, which is the Overview page. So the
// page the person was looking at kept showing what it showed before they pressed
// the button, which is most of why a successful action read as nothing having
// happened. Asserted per action rather than once, because this is a per call site
// mistake and one of them being right says nothing about the others.
describe("an action refreshes the page its form is on (#1769)", () => {
  beforeEach(() => {
    auth.requireManager.mockResolvedValue(admin);
    auth.requireAdmin.mockResolvedValue(admin);
    dbState.single = { role: "agent" };
    dbState.rowsByTable.users = { role: "agent" };
  });

  it("setUserRole refreshes the agent page", async () => {
    await setUserRole(form({ user_id: "u2", role: "manager" })).catch(() => {});
    expect(revalidatePath).toHaveBeenCalledWith("/admin/agents/u2");
  });


  it("setOooCalendarId refreshes the agent page", async () => {
    await setOooCalendarId(form({ user_id: "u2", ooo_calendar_id: "cal@example.com" })).catch(
      () => {},
    );
    expect(revalidatePath).toHaveBeenCalledWith("/admin/agents/u2");
  });

  // And the Overview is still refreshed, because the roster there shows the same
  // fields: this adds a route rather than moving one.
  it("keeps refreshing the Overview as well", async () => {
    await setUserRole(form({ user_id: "u2", role: "manager" })).catch(() => {});
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
  });
});

describe("creating an event type refuses rather than inventing (#1950)", () => {
  beforeEach(() => {
    auth.requireAdmin.mockResolvedValue(admin);
    // One event type already exists, which is the state the page is read in.
    dbState.rowsByTable = { event_types: [{ name: "Senior Loan Advisor Call" }] };
    dbState.insertReturns = { id: "et-new" };
    dbState.insertReturnError = null;
  });

  const add = (over: Record<string, string> = {}) =>
    form({ name: "Quick check in", duration_min: "20", ...over });

  it("writes the event type when the title is new", async () => {
    await createEventType(add()).catch(() => {});
    const row = insert.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(row.name).toBe("Quick check in");
    expect(row.duration_min).toBe(20);
  });

  it("applies the shared default to a field left blank, not a number of its own", async () => {
    await createEventType(add({ duration_min: "", slot_interval_min: "" })).catch(() => {});
    const row = insert.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(row.duration_min).toBe(EVENT_TYPE_DEFAULTS.duration_min);
    expect(row.slot_interval_min).toBe(EVENT_TYPE_DEFAULTS.slot_interval_min);
    expect(row.min_notice_min).toBe(EVENT_TYPE_DEFAULTS.min_notice_min);
    expect(row.regal_type).toBe(EVENT_TYPE_DEFAULTS.regal_type);
  });

  // #2385: both of these are refusals the admin can fix by retyping, so both
  // come back to the page the add form is on. They used to throw, which in
  // production is the generic error boundary, so the sentence telling somebody
  // their title was already taken was read by nobody.
  const refusalOf = async (run: () => Promise<unknown>): Promise<string> => {
    await run().catch(() => {});
    const call = redirect.mock.calls.at(-1);
    return call ? decodeURIComponent(String(call[0])) : "(no redirect)";
  };

  it("refuses a blank title on the page instead of naming the record itself", async () => {
    const to = await refusalOf(() => createEventType(add({ name: "" })));
    expect(to).toMatch(/^\/admin\/event-types\?error=/);
    expect(to).toMatch(/needs a title/i);
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses a title an event type already has, on the page", async () => {
    const to = await refusalOf(() => createEventType(add({ name: "Senior Loan Advisor Call" })));
    expect(to).toMatch(/^\/admin\/event-types\?error=/);
    expect(to).toMatch(/already exists/i);
    expect(insert).not.toHaveBeenCalled();
  });

  // The duplicate is matched on the NAME rather than on the exact bytes, since
  // "senior loan advisor call " and the record differ by nothing a reader of the
  // list could see.
  it("refuses a title that differs only in case or spacing", async () => {
    const to = await refusalOf(() => createEventType(add({ name: "  senior loan advisor CALL  " })));
    expect(to).toMatch(/already exists/i);
    expect(insert).not.toHaveBeenCalled();
  });

  // The refusal has to fail CLOSED. An unreadable table resolving to an empty
  // list means "no name is taken", which would let the duplicate through exactly
  // when the database is unwell.
  it("refuses when it cannot read what names are taken", async () => {
    dbState.errorByTable = { event_types: { message: "read timeout" } };
    await expect(createEventType(add())).rejects.toThrow(/read failed/i);
    expect(insert).not.toHaveBeenCalled();
  });

  // The message has to name the DATABASE's own reason, not merely say the create
  // failed. The no-row guard below says "could not be created" too, so an
  // assertion on that phrase alone is satisfied by a version that ignores the
  // error entirely and falls through to it (L140), which is what happened when
  // this was first written.
  it("refuses loudly when the insert fails, rather than redrawing as saved", async () => {
    dbState.insertReturnError = { message: "permission denied" };
    await expect(createEventType(add())).rejects.toThrow(/permission denied/);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses when the insert returns no row", async () => {
    dbState.insertReturns = null;
    await expect(createEventType(add())).rejects.toThrow(/no row/i);
  });

  it("records what was created, with the timings that decide every booking", async () => {
    await createEventType(add({ slot_interval_min: "10" })).catch(() => {});
    const entry = recordAudit.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(entry.action).toBe("event_type.created");
    const details = entry.details as Record<string, unknown>;
    expect(details.event_type_id).toBe("et-new");
    expect(details.name).toBe("Quick check in");
    expect(details.slot_interval_min).toBe(10);
  });

  it("refreshes the page its own form is on, and confirms there", async () => {
    await expect(createEventType(add())).rejects.toThrow(
      "NEXT_REDIRECT:/admin/event-types?ok=event-type-created",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/admin/event-types");
  });
});

describe("the webhook test send cannot reach the real destination (#1951)", () => {
  const LIVE = "https://events.regalvoice.com/events";
  let fetched: { url: string; init: RequestInit }[] = [];

  beforeEach(() => {
    auth.requireAdmin.mockResolvedValue(admin);
    rateLimit.allowRequest.mockResolvedValue(true);
    dbState.rowsByTable = { webhook_endpoints: { url: LIVE, format: "regal" } };
    fetched = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetched.push({ url, init });
        return new Response('{"echo":"ok"}', { status: 200 });
      }),
    );
  });

  const send = (target: string) => sendTestWebhook({ error: null, sent: null }, form({ target }));

  it("sends the sample event at the pasted URL and reports what came back", async () => {
    const state = await send("https://webhook.site/abc");
    expect(state.error).toBeNull();
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toBe("https://webhook.site/abc");
    expect(fetched[0].init.method).toBe("POST");
    expect(state.sent?.status).toBe(200);
    expect(state.sent?.ok).toBe(true);
    expect(state.sent?.responseBody).toBe('{"echo":"ok"}');
  });

  it("builds the body in the format the endpoint is configured with", async () => {
    const state = await send("https://webhook.site/abc");
    expect(state.sent?.format).toBe("regal");
    // The real builder, so the headers are the ones that ship.
    const headers = Object.fromEntries(state.sent?.requestHeaders ?? []);
    expect(headers["x-slate-delivery-id"]).toMatch(/^test-/);
    expect(headers.authorization).toBeTruthy();
  });

  // The three things that must never leave, each asserted on what was actually
  // handed to fetch rather than on what the action meant to send.
  it("carries no real key, no real signing secret and no real lead", async () => {
    await send("https://webhook.site/abc");
    const sentHeaders = fetched[0].init.headers as Record<string, string>;
    expect(sentHeaders.authorization).toContain("not-a-real-key");
    const body = String(fetched[0].init.body);
    expect(body).toContain("example.invalid");
    expect(body).not.toContain("@trypennie.com");
  });

  it("refuses the host the live endpoint is on, and sends nothing", async () => {
    const state = await send(LIVE);
    expect(state.error).toMatch(/live endpoint/i);
    expect(fetched).toHaveLength(0);
  });

  it("refuses a private address", async () => {
    const state = await send("https://169.254.169.254/latest/meta-data/");
    expect(state.error).toMatch(/private or local/i);
    expect(fetched).toHaveLength(0);
  });

  it("refuses anything that is not https", async () => {
    const state = await send("http://webhook.site/abc");
    expect(state.error).toMatch(/https/i);
    expect(fetched).toHaveLength(0);
  });

  // The collision check is the only rule standing between a test send and the
  // real destination, so a read that FAILED must refuse rather than resolve to
  // "no endpoint configured" and let every target through.
  it("refuses when it cannot read which endpoint is configured", async () => {
    dbState.errorByTable = { webhook_endpoints: { message: "read timeout" } };
    await expect(send("https://webhook.site/abc")).rejects.toThrow(/read failed/i);
    expect(fetched).toHaveLength(0);
  });

  it("refuses past its rate limit, without sending", async () => {
    rateLimit.allowRequest.mockResolvedValue(false);
    const state = await send("https://webhook.site/abc");
    expect(state.error).toMatch(/wait a minute/i);
    expect(fetched).toHaveLength(0);
  });

  // A test in webhook_deliveries would skew the delivery log, the dead letter
  // sweep and the resend controls.
  it("writes no delivery row, and records the send in the audit trail instead", async () => {
    await send("https://webhook.site/abc");
    expect(insert).not.toHaveBeenCalled();
    const entry = recordAudit.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(entry.action).toBe("webhook.test_sent");
    const details = entry.details as Record<string, unknown>;
    expect(details.host).toBe("webhook.site");
    expect(details.status).toBe(200);
    // The trail records the host, never the whole URL: a scratch URL's path is
    // the secret that makes it private to whoever created it.
    expect(JSON.stringify(details)).not.toContain("/abc");
  });

  it("reports a receiver that answers with a failure, rather than calling it sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const state = await send("https://webhook.site/abc");
    expect(state.sent?.ok).toBe(false);
    expect(state.sent?.status).toBe(500);
    expect(state.sent?.responseBody).toBe("nope");
  });

  it("reports an address that never answers as its own outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network timeout"); }));
    const state = await send("https://webhook.site/abc");
    expect(state.error).toMatch(/could not reach/i);
    expect(state.sent).toBeNull();
  });
});
