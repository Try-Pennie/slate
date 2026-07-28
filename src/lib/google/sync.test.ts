import { describe, it, expect, vi, beforeEach } from "vitest";
import type { supabaseAdmin } from "@/lib/supabase/admin";

// #834: two Google-sync reads were cap-safe only on a data assumption, not a hard
// bound. loadSlateBookingEventIds (one agent's active bookings, no time filter)
// and purgeVanished's reconcile read (one calendar's cached gcal blocks) both now
// page via selectAllPages, so a set that grows past PostgREST's 1,000-row page can
// no longer silently truncate. A truncated dedup set re-mirrors a Slate event as a
// duplicate gcal block (#166); a truncated reconcile set leaves an orphaned block
// over-blocking the agent. These tests drive both reads across the page boundary.

const admin = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => admin.current }));

// #171: cap the calendar pagination loops. calendar.ts is partially mocked so
// ensureWatches sees a truncated calendar list (listCalendars throws the real
// CalendarListTruncated) and syncCalendar sees a page-capped events pass
// (syncEvents returns truncated with no sync token). Every other calendar export
// stays real, including CalendarListTruncated so the sync.ts instanceof matches.
// syncEvents is a vi.fn so a test can override its behavior per case (default:
// a page-capped pass with no token). #916 drives it to THROW a GoogleHttpError to
// exercise the failure-classification wiring in syncCalendar's catch.
const calMock = vi.hoisted(() => ({
  syncEvents: vi.fn(async () => ({ events: [], nextSyncToken: null, truncated: true })),
}));
vi.mock("@/lib/google/calendar", async (importActual) => {
  const actual = await importActual<typeof import("./calendar")>();
  return {
    ...actual,
    listCalendars: async () => {
      throw new actual.CalendarListTruncated();
    },
    syncEvents: calMock.syncEvents,
  };
});

// A public https push URL so ensureWatches proceeds past its skip guard.
vi.mock("@/lib/env", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/env")>();
  return { ...actual, googlePushUrl: () => "https://slate.example.com/api/google/push" };
});

const logSpy = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/log", () => ({ log: logSpy }));

import {
  applyEvents,
  loadSlateBookingEventIds,
  purgeVanished,
  ensureWatches,
  runIncrementalSync,
  loadSyncAgents,
  loadFailingAgents,
} from "./sync";
import { GoogleHttpError } from "@/lib/google/http-error";

/**
 * Chainable stand-in for the supabase client that emulates PostgREST paging:
 * `.range(from,to)` returns that window, a read with no range is capped at the
 * first 1,000 rows (the silent cap the real client applies). `.delete().in("id",
 * ids)` records the ids it was asked to remove. `opts.error` makes every read
 * fail so the throw-on-error path can be exercised.
 */
function pagingDb(
  tables: Record<string, Record<string, unknown>[]>,
  opts: { error?: { message: string } } = {},
) {
  const deleted: unknown[] = [];
  const from = (table: string) => {
    const rows = tables[table] ?? [];
    let range: [number, number] | null = null;
    let mode: "read" | "delete" = "read";
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      is: () => b,
      not: () => b,
      range: (f: number, t: number) => {
        range = [f, t];
        return b;
      },
      delete: () => {
        mode = "delete";
        return b;
      },
      in: (_col: string, vals: unknown[]) => {
        if (mode === "delete") {
          deleted.push(...vals);
          return Promise.resolve({ error: null });
        }
        return b;
      },
      then: (resolve: (v: { data: unknown[] | null; error: unknown }) => unknown) => {
        if (opts.error) return Promise.resolve({ data: null, error: opts.error }).then(resolve);
        const data = range ? rows.slice(range[0], range[1] + 1) : rows.slice(0, 1000);
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return b;
  };
  return { db: { from } as unknown as ReturnType<typeof supabaseAdmin>, deleted };
}

/**
 * Minimal chainable supabase stand-in for the ensureWatches / runIncrementalSync
 * flows (#171). Serves the reads those paths make (users email, agent_calendars,
 * availability_schedules timezone) and records every write so a test can prove a
 * destructive reconcile did NOT run and the sync token was NOT advanced.
 */
function syncFlowDb(opts: {
  email?: string | null;
  calendars?: Record<string, unknown>[];
  timezone?: string;
}) {
  const deletes: string[] = [];
  const inserts: { table: string; rows: unknown }[] = [];
  const updates: { table: string; payload: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    let mode: "read" | "delete" = "read";
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      is: () => b,
      in: () => b,
      or: () => b,
      not: () => b,
      gte: () => b,
      lt: () => b,
      gt: () => b,
      limit: () => b,
      range: () => b,
      insert: (rows: unknown) => {
        inserts.push({ table, rows });
        return Promise.resolve({ error: null });
      },
      update: (payload: Record<string, unknown>) => {
        updates.push({ table, payload });
        return b;
      },
      delete: () => {
        mode = "delete";
        return b;
      },
      maybeSingle: () =>
        Promise.resolve({
          data:
            table === "users" ? (opts.email ? { email: opts.email } : null) : null,
          error: null,
        }),
      then: (resolve: (v: { data: unknown[] | null; error: unknown }) => unknown) => {
        if (mode === "delete") {
          deletes.push(table);
          return Promise.resolve({ error: null }).then(
            resolve as (v: unknown) => unknown,
          );
        }
        let data: unknown[] = [];
        if (table === "agent_calendars") data = opts.calendars ?? [];
        if (table === "availability_schedules")
          data = [{ timezone: opts.timezone ?? "America/New_York" }];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return b;
  };
  return {
    db: { from } as unknown as ReturnType<typeof supabaseAdmin>,
    deletes,
    inserts,
    updates,
  };
}

beforeEach(() => {
  admin.current = null;
  logSpy.info.mockClear();
  logSpy.warn.mockClear();
  logSpy.error.mockClear();
  calMock.syncEvents.mockReset();
  calMock.syncEvents.mockImplementation(async () => ({
    events: [],
    nextSyncToken: null,
    truncated: true,
  }));
});

describe("applyEvents keys + deletes per calendar (#619)", () => {
  // Records the upsert conflict key and the filters on each delete, so we can
  // prove a busy block is keyed and removed per calendar rather than globally by
  // (user_id, gcal_event_id).
  function busyWriteDb() {
    const upserts: { rows: Record<string, unknown>[]; onConflict?: string }[] = [];
    const deletes: { filters: Record<string, unknown> }[] = [];
    const from = () => {
      let del: { filters: Record<string, unknown> } | null = null;
      const b: Record<string, unknown> = {
        upsert: (rows: Record<string, unknown>[], opts: { onConflict?: string }) => {
          upserts.push({ rows, onConflict: opts?.onConflict });
          return Promise.resolve({ error: null });
        },
        delete: () => {
          del = { filters: {} };
          return b;
        },
        eq: (col: string, val: unknown) => {
          if (del) del.filters[col] = val;
          return b;
        },
        in: (col: string, ids: unknown[]) => {
          del!.filters[col] = ids;
          deletes.push(del!);
          return Promise.resolve({ error: null });
        },
      };
      return b;
    };
    return { db: { from } as unknown as ReturnType<typeof supabaseAdmin>, upserts, deletes };
  }

  it("upserts with the 3-part conflict key and scopes the delete to the calendar", async () => {
    const { db, upserts, deletes } = busyWriteDb();
    admin.current = db;
    const events = [
      {
        id: "shared-evt",
        status: "confirmed",
        start: { dateTime: "2026-01-01T10:00:00Z" },
        end: { dateTime: "2026-01-01T11:00:00Z" },
      },
      { id: "gone-evt", status: "cancelled" },
    ];

    await applyEvents("u1", "cal-A", events, new Set(), "UTC");

    expect(upserts).toHaveLength(1);
    expect(upserts[0].onConflict).toBe("user_id,calendar_id,gcal_event_id");
    expect(upserts[0].rows[0]).toMatchObject({
      gcal_event_id: "shared-evt",
      calendar_id: "cal-A",
    });

    // The cancelled event's delete must carry calendar_id=cal-A, so the SAME
    // event id cached on another watched calendar is left intact (#619).
    expect(deletes).toHaveLength(1);
    expect(deletes[0].filters).toMatchObject({
      user_id: "u1",
      calendar_id: "cal-A",
      gcal_event_id: ["gone-evt"],
    });
  });
});

describe("loadSyncAgents fail-loud (#865)", () => {
  it("throws when the bookable-agents read errors, instead of syncing zero agents", async () => {
    // Before #865 this read swallowed the error and returned [], so the cron tick
    // synced NO agents yet still recorded its heartbeat: a broken read that looked
    // like a healthy quiet minute (the #277 class). unwrap makes it fail loud.
    const { db } = pagingDb(
      { users: [{ id: "u1", last_synced_at: null, deactivated_at: null }] },
      { error: { message: "read timeout" } },
    );
    admin.current = db;
    await expect(loadSyncAgents()).rejects.toThrow(/sync-agents/);
  });

  it("returns the roster when the reads succeed (an empty roster is not an error)", async () => {
    const { db } = pagingDb({
      users: [{ id: "u1", last_synced_at: null, deactivated_at: null }],
      agent_calendars: [{ user_id: "u1" }],
    });
    admin.current = db;
    const agents = await loadSyncAgents();
    expect(agents.map((a) => a.userId)).toEqual(["u1"]);
    expect(agents[0].hasCalendars).toBe(true);
  });
});

describe("loadSlateBookingEventIds (#834)", () => {
  it("returns every active-booking event id past the 1,000-row page", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ gcal_event_id: `evt-${i}` }));
    const { db } = pagingDb({ bookings: rows });
    admin.current = db;

    const ids = await loadSlateBookingEventIds("agent-1");

    // The 1,001st id lives on page 2: a single-page read would drop it and the
    // sync would re-mirror that Slate event as a duplicate gcal block.
    expect(ids.size).toBe(1001);
    expect(ids.has("evt-1000")).toBe(true);
  });

  it("throws instead of returning a short set when the read errors", async () => {
    const { db } = pagingDb({ bookings: [] }, { error: { message: "read timeout" } });
    admin.current = db;
    await expect(loadSlateBookingEventIds("agent-1")).rejects.toThrow(/read timeout/);
  });
});

describe("purgeVanished (#834)", () => {
  it("purges a stale gcal block that sits past the 1,000-row page", async () => {
    const blocks = Array.from({ length: 1001 }, (_, i) => ({
      id: `b-${i}`,
      gcal_event_id: `evt-${i}`,
    }));
    const { db, deleted } = pagingDb({ busy_blocks: blocks });
    admin.current = db;

    // A full resync that returned NO current events: every cached block is stale
    // and must be purged. The 1,001st block only surfaces if the read paged.
    await purgeVanished("agent-1", "primary", [], new Set());

    expect(deleted).toHaveLength(1001);
    expect(deleted).toContain("b-1000");
  });

  it("throws instead of silently leaving orphaned blocks when the read errors", async () => {
    const { db } = pagingDb({ busy_blocks: [] }, { error: { message: "read timeout" } });
    admin.current = db;
    await expect(purgeVanished("agent-1", "primary", [], new Set())).rejects.toThrow(
      /read timeout/,
    );
  });
});

describe("ensureWatches on a truncated calendar list (#171)", () => {
  it("errors without reconciling, so no calendar is deleted from a partial list", async () => {
    // The agent has a stored calendar due for renewal, and listCalendars throws
    // CalendarListTruncated (mocked). If ensureWatches swallowed that into the
    // primary-only fallback it would reconcile the stored set against ["primary"]
    // and DELETE this calendar plus its watch and cached busy blocks. It must
    // instead rethrow, report an error, and touch nothing.
    const { db, deletes } = syncFlowDb({
      email: "agent@x.com",
      calendars: [
        {
          id: "cal-1",
          user_id: "agent-1",
          calendar_id: "team-cal",
          watch_expiration: null,
          watch_channel_id: "chan-1",
          watch_resource_id: "res-1",
          consecutive_failures: 0,
          last_success_at: null,
          last_sync_error: null,
        },
      ],
    });
    admin.current = db;

    const result = await ensureWatches("agent-1");

    expect(result.status).toBe("error");
    expect(deletes).toHaveLength(0);
  });
});

describe("syncCalendar on a page-capped events pass (#171)", () => {
  it("keeps the stored sync token and warns instead of advancing past unread pages", async () => {
    // syncEvents (mocked) returns truncated with no next token. syncCalendar must
    // NOT write a sync_token (which would skip the unread pages for good) and must
    // surface the truncation. Health columns may still be written; the sync_token
    // column must not.
    const { db, updates } = syncFlowDb({
      email: "agent@x.com",
      calendars: [
        {
          id: "cal-1",
          user_id: "agent-1",
          calendar_id: "primary",
          sync_token: "stored-token",
          consecutive_failures: 0,
          last_success_at: null,
          last_sync_error: null,
        },
      ],
    });
    admin.current = db;

    const out = await runIncrementalSync("agent-1");

    expect(out.events).toBe(0);
    const advancedToken = updates.some((u) => "sync_token" in u.payload);
    expect(advancedToken).toBe(false);
    expect(logSpy.warn).toHaveBeenCalledWith(
      "google-sync",
      expect.objectContaining({ calendar_id: "primary" }),
    );
  });
});

describe("failure classification wiring (#916)", () => {
  it("records last_failure_kind='gone' when a sync fails with a definitive 4xx", async () => {
    // A 403 from the calendar API (delegation revoked / permission gone) must be
    // classified 'gone' and persisted, so the alert can page it promptly.
    calMock.syncEvents.mockImplementationOnce(async () => {
      throw new GoogleHttpError("calendarList.list failed: 403 forbidden", 403);
    });
    const { db, updates } = syncFlowDb({
      email: "agent@x.com",
      calendars: [
        {
          id: "cal-1",
          user_id: "agent-1",
          calendar_id: "primary",
          sync_token: "stored-token",
          consecutive_failures: 1,
          last_success_at: null,
          last_sync_error: null,
        },
      ],
    });
    admin.current = db;

    // syncCalendar records health then rethrows, so the tick surfaces the error.
    await expect(runIncrementalSync("agent-1")).rejects.toThrow(/403/);
    const health = updates.find(
      (u) => u.table === "agent_calendars" && "last_failure_kind" in u.payload,
    );
    expect(health?.payload.last_failure_kind).toBe("gone");
    expect(health?.payload.consecutive_failures).toBe(2);
  });

  it("classifies a 5xx as transient", async () => {
    calMock.syncEvents.mockImplementationOnce(async () => {
      throw new GoogleHttpError("events.list failed: 503 unavailable", 503);
    });
    const { db, updates } = syncFlowDb({
      email: "agent@x.com",
      calendars: [
        {
          id: "cal-1",
          user_id: "agent-1",
          calendar_id: "primary",
          sync_token: "stored-token",
          consecutive_failures: 0,
          last_success_at: null,
          last_sync_error: null,
        },
      ],
    });
    admin.current = db;

    await expect(runIncrementalSync("agent-1")).rejects.toThrow(/503/);
    const health = updates.find(
      (u) => u.table === "agent_calendars" && "last_failure_kind" in u.payload,
    );
    expect(health?.payload.last_failure_kind).toBe("transient");
  });
});

describe("loadFailingAgents per-kind paging thresholds (#916)", () => {
  // A fake DB serving loadFailingAgents' two reads: the failing agent_calendars
  // rows, then the users they belong to.
  function failingDb(
    cals: Record<string, unknown>[],
    users: Record<string, unknown>[],
  ) {
    return {
      from(table: string) {
        const data = table === "agent_calendars" ? cals : users;
        const builder: Record<string, unknown> = {
          select: () => builder,
          gte: () => Promise.resolve({ data, error: null }),
          in: () => Promise.resolve({ data, error: null }),
        };
        return builder;
      },
    } as unknown as ReturnType<typeof supabaseAdmin>;
  }

  it("pages a gone account at streak 2 but backs a transient one off below streak 4", async () => {
    admin.current = failingDb(
      [
        // gone @ 2 -> pages
        { user_id: "u1", consecutive_failures: 2, last_success_at: null, last_sync_error: "unauthorized_client", last_failure_kind: "gone" },
        // transient @ 3 -> backs off (below TRANSIENT_PAGE_AT=4), must NOT page
        { user_id: "u2", consecutive_failures: 3, last_success_at: null, last_sync_error: "503", last_failure_kind: "transient" },
        // transient well past the #1133 single-agent hold -> pages
        { user_id: "u3", consecutive_failures: 20, last_success_at: null, last_sync_error: "timeout", last_failure_kind: "transient" },
        // legacy null kind @ 2 -> treated as gone, pages (never goes silent)
        { user_id: "u4", consecutive_failures: 2, last_success_at: null, last_sync_error: "old", last_failure_kind: null },
      ],
      [
        { id: "u1", email: "gone@x.com", bookable: true, deactivated_at: null },
        { id: "u2", email: "flaky@x.com", bookable: true, deactivated_at: null },
        { id: "u3", email: "persistent@x.com", bookable: true, deactivated_at: null },
        { id: "u4", email: "legacy@x.com", bookable: true, deactivated_at: null },
      ],
    );

    const failing = (await loadFailingAgents())!;
    const emails = failing.map((f) => f.email).sort();
    expect(emails).toEqual(["gone@x.com", "legacy@x.com", "persistent@x.com"]);
    expect(failing.find((f) => f.email === "gone@x.com")?.failureKind).toBe("gone");
    expect(failing.find((f) => f.email === "persistent@x.com")?.failureKind).toBe("transient");
  });

  // #1133: the blast-radius hold is applied here, AFTER dedup, because it depends
  // on how many agents are affected. The 2026-07-28 page fired for one agent on a
  // Google 503 after ~4 minutes and healed itself with no bookings affected.
  it("holds a LONE transient agent that has only just started failing", async () => {
    admin.current = failingDb(
      [
        {
          user_id: "u1",
          consecutive_failures: 4,
          last_success_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
          last_sync_error: "events.list failed: 503 backendError",
          last_failure_kind: "transient",
        },
      ],
      [{ id: "u1", email: "lone@x.com", bookable: true, deactivated_at: null }],
    );
    expect(await loadFailingAgents()).toEqual([]);
  });

  it("pages a lone transient agent once it has been down past the hold", async () => {
    admin.current = failingDb(
      [
        {
          user_id: "u1",
          consecutive_failures: 15,
          last_success_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
          last_sync_error: "events.list failed: 503 backendError",
          last_failure_kind: "transient",
        },
      ],
      [{ id: "u1", email: "lone@x.com", bookable: true, deactivated_at: null }],
    );
    const failing = (await loadFailingAgents())!;
    expect(failing.map((f) => f.email)).toEqual(["lone@x.com"]);
  });

  it("pages TWO transient agents immediately: a broad failure is systemic, not a blip", async () => {
    const justFailed = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    admin.current = failingDb(
      [
        { user_id: "u1", consecutive_failures: 4, last_success_at: justFailed, last_sync_error: "503", last_failure_kind: "transient" },
        { user_id: "u2", consecutive_failures: 4, last_success_at: justFailed, last_sync_error: "503", last_failure_kind: "transient" },
      ],
      [
        { id: "u1", email: "a@x.com", bookable: true, deactivated_at: null },
        { id: "u2", email: "b@x.com", bookable: true, deactivated_at: null },
      ],
    );
    const failing = (await loadFailingAgents())!;
    expect(failing.map((f) => f.email).sort()).toEqual(["a@x.com", "b@x.com"]);
  });

  // #1134: "nothing is failing" and "we could not find out" must not look the same.
  // These reads deliberately tolerate an error (the every-minute lane retries), but
  // once an empty list started TRIGGERING a recovery notice (#1133), a swallowed
  // read error became a false all-clear: Slack would say sync had recovered on the
  // strength of a failed query. So an unreadable health signal returns null.
  function erroringDb(which: "calendars" | "users") {
    return {
      from(table: string) {
        const failing = which === "calendars" ? "agent_calendars" : "users";
        const builder: Record<string, unknown> = {
          select: () => builder,
          gte: () =>
            Promise.resolve(
              table === failing ? { data: null, error: { message: "boom" } } : { data: [], error: null },
            ),
          in: () =>
            Promise.resolve(
              table === failing ? { data: null, error: { message: "boom" } } : { data: [], error: null },
            ),
        };
        return builder;
      },
    } as unknown as ReturnType<typeof supabaseAdmin>;
  }

  it("returns null (not empty) when the failing-calendar read errors", async () => {
    admin.current = erroringDb("calendars");
    expect(await loadFailingAgents()).toBeNull();
  });

  it("returns null (not empty) when the agent-name read errors", async () => {
    admin.current = {
      from(_table: string) {
        const builder: Record<string, unknown> = {
          select: () => builder,
          gte: () =>
            Promise.resolve({
              data: [
                {
                  user_id: "u1",
                  consecutive_failures: 20,
                  last_success_at: null,
                  last_sync_error: "503",
                  last_failure_kind: "transient",
                },
              ],
              error: null,
            }),
          in: () => Promise.resolve({ data: null, error: { message: "boom" } }),
        };
        return builder;
      },
    } as unknown as ReturnType<typeof supabaseAdmin>;
    expect(await loadFailingAgents()).toBeNull();
  });

  it("returns an empty list when the reads succeed and genuinely nothing is failing", async () => {
    admin.current = failingDb([], []);
    expect(await loadFailingAgents()).toEqual([]);
  });

  it("never holds a gone account, even when it is the only one failing", async () => {
    admin.current = failingDb(
      [
        {
          user_id: "u1",
          consecutive_failures: 2,
          last_success_at: new Date(Date.now() - 60 * 1000).toISOString(),
          last_sync_error: "token mint failed: 401 unauthorized_client",
          last_failure_kind: "gone",
        },
      ],
      [{ id: "u1", email: "revoked@x.com", bookable: true, deactivated_at: null }],
    );
    const failing = (await loadFailingAgents())!;
    expect(failing.map((f) => f.email)).toEqual(["revoked@x.com"]);
  });
});
