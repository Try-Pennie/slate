import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
// Each mocked call is a vi.fn so a test can override it per case. #916 drives
// syncEvents to THROW a GoogleHttpError to exercise the failure-classification
// wiring in syncCalendar's catch; #1150 drives watchCalendar to throw so the
// renewal failure path records its own health.
const calMock = vi.hoisted(() => ({
  syncEvents: vi.fn(async () => ({ events: [], nextSyncToken: null, truncated: true })),
  listCalendars: vi.fn(async (): Promise<unknown[]> => {
    throw new Error("listCalendars not stubbed for this test");
  }),
  watchCalendar: vi.fn(async () => ({
    resourceId: "res-new",
    expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })),
  stopChannel: vi.fn(async () => {}),
}));
vi.mock("@/lib/google/calendar", async (importActual) => {
  const actual = await importActual<typeof import("./calendar")>();
  return {
    ...actual,
    listCalendars: calMock.listCalendars,
    syncEvents: calMock.syncEvents,
    watchCalendar: calMock.watchCalendar,
    stopChannel: calMock.stopChannel,
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

// #3360: the page for an edited time off event rides on the sync. Mocked so each
// case can see WHAT the sync handed it and that a throw inside it cannot fail the
// pass; its own decisions are pinned in src/lib/monitor/ooo-event-mismatch.test.ts.
const oooNotice = vi.hoisted(() => ({
  noticeSyncedOooEvents: vi.fn(async (_deps: { userId: string; events: unknown[] }) => 0),
}));
vi.mock("@/lib/monitor/ooo-event-mismatch", () => oooNotice);

// #3919: what the sync hands the moved invite handler, and what a handler throw does
// to the pass. The handler's own decisions are pinned in scripts/test-invite-moves.ts.
const inviteMoves = vi.hoisted(() => ({
  noticeOutOfStepInvites: vi.fn(async (_deps: unknown, _items: unknown[], _opts?: unknown) => ({
    reverted: 0,
    left: 0,
    refused: 0,
    resized: 0,
    slateOwn: 0,
    nothing: 0,
    failed: [] as { bookingId: string; reason: string }[],
  })),
  reportInviteCheckFailures: vi.fn(async (_email: string, _failed: unknown[]) => {}),
}));
vi.mock("@/lib/google/invite-move-notice", async (importActual) => ({
  ...(await importActual<typeof import("./invite-move-notice")>()),
  noticeOutOfStepInvites: inviteMoves.noticeOutOfStepInvites,
}));
vi.mock("@/lib/google/invite-move-deps", () => ({
  realInviteMoveDeps: (args: unknown) => ({ args }),
  reportInviteCheckFailures: inviteMoves.reportInviteCheckFailures,
}));

import {
  applyEvents,
  loadSlateBookingEventIds,
  purgeVanished,
  ensureWatches,
  runIncrementalSync,
  loadAgentSyncFacts,
  loadSyncAgents,
  loadFailingAgents,
  cleanupOnPoolExit,
  hydrateCalendar,
} from "./sync";
import { LANE_COLUMNS } from "./sync-health";
import {
  syncEligible,
  GONE_BACKOFF_STREAK,
  GONE_RETRY_INTERVAL_MIN,
} from "./sync-coalesce";
import { WATCH_PAGING } from "@/lib/notify/alerts";
import { GoogleHttpError } from "@/lib/google/http-error";
import { SyncTokenExpired } from "@/lib/google/calendar";
import { idFilterBytes, MAX_IN_FILTER_BYTES } from "@/lib/db/id-batch";
import { movedBusyRows } from "./sync-core";
import { BUSY_WINDOW_AHEAD_DAYS } from "./sync-coalesce";

/**
 * Chainable stand-in for the supabase client that emulates PostgREST paging:
 * `.range(from,to)` returns that window, a read with no range is capped at the
 * first 1,000 rows (the silent cap the real client applies). `.delete().in("id",
 * ids)` records the ids it was asked to remove. `opts.error` makes every read
 * fail so the throw-on-error path can be exercised.
 */
/** The bounds a bootstrap pass sent, and a block sitting inside them (#1261). */
const WINDOW = { timeMinIso: "2026-06-08T00:00:00.000Z", timeMaxIso: "2026-06-29T00:00:00.000Z" };
const IN_WINDOW = { starts_at: "2026-06-10T13:00:00.000Z", ends_at: "2026-06-10T13:30:00.000Z" };

function pagingDb(
  tables: Record<string, Record<string, unknown>[]>,
  opts: { error?: { message: string }; deleteError?: { message: string } } = {},
) {
  const deleted: unknown[] = [];
  // #1261: the window filters the read carries, recorded so a test can prove purgeVanished
  // BOUNDS its read rather than only filtering afterwards. A double that silently accepts
  // a call it does not model is a double that proves nothing about it (L143).
  const bounds: { op: string; col: string; value: unknown }[] = [];
  // Each `.delete().in(...)` call as its own array, so a test can prove the ids were
  // sent in BOUNDED batches rather than one request PostgREST would reject on length.
  const deleteBatches: unknown[][] = [];
  const from = (table: string) => {
    // A fixture row naming no primary key is given one by its position, in key order.
    let rows = (tables[table] ?? []).map(
      (r, i): Record<string, unknown> => ({ id: `${table}-${String(i).padStart(6, "0")}`, ...r }),
    );
    let range: [number, number] | null = null;
    let mode: "read" | "delete" = "read";
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      is: () => b,
      not: () => b,
      gt: (col: string, value: unknown) => {
        // The keyset filter a paged read cuts each later page with (2026-10-25) is
        // honoured, and kept apart from the window bounds the tests below count.
        if (col === "id") {
          rows = rows.filter((r) => String(r.id) > String(value));
          return b;
        }
        bounds.push({ op: "gt", col, value });
        return b;
      },
      lt: (col: string, value: unknown) => {
        bounds.push({ op: "lt", col, value });
        return b;
      },
      order: (col: string) => {
        rows = [...rows].sort((x, y) => (String(x[col]) < String(y[col]) ? -1 : 1));
        return b;
      },
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
          deleteBatches.push([...vals]);
          return Promise.resolve({ error: opts.deleteError ?? null, count: opts.deleteError ? null : vals.length });
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
  return { db: { from } as unknown as ReturnType<typeof supabaseAdmin>, deleted, deleteBatches, bounds };
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
  /** Cached gcal blocks, so a test can prove a reconcile that SHOULD be skipped had
   *  something to delete and still deleted nothing. Without these the assertion is
   *  vacuous: an empty table deletes nothing whether the guard exists or not. */
  busyBlocks?: Record<string, unknown>[];
  /** Make every insert refuse, the way Postgres refuses (#2482). */
  insertError?: { message: string };
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
      order: () => b,
      range: () => b,
      insert: (rows: unknown) => {
        inserts.push({ table, rows });
        return Promise.resolve({ error: opts.insertError ?? null });
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
        if (table === "busy_blocks") data = opts.busyBlocks ?? [];
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
  // The #171 truncation case is the default: most tests here never reach the
  // calendar list, and the ones that do want the truncated-list behaviour.
  calMock.listCalendars.mockReset();
  calMock.listCalendars.mockImplementation(async () => {
    const { CalendarListTruncated } = await import("./calendar");
    throw new CalendarListTruncated();
  });
  calMock.watchCalendar.mockReset();
  calMock.watchCalendar.mockImplementation(async () => ({
    resourceId: "res-new",
    expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  }));
  calMock.stopChannel.mockReset();
  calMock.stopChannel.mockImplementation(async () => {});
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
      // #3258: applyEvents reads the stored rows for its upserts first, to count only
      // the ones that move busy time. Nothing is stored here, so every upsert is new.
      let reading = false;
      const b: Record<string, unknown> = {
        select: () => {
          reading = true;
          return b;
        },
        limit: () => Promise.resolve({ data: [], error: null }),
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
          if (reading) return b;
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
    // Dated near now so applyEvents' write window filter (#1264, which reads Date.now())
    // keeps the busy event; this test is about the conflict key and delete scoping.
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString();
    const soonEnd = new Date(Date.now() + 2 * 24 * 60 * 60_000 + 60 * 60_000).toISOString();
    const events = [
      {
        id: "shared-evt",
        status: "confirmed",
        start: { dateTime: soon },
        end: { dateTime: soonEnd },
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

  it("drops an out-of-window event through applyEvents, proving the write filter is wired (#1264)", async () => {
    // applyEvents must pass a real clock to partitionBusyWrites; if that argument were
    // dropped the filter would silently go off. An in-window event upserts and a far
    // future one (well past the 21 day window) is routed to deletes instead, which only
    // happens if applyEvents actually threaded the clock.
    const { db, upserts, deletes } = busyWriteDb();
    admin.current = db;
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString();
    const soonEnd = new Date(Date.now() + 2 * 24 * 60 * 60_000 + 60 * 60_000).toISOString();
    // Derived from the window constant (plus 30 days of slack), so it stays well past the
    // far edge if BUSY_WINDOW_AHEAD_DAYS changes rather than silently landing inside it.
    const farMs = Date.now() + (BUSY_WINDOW_AHEAD_DAYS + 30) * 24 * 60 * 60_000;
    const far = new Date(farMs).toISOString();
    const farEnd = new Date(farMs + 60 * 60_000).toISOString();
    const events = [
      { id: "soon-evt", status: "confirmed", start: { dateTime: soon }, end: { dateTime: soonEnd } },
      { id: "far-evt", status: "confirmed", start: { dateTime: far }, end: { dateTime: farEnd } },
    ];

    await applyEvents("u1", "cal-A", events, new Set(), "UTC");

    const upsertedIds = upserts.flatMap((u) => (u.rows as { gcal_event_id: string }[]).map((r) => r.gcal_event_id));
    expect(upsertedIds).toEqual(["soon-evt"]);
    const deletedIds = deletes.flatMap((d) => d.filters.gcal_event_id as string[]);
    expect(deletedIds).toContain("far-evt");
    expect(upsertedIds).not.toContain("far-evt");
  });

  // #1268: the delete ids ride in the QUERY STRING, where an oversized batch is
  // refused at the transport rather than merely slow. And the refusal is expensive
  // out of proportion to itself: applyEvents throws, so syncCalendar never advances
  // this calendar's sync token, the same pass retries forever, and the agent's cached
  // availability silently stops updating with nothing saying so.
  //
  // Google event ids are neither uuids nor one length (measured in this table: 43
  // characters on average, reaching 181), so the batch is sized by BYTES rather than
  // by a row count that only holds while every id is the same size.
  it("splits a large cancellation batch by URL bytes, not by a row count", async () => {
    const { db, deletes } = busyWriteDb();
    admin.current = db;

    // 600 cancelled events at the average id length measured in production. At the
    // old 500-row batch this went out as one filter of roughly 21,500 bytes and was
    // refused; production accepted 13,028 and refused 14,878.
    const ID_LEN = 43;
    const cancelled = Array.from({ length: 600 }, (_, i) => ({
      id: `evt${String(i).padStart(ID_LEN - 3, "0")}`,
      status: "cancelled",
    }));

    await applyEvents("u1", "cal-A", cancelled, new Set(), "UTC");

    expect(deletes.length).toBeGreaterThan(1);

    // Every batch fits the shared ceiling, and the ceiling is the one every other
    // batching caller reads: a second copy of the number is how they drift apart.
    for (const d of deletes) {
      const ids = d.filters.gcal_event_id as string[];
      expect(idFilterBytes(ids)).toBeLessThanOrEqual(MAX_IN_FILTER_BYTES);
    }

    // Nothing is dropped or duplicated: a lost cancellation leaves a stale block that
    // over-blocks the agent, which is the failure this whole path exists to prevent.
    const sent = deletes.flatMap((d) => d.filters.gcal_event_id as string[]);
    expect(sent).toHaveLength(600);
    expect(new Set(sent).size).toBe(600);
    expect(new Set(sent)).toEqual(new Set(cancelled.map((e) => e.id)));

    // Positive control: the batch size that shipped really is over the ceiling, so
    // this test is measuring something rather than restating an easy pass.
    expect(idFilterBytes(sent.slice(0, 500))).toBeGreaterThan(MAX_IN_FILTER_BYTES);
  });

  // A longer id must yield a SMALLER batch. This is what a row count cannot do, and
  // 181 characters is the worst case measured in this table.
  it("sends fewer ids per request when the ids are longer", async () => {
    const batchesFor = async (idLen: number) => {
      const { db, deletes } = busyWriteDb();
      admin.current = db;
      await applyEvents(
        "u1",
        "cal-A",
        Array.from({ length: 400 }, (_, i) => ({
          id: `e${String(i).padStart(idLen - 1, "0")}`,
          status: "cancelled",
        })),
        new Set(),
        "UTC",
      );
      return deletes.map((d) => (d.filters.gcal_event_id as string[]).length);
    };

    const short = await batchesFor(43);
    const long = await batchesFor(181);

    expect(long[0]).toBeLessThan(short[0]);
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
      ...IN_WINDOW,
    }));
    const { db, deleted } = pagingDb({ busy_blocks: blocks });
    admin.current = db;

    // A full resync that returned NO current events: every cached block is stale
    // and must be purged. The 1,001st block only surfaces if the read paged.
    await purgeVanished("agent-1", "primary", [], new Set(), WINDOW);

    expect(deleted).toHaveLength(1001);
    expect(deleted).toContain("b-1000");
  });

  it("#1261 bounds its READ to the window the pass fetched, on the right two columns", async () => {
    // Not only the judgement. Narrowing the read is what stops the reconcile paging every
    // block an agent owns (one holds 22,137) and, more importantly, it is the query whose
    // shape decides which rows are even candidates for deletion.
    const { db, bounds } = pagingDb({
      busy_blocks: [{ id: "b-1", gcal_event_id: "evt-1", ...IN_WINDOW }],
    });
    admin.current = db;

    await purgeVanished("agent-1", "primary", [], new Set(), WINDOW);

    // The two bounds apply to two DIFFERENT columns, matching Google's own semantics:
    // timeMin bounds the event's END, timeMax bounds its START. Scoping both on starts_at
    // would leave a straddling block inside the fetch but outside the judged range, and
    // its stale row would then survive forever with nothing able to clear it.
    expect(bounds).toContainEqual({ op: "gt", col: "ends_at", value: WINDOW.timeMinIso });
    expect(bounds).toContainEqual({ op: "lt", col: "starts_at", value: WINDOW.timeMaxIso });
    // And exactly those two, so a third bound cannot quietly narrow it further.
    expect(bounds).toHaveLength(2);
  });

  it("throws instead of silently leaving orphaned blocks when the read errors", async () => {
    const { db } = pagingDb({ busy_blocks: [] }, { error: { message: "read timeout" } });
    admin.current = db;
    await expect(purgeVanished("agent-1", "primary", [], new Set(), WINDOW)).rejects.toThrow(
      /read timeout/,
    );
  });
});

describe("purgeVanished sends its delete in bounded batches (#1259)", () => {
  it("never puts more than one URL-safe batch of ids in a single delete", async () => {
    // The ids travel in the query string, so a large stale set is not just slow, it
    // is REFUSED: measured against prod PostgREST, 350 uuids (13,028 bytes) is
    // accepted and 400 (14,878) is not. A bootstrap routinely produces a big stale
    // set, because the fetch's timeMin excludes every block that ended more than a
    // day ago, so all of them come back as "vanished".
    const blocks = Array.from({ length: 1001 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      gcal_event_id: `evt-${i}`,
      ...IN_WINDOW,
    }));
    const { db, deleted, deleteBatches } = pagingDb({ busy_blocks: blocks });
    admin.current = db;

    await purgeVanished("agent-1", "primary", [], new Set(), WINDOW);

    expect(deleted).toHaveLength(1001);
    // Asserted in BYTES, which is the quantity PostgREST actually refuses on
    // (#1321). A row-count assertion passes for any count, including one carried
    // over from a call site whose ids were shorter, which is how this class of
    // defect shipped three times.
    for (const batch of deleteBatches) {
      expect(idFilterBytes(batch as string[])).toBeLessThanOrEqual(MAX_IN_FILTER_BYTES);
    }
    // And it really did chunk rather than sending one oversized request.
    expect(deleteBatches.length).toBeGreaterThan(1);
  });

  it("throws when a delete fails, rather than reporting a clean reconcile", async () => {
    // An unchecked delete error leaves the stale blocks in place while the sync
    // reports success and advances its token, so the agent stays falsely busy with
    // nothing anywhere saying the cleanup failed.
    const blocks = [{ id: "b-1", gcal_event_id: "evt-1", ...IN_WINDOW }];
    const { db } = pagingDb({ busy_blocks: blocks }, { deleteError: { message: "permission denied" } });
    admin.current = db;

    await expect(purgeVanished("agent-1", "primary", [], new Set(), WINDOW)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("a truncated BOOTSTRAP must not reconcile (#1259)", () => {
  it("deletes nothing when the first full pass only read some of the pages", async () => {
    // The dangerous shape the existing #171 test does not cover: no stored token, so
    // this is a full sync and the reconcile is armed, AND the events pass hit the page
    // cap. Reconciling against a partial event set judges every event on the unread
    // pages as vanished and deletes its cached busy time.
    const { db, deletes } = syncFlowDb({
      email: "agent@x.com",
      calendars: [
        {
          id: "cal-1",
          user_id: "agent-1",
          calendar_id: "primary",
          sync_token: null,
          consecutive_failures: 0,
          last_success_at: null,
          last_sync_error: null,
        },
      ],
      // Real cached busy time, so an unguarded reconcile WOULD delete it. Without
      // these rows the assertion below passes whether the guard exists or not.
      busyBlocks: [
        { id: "b-1", gcal_event_id: "evt-on-an-unread-page" },
        { id: "b-2", gcal_event_id: "evt-also-unread" },
      ],
    });
    admin.current = db;

    await runIncrementalSync("agent-1");

    expect(deletes).not.toContain("busy_blocks");
  });
});

describe("ensureWatches on a truncated calendar list (#171)", () => {
  it("errors without reconciling, so no calendar is deleted from a partial list", async () => {
    // The agent has a stored calendar due for renewal, and listCalendars throws
    // CalendarListTruncated (mocked). A partial list is not authoritative, so
    // reconciling against it would DELETE this calendar plus its watch and cached
    // busy blocks. It must instead rethrow, report an error, and touch nothing.
    //
    // This comment used to describe the primary-only fallback as the thing that
    // would do the deleting, and it was right: that fallback did exactly this to
    // every OTHER way the listing could fail, while only truncation was guarded
    // (#2380). The describe above now covers the rest, and the fallback is gone.
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

describe("ensureWatches when the calendar list cannot be read at all (#2380)", () => {
  // The stored id here is an EMAIL, which is what production holds and what every
  // fixture in this file used to hide. Google reports the primary calendar's id as
  // the user's address (scripts/test-calendar-select.ts:8 has the realistic shape),
  // selectableCalendarIds keeps the entry with primary === true and stores ITS id,
  // and booking/service.ts records that the bulk free/busy must never see the
  // literal "primary". A fixture storing "primary" agrees with the old fallback by
  // construction, so the mismatch this whole describe is about could never appear.
  const storedPrimary = "agent@x.com";
  const calendarDueForRenewal = {
    id: "cal-1",
    user_id: "agent-1",
    calendar_id: storedPrimary,
    watch_expiration: null,
    watch_channel_id: "chan-1",
    watch_resource_id: "res-1",
    consecutive_failures: 0,
    last_success_at: null,
    last_sync_error: null,
  };

  // Every shape `ok()` (src/lib/google/calendar.ts) can throw that is NOT a
  // truncation. The no-scope 403 the primary-only fallback was written for cannot
  // reach here any more: dwd.ts grants calendar.readonly and
  // classifyCalendarReachability requires this same listing to SUCCEED before
  // anyone becomes bookable, so what is left is Google having a bad minute.
  const unreadable: [string, () => Error][] = [
    ["a 503 from calendarList", () => new GoogleHttpError("calendarList.list failed: 503", 503, "backendError")],
    ["a 429 rate limit", () => new GoogleHttpError("calendarList.list failed: 429", 429, "rateLimitExceeded")],
    ["a dropped socket", () => new TypeError("fetch failed")],
  ];

  it.each(unreadable)("reconciles nothing on %s", async (_label, makeError) => {
    // The defect: any non-truncation failure fell back to ["primary"], which the
    // stored email can never match, so the reconcile judged the agent's real
    // calendar vanished. That stopped their push channel, deleted every cached
    // busy block for the calendar, deleted the agent_calendars row with its sync
    // token and both health streaks, and inserted a row keyed "primary" instead.
    // The agent then reads as free all day until the sync lane bootstraps them,
    // and the lane reported the watch as renewed while it happened.
    const { db, deletes, inserts } = syncFlowDb({
      email: "agent@x.com",
      calendars: [calendarDueForRenewal],
      // Real cached busy time, so the "deleted nothing" assertion has something it
      // could have destroyed.
      busyBlocks: [{ id: "b-1", gcal_event_id: "evt-1" }],
    });
    admin.current = db;
    calMock.listCalendars.mockRejectedValue(makeError());

    const result = await ensureWatches("agent-1");

    // All four halves of the teardown, not just one: the watch, the cached busy
    // time, the calendar row, and the alias row that replaced it. Asserted before
    // the status, because the damage is the subject and the status is the symptom.
    expect(calMock.stopChannel).not.toHaveBeenCalled();
    expect(deletes).not.toContain("busy_blocks");
    expect(deletes).not.toContain("agent_calendars");
    expect(inserts).toHaveLength(0);
    expect(result.status).toBe("error");
  });

  it("says which way Google failed rather than reconciling quietly", async () => {
    // The old fallback logged nothing at all, so the only trace of a destroyed
    // calendar was sync_window_to going null on a row that had not existed a
    // minute earlier. The kind comes from reachabilityFromError, the shared
    // classifier, so a not-provisioned account is not reported as transient.
    const { db } = syncFlowDb({
      email: "agent@x.com",
      calendars: [calendarDueForRenewal],
    });
    admin.current = db;
    calMock.listCalendars.mockRejectedValue(
      new GoogleHttpError("calendarList.list failed: 503", 503, "backendError"),
    );

    await ensureWatches("agent-1");

    expect(logSpy.warn).toHaveBeenCalledWith(
      "sync",
      expect.objectContaining({ user_id: "agent-1", kind: "transient" }),
      expect.anything(),
    );
  });

  it("still reconciles when Google DOES answer, so a removed calendar is cleaned up", async () => {
    // The positive control. Refusing every failure must not turn the reconcile off:
    // a calendar Google's own successful listing no longer names is still deleted
    // with its watch and its cached busy time.
    const { db, deletes } = syncFlowDb({
      email: "agent@x.com",
      calendars: [
        calendarDueForRenewal,
        { ...calendarDueForRenewal, id: "cal-2", calendar_id: "team-cal@x.com" },
      ],
      busyBlocks: [{ id: "b-1", gcal_event_id: "evt-1" }],
    });
    admin.current = db;
    calMock.listCalendars.mockResolvedValue([{ id: storedPrimary, primary: true }]);

    const result = await ensureWatches("agent-1");

    expect(result.status).toBe("renewed");
    expect(calMock.stopChannel).toHaveBeenCalled();
    expect(deletes).toContain("busy_blocks");
    expect(deletes).toContain("agent_calendars");
  });
});

describe("ensureWatches on a corrupt watch_expiration (#1169)", () => {
  it("treats an unparseable expiration as due for renewal, never as current", async () => {
    // A corrupt stamp used to parse to NaN, so "expires soon?" compared false and
    // ensureWatches returned "current" forever: the channel silently lapsed and
    // push updates stopped, exactly the failure the renewal check exists to
    // prevent. Unreadable must land on the DUE side. listCalendars returns the
    // same stored primary calendar, so the reconcile is a no-op and the mocked
    // watchCalendar performs the renewal.
    //
    // The id is an EMAIL on both sides, which is what Google returns and what
    // Slate stores (#2380). It said "primary" on both sides until then, a value
    // production never holds, and a fixture agreeing with itself about the wrong
    // value is how the reconcile's alias fallback stayed invisible here.
    const { db, deletes } = syncFlowDb({
      email: "agent@x.com",
      calendars: [
        {
          id: "cal-1",
          user_id: "agent-1",
          calendar_id: "agent@x.com",
          watch_expiration: "not-a-timestamp",
          watch_channel_id: "chan-1",
          watch_resource_id: "res-1",
          consecutive_failures: 0,
          last_success_at: null,
          last_sync_error: null,
        },
      ],
    });
    admin.current = db;
    calMock.listCalendars.mockResolvedValue([{ id: "agent@x.com", primary: true }]);

    const result = await ensureWatches("agent-1");

    expect(result).toEqual({ status: "renewed" });
    expect(calMock.watchCalendar).toHaveBeenCalled();
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

describe("the sync and watch lanes keep separate failure counters (#1150)", () => {
  // The two lanes used to share one `consecutive_failures` column. The 1-min sync
  // lane resets it on every success and the ~5-min watch lane increments it, so a
  // renewal failure was wiped within a minute and could never reach a paging
  // threshold. "Google push is degraded but events still sync" was unalertable,
  // which is precisely the condition the watch-lapse alert exists to report.
  //
  // These assert the STRUCTURE that makes that impossible: each lane's write may
  // only touch its own columns. A test that merely checked the counter reached 2
  // would pass while the other lane was still free to zero it a minute later.
  const dueCalendar = {
    id: "cal-1",
    user_id: "agent-1",
    calendar_id: "primary",
    // No expiry stored, so dueForRenewal is true and the renewal loop runs.
    watch_expiration: null,
    watch_channel_id: null,
    watch_resource_id: null,
    sync_token: "stored-token",
    consecutive_failures: 0,
    last_success_at: null,
    last_sync_error: null,
    last_failure_kind: null,
    watch_consecutive_failures: 0,
    watch_last_success_at: null,
    watch_last_error: null,
    watch_last_failure_kind: null,
  };

  /** The agent_calendars health write a lane made, if any. */
  function healthWrite(
    updates: { table: string; payload: Record<string, unknown> }[],
    column: string,
  ) {
    return updates.find((u) => u.table === "agent_calendars" && column in u.payload);
  }

  it("records a failed renewal on the watch counter, never on the sync counter", async () => {
    calMock.listCalendars.mockImplementation(async () => [{ id: "primary", primary: true }]);
    calMock.watchCalendar.mockImplementation(async () => {
      throw new GoogleHttpError("watch failed: 503 backendError", 503);
    });
    const { db, updates } = syncFlowDb({
      email: "agent@x.com",
      calendars: [{ ...dueCalendar, watch_consecutive_failures: 1 }],
    });
    admin.current = db;

    const result = await ensureWatches("agent-1");

    expect(result.status).toBe("error");
    const watch = healthWrite(updates, "watch_consecutive_failures");
    expect(watch?.payload.watch_consecutive_failures).toBe(2);
    expect(watch?.payload.watch_last_failure_kind).toBe("transient");
    // The sync counter must be absent from the payload entirely: writing even a
    // correct value here is what let the two lanes overwrite each other.
    expect(watch?.payload).not.toHaveProperty(LANE_COLUMNS.sync.failures);
    expect(healthWrite(updates, LANE_COLUMNS.sync.failures)).toBeUndefined();
  });

  it("records a successful sync on the sync counter, leaving a watch streak standing", async () => {
    // This is the exact overwrite that made the watch alert unreachable: the
    // calendar's renewal has failed twice, and a minute later the sync succeeds.
    calMock.syncEvents.mockImplementation(async () => ({
      events: [],
      nextSyncToken: null,
      truncated: false,
    }));
    const { db, updates } = syncFlowDb({
      email: "agent@x.com",
      calendars: [{ ...dueCalendar, watch_consecutive_failures: 2 }],
    });
    admin.current = db;

    await runIncrementalSync("agent-1");

    const sync = healthWrite(updates, "consecutive_failures");
    expect(sync?.payload.consecutive_failures).toBe(0);
    // Asserted through the shared column map, NOT a hardcoded "watch_..." name.
    // A literal name could never catch the original bug, where the watch streak
    // lived in `consecutive_failures` and this very write cleared it. Reading the
    // column the watch lane actually uses makes the test red on that arrangement.
    expect(sync?.payload).not.toHaveProperty(LANE_COLUMNS.watch.failures);
    expect(healthWrite(updates, LANE_COLUMNS.watch.failures)).toBeUndefined();
  });

  it("records a successful renewal on the watch counter, leaving a sync streak standing", async () => {
    // The same defect in the other direction: a renewal succeeding used to zero a
    // genuine sync-failure streak. Rarer, because renewals only fire within three
    // days of expiry, but the same class.
    calMock.listCalendars.mockImplementation(async () => [{ id: "primary", primary: true }]);
    const { db, updates } = syncFlowDb({
      email: "agent@x.com",
      calendars: [{ ...dueCalendar, consecutive_failures: 3, last_sync_error: "503" }],
    });
    admin.current = db;

    const result = await ensureWatches("agent-1");

    expect(result.status).toBe("renewed");
    const watch = healthWrite(updates, "watch_consecutive_failures");
    expect(watch?.payload.watch_consecutive_failures).toBe(0);
    expect(watch?.payload.watch_channel_id).toBeTruthy();
    expect(watch?.payload).not.toHaveProperty(LANE_COLUMNS.sync.failures);
    expect(healthWrite(updates, LANE_COLUMNS.sync.failures)).toBeUndefined();
  });
});

describe("leaving the bookable pool clears the watch health (#1150)", () => {
  // Now that the watch streak PERSISTS (nothing else resets it between renewal
  // attempts), a pool exit has to clear it. Otherwise an agent who left while
  // their renewal was failing keeps the streak indefinitely, and pages the moment
  // they are made bookable again, before a single renewal has been attempted.
  // The 1-min sync lane used to zero this column, which hid the need.
  it("clears a failing watch streak even when no live channel is left to stop", async () => {
    const { db, updates } = syncFlowDb({
      email: "agent@x.com",
      calendars: [
        {
          id: "cal-1",
          user_id: "agent-1",
          calendar_id: "primary",
          // A failed renewal leaves no channel behind, so the pre-#1150 guard
          // ("only write when a watch column is set") would skip the write.
          watch_channel_id: null,
          watch_resource_id: null,
          watch_expiration: null,
          watch_consecutive_failures: 4,
          watch_last_success_at: null,
          watch_last_error: "watch failed: 401 unauthorized_client",
          watch_last_failure_kind: "gone",
        },
      ],
    });
    admin.current = db;

    await cleanupOnPoolExit("agent-1");

    const cleared = updates.find(
      (u) => u.table === "agent_calendars" && "watch_consecutive_failures" in u.payload,
    );
    expect(cleared?.payload.watch_consecutive_failures).toBe(0);
    expect(cleared?.payload.watch_last_error).toBeNull();
    expect(cleared?.payload.watch_last_failure_kind).toBeNull();
    // The sync lane's own health is NOT this function's business to reset.
    expect(cleared?.payload).not.toHaveProperty(LANE_COLUMNS.sync.failures);
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

  // The same stand-in, named for the watch lane (#1150). The fake serves whatever
  // rows it is given regardless of which column the query filtered on, so the
  // rows themselves carry the watch_* columns the watch lane must read.
  const failingWatchDb = failingDb;

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

  it("pages a lone transient WATCH failure on pass count alone, ignoring the ancient last-renewal stamp", async () => {
    // #1150: a healthy watch channel is renewed about every four days, so
    // `watch_last_success_at` is ALWAYS ancient and the #1133 elapsed-time signal
    // cannot tell a healthy calendar from a failing one. The watch lane therefore
    // holds a lone transient on the pass count only. Four passes (~20 min at the
    // 5-min cadence) is still inside the hold even though the last success was
    // four days ago, which would have released it instantly on the sync policy.
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    admin.current = failingWatchDb(
      [
        {
          user_id: "u1",
          watch_consecutive_failures: 4,
          watch_last_success_at: fourDaysAgo,
          watch_last_error: "watch failed: 503 backendError",
          watch_last_failure_kind: "transient",
        },
      ],
      [{ id: "u1", email: "lone@x.com", bookable: true, deactivated_at: null }],
    );
    expect(await loadFailingAgents("watch")).toEqual([]);

    // Positive control in the same test: the hold must RELEASE on pass count, or
    // the assertion above would also pass on a watch lane that can never page at
    // all, which is the very bug being fixed.
    admin.current = failingWatchDb(
      [
        {
          user_id: "u1",
          watch_consecutive_failures: WATCH_PAGING.loneTransientPasses,
          watch_last_success_at: fourDaysAgo,
          watch_last_error: "watch failed: 503 backendError",
          watch_last_failure_kind: "transient",
        },
      ],
      [{ id: "u1", email: "lone@x.com", bookable: true, deactivated_at: null }],
    );
    const failing = (await loadFailingAgents("watch"))!;
    expect(failing.map((f) => f.email)).toEqual(["lone@x.com"]);
  });

  it("reads the WATCH columns, so a healthy sync counter cannot hide a watch failure", async () => {
    // The whole point of #1150: this row is syncing perfectly (streak 0) while its
    // push renewal is dead. Reading the sync columns would return nothing.
    admin.current = failingWatchDb(
      [
        {
          user_id: "u1",
          consecutive_failures: 0,
          last_success_at: new Date().toISOString(),
          last_sync_error: null,
          last_failure_kind: null,
          watch_consecutive_failures: 3,
          watch_last_success_at: null,
          watch_last_error: "watch failed: 401 unauthorized_client",
          watch_last_failure_kind: "gone",
        },
      ],
      [{ id: "u1", email: "pushdead@x.com", bookable: true, deactivated_at: null }],
    );
    const failing = (await loadFailingAgents("watch"))!;
    expect(failing.map((f) => f.email)).toEqual(["pushdead@x.com"]);
    expect(failing[0].failureKind).toBe("gone");
    expect(failing[0].error).toBe("watch failed: 401 unauthorized_client");
  });

  it("returns null (not empty) when the WATCH health read errors", async () => {
    // Same #1134 rule on the watch lane: an unreadable signal must not all-clear
    // the watch-lapse page.
    admin.current = erroringDb("calendars");
    expect(await loadFailingAgents("watch")).toBeNull();
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

describe("runIncrementalSync with the tick's advisor facts (#3489)", () => {
  // The cron tick read every advisor's email and zone with two requests EACH, every
  // minute, before reading their calendars: 180 requests a minute for 90 advisors in
  // the load test, front loaded into the tick that slowed bookings in the first half
  // of each minute (load run 37739581575). The tick now reads them once for everybody
  // and hands each advisor's sync its own. The calendar rows are still read per
  // advisor, because they carry the sync token and the claims another pass holds
  // (#2411), which must be read fresh.
  const calendar = {
    id: "cal-1",
    user_id: "agent-1",
    calendar_id: "primary",
    sync_token: "tok",
    consecutive_failures: 0,
    last_success_at: null,
    last_sync_error: null,
  };
  const counted = (db: ReturnType<typeof syncFlowDb>["db"]) => {
    const reads: string[] = [];
    const from = (db as unknown as { from: (t: string) => unknown }).from;
    (db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      reads.push(t);
      return from(t);
    };
    return reads;
  };

  it("reads neither the advisor's email nor zone, and syncs with the ones it was given", async () => {
    const { db } = syncFlowDb({ email: "stale@x.com", timezone: "America/New_York", calendars: [calendar] });
    admin.current = db;
    const reads = counted(db);
    await runIncrementalSync("agent-1", null, { email: "agent@x.com", timeZone: "America/Phoenix" });
    expect(reads).not.toContain("users");
    expect(reads).not.toContain("availability_schedules");
    expect(reads).toContain("agent_calendars");
    expect((calMock.syncEvents.mock.calls[0] as unknown[] | undefined)?.[0]).toBe("agent@x.com");
  });

  it("syncs nothing for an advisor the tick found with no email, as before", async () => {
    const { db } = syncFlowDb({ email: "agent@x.com", calendars: [calendar] });
    admin.current = db;
    const reads = counted(db);
    const out = await runIncrementalSync("agent-1", null, { email: null, timeZone: "America/New_York" });
    expect(out.events).toBe(0);
    expect(reads).toEqual([]);
    expect(calMock.syncEvents).not.toHaveBeenCalled();
  });

  it("saves the advanced token and the health stamp in ONE write", async () => {
    // Two writes per advisor per minute were the token and the health stamp, both on
    // the same row after the same pass. They were split (2026-06-19) only so the token
    // saved while migration 0038's health columns might not exist yet; the deploy gate
    // now refuses code ahead of its schema, so one write saves both.
    calMock.syncEvents.mockResolvedValueOnce({ events: [], nextSyncToken: "tok-2", truncated: false } as never);
    const { db, updates } = syncFlowDb({ email: "agent@x.com", calendars: [calendar] });
    admin.current = db;
    await runIncrementalSync("agent-1", null, { email: "agent@x.com", timeZone: "America/New_York" });
    const writes = updates.filter((u) => u.table === "agent_calendars");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.payload.sync_token).toBe("tok-2");
    expect(writes[0]!.payload[LANE_COLUMNS.sync.failures]).toBe(0);
    expect(writes[0]!.payload[LANE_COLUMNS.sync.lastSuccess]).toEqual(expect.any(String));
  });

  it("a page capped pass still writes its health and never a token", async () => {
    calMock.syncEvents.mockResolvedValueOnce({ events: [], nextSyncToken: null, truncated: true } as never);
    const { db, updates } = syncFlowDb({ email: "agent@x.com", calendars: [calendar] });
    admin.current = db;
    await runIncrementalSync("agent-1", null, { email: "agent@x.com", timeZone: "America/New_York" });
    const writes = updates.filter((u) => u.table === "agent_calendars");
    expect(writes).toHaveLength(1);
    expect("sync_token" in writes[0]!.payload).toBe(false);
    expect(writes[0]!.payload[LANE_COLUMNS.sync.failures]).toBe(0);
  });

  it("control: without them it reads both, as the push path still does", async () => {
    const { db } = syncFlowDb({ email: "agent@x.com", calendars: [calendar] });
    admin.current = db;
    const reads = counted(db);
    await runIncrementalSync("agent-1");
    expect(reads).toContain("users");
    expect(reads).toContain("availability_schedules");
  });
});

describe("loadAgentSyncFacts (#3489)", () => {
  function factsDb(opts: { users: Record<string, unknown>[]; schedules: Record<string, unknown>[]; fail?: string }) {
    const reads: string[] = [];
    const db = {
      from: (table: string) => {
        reads.push(table);
        const b: Record<string, unknown> = {
          select: () => b,
          in: () => b,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(
              opts.fail === table
                ? { data: null, error: { message: "statement timeout" } }
                : { data: table === "users" ? opts.users : opts.schedules, error: null },
            ).then(resolve),
        };
        return b;
      },
    };
    return { db, reads };
  }

  it("reads every advisor's email and zone in two reads, defaulting a missing zone and a missing advisor", async () => {
    const { db, reads } = factsDb({
      users: [
        { id: "a", email: "a@x.com" },
        { id: "b", email: null },
      ],
      schedules: [{ user_id: "a", timezone: "America/Phoenix" }],
    });
    admin.current = db;
    const facts = await loadAgentSyncFacts(["a", "b", "gone"]);
    expect(reads.sort()).toEqual(["availability_schedules", "users"]);
    expect(facts?.get("a")).toEqual({ email: "a@x.com", timeZone: "America/Phoenix" });
    expect(facts?.get("b")).toEqual({ email: null, timeZone: "America/New_York" });
    expect(facts?.get("gone")).toEqual({ email: null, timeZone: "America/New_York" });
  });

  it("answers null on a failed read, never an empty or partial map read as advisors with no email", async () => {
    for (const fail of ["users", "availability_schedules"]) {
      const { db } = factsDb({ users: [{ id: "a", email: "a@x.com" }], schedules: [], fail });
      admin.current = db;
      expect(await loadAgentSyncFacts(["a"])).toBeNull();
    }
  });

  it("reads nothing for no advisors", async () => {
    const { db, reads } = factsDb({ users: [], schedules: [] });
    admin.current = db;
    expect((await loadAgentSyncFacts([]))?.size).toBe(0);
    expect(reads).toEqual([]);
  });
});

// #1187: the #1049 backoff removed the wasted Google calls for calendars
// established as gone, but those calls were also the incidental signal that
// something was wrong. A Workspace change that revokes delegation for thirty
// agents at once now makes the rotation lane QUIETER, not noisier. The lane has
// to report the size of the population it is skipping, or the scale of a
// revocation is unreportable.
describe("runIncrementalSync reports the calendars it backed off (#1187)", () => {
  /**
   * A wall-clock ms value at which `id` is NOT due for its once-per-interval
   * retry. Searched through the real `syncEligible` rather than hand-picked: a
   * pinned literal would keep passing if the slot rule changed under it, and a
   * test that runs on the real clock would be eligible (so green for the wrong
   * reason) on one minute in every GONE_RETRY_INTERVAL_MIN.
   */
  function backedOffAtMs(id: string): number {
    const gone = {
      id,
      last_failure_kind: "gone" as const,
      consecutive_failures: GONE_BACKOFF_STREAK,
    };
    const base = Date.UTC(2026, 6, 30, 12, 0, 0);
    for (let i = 0; i <= GONE_RETRY_INTERVAL_MIN; i++) {
      const ms = base + i * 60_000;
      if (!syncEligible(gone, ms)) return ms;
    }
    throw new Error(`no backed-off minute found for ${id}`);
  }

  const healthy = {
    id: "cal-ok",
    user_id: "agent-1",
    calendar_id: "primary",
    sync_token: "tok",
    consecutive_failures: 0,
    last_failure_kind: null,
    last_success_at: null,
    last_sync_error: null,
  };
  const gone = {
    id: "cal-gone",
    user_id: "agent-1",
    calendar_id: "revoked@x.com",
    sync_token: "tok",
    consecutive_failures: GONE_BACKOFF_STREAK,
    last_failure_kind: "gone",
    last_success_at: null,
    last_sync_error: "token mint failed: 401 unauthorized_client",
  };

  beforeEach(() => {
    // Only Date: the flow awaits real promises, and faking timers wholesale
    // would stall anything that yields to the macrotask queue.
    vi.useFakeTimers({ toFake: ["Date"] });
    calMock.syncEvents.mockImplementation(async () => ({
      events: [],
      nextSyncToken: null,
      truncated: false,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the calendar it skipped, and syncs only the one that was due", async () => {
    vi.setSystemTime(backedOffAtMs(gone.id));
    const { db } = syncFlowDb({ email: "agent@x.com", calendars: [healthy, gone] });
    admin.current = db;

    const out = await runIncrementalSync("agent-1");

    expect(out.goneSkipped).toBe(1);
    // The count has to describe what the lane actually did, so prove the skip
    // really happened rather than trusting the number on its own.
    expect(calMock.syncEvents).toHaveBeenCalledTimes(1);
  });

  it("reports zero when every calendar was attempted", async () => {
    vi.setSystemTime(backedOffAtMs(gone.id));
    const { db } = syncFlowDb({ email: "agent@x.com", calendars: [healthy] });
    admin.current = db;

    const out = await runIncrementalSync("agent-1");

    expect(out.goneSkipped).toBe(0);
    expect(calMock.syncEvents).toHaveBeenCalledTimes(1);
  });

  it("reports zero for an agent with no mailbox, rather than leaving it undefined", async () => {
    // The early return is the shape most likely to be missed, and an undefined
    // here would sum into NaN across the tick and make the field unreadable.
    const { db } = syncFlowDb({ email: null, calendars: [gone] });
    admin.current = db;

    const out = await runIncrementalSync("agent-1");

    expect(out.goneSkipped).toBe(0);
  });
});

describe("hydrateCalendar write ordering (#1261)", () => {
  /**
   * Records every `.update()` in order, with the filters that accompanied it, so the
   * ORDER and the CONDITIONS can be asserted rather than only the final state. The
   * ordering is the design here: which write happens before the fetch, which happens only
   * on success, and which is conditional.
   */
  function recordingDb(storedToken: string | null = null) {
    const updates: { table: string; values: Record<string, unknown>; filters: string[] }[] = [];
    const from = (table: string) => {
      // #2411: whether THIS builder is a write. The claim is an
      // `update(...).select("id")`, whose rows say whether it was won, while every read
      // through this fake resolves to no rows. One `then` answering both would either
      // refuse every claim (so nothing below would run) or hand `selectAllPages` a row
      // it never asked for.
      let isWrite = false;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          const last = updates[updates.length - 1];
          if (last && last.table === table) last.filters.push(`eq:${col}=${String(val)}`);
          return b;
        },
        is: (col: string, val: unknown) => {
          const last = updates[updates.length - 1];
          if (last && last.table === table) last.filters.push(`is:${col}=${String(val)}`);
          return b;
        },
        gt: () => b,
        lt: () => b,
        in: () => b,
        not: () => b,
        limit: () => b,
        order: () => b,
        range: () => b,
        // The agent's mailbox, so hydrateCalendar gets past its no-mailbox guard. A fake
        // that answered null would make every success-path assertion below pass for the
        // wrong reason, by never reaching the code under test at all (L143).
        // #2411: the claim predicate. Accepted so the fake answers the chain the code
        // really builds; the claim's outcome is decided by the rows `then` returns.
        or: () => b,
        maybeSingle: () =>
          Promise.resolve({
            data:
              table === "users"
                ? { email: "agent@trypennie.com" }
                : // #2411: the post-fetch token re-read. It must report the token this
                  // pass started with, or every case below would abandon itself as a
                  // race and pass for the wrong reason (L143).
                  table === "agent_calendars"
                  ? { sync_token: storedToken }
                  : null,
            error: null,
          }),
        upsert: () => Promise.resolve({ error: null }),
        delete: () => b,
        update: (values: Record<string, unknown>) => {
          isWrite = true;
          updates.push({ table, values, filters: [] });
          return b;
        },
        then: (resolve: (v: { data: unknown[]; error: unknown }) => unknown) =>
          Promise.resolve({ data: isWrite ? [{ id: "cal-1" }] : [], error: null }).then(
            resolve,
          ),
      };
      return b;
    };
    return { db: { from } as unknown as ReturnType<typeof supabaseAdmin>, updates };
  }

  const cal = (token: string | null) =>
    ({
      id: "cal-1",
      user_id: "agent-1",
      calendar_id: "primary",
      sync_token: token,
      consecutive_failures: 0,
      last_success_at: null,
      last_sync_error: null,
      last_failure_kind: null,
    }) as never;

  type Recorded = { table: string; values: Record<string, unknown>; filters: string[] };
  const attemptStamps = (u: Recorded[]) =>
    u.filter((x) => "last_bootstrap_attempt_at" in x.values);
  const windowWrites = (u: Recorded[]) => u.filter((x) => "sync_window_to" in x.values);
  const tokenWrites = (u: Recorded[]) => u.filter((x) => "sync_token" in x.values);

  beforeEach(() => {
    vi.clearAllMocks();
    calMock.syncEvents.mockResolvedValue({
      events: [],
      nextSyncToken: "new-tok",
      truncated: false,
    } as never);
  });

  it("stamps the attempt BEFORE fetching, and stamps it even when the fetch fails", async () => {
    // The fairness property. If the stamp only advanced on success, a calendar whose
    // delegation has been revoked would stay the oldest forever, be selected first on
    // every tick, and starve every healthy calendar behind it.
    const { db, updates } = recordingDb();
    admin.current = db;
    calMock.syncEvents.mockRejectedValue(new Error("delegation revoked"));

    const res = await hydrateCalendar(cal("old-tok"));

    expect(res.ok).toBe(false);
    expect(attemptStamps(updates)).toHaveLength(1);
    // And nothing claimed coverage for a fetch that never happened.
    expect(windowWrites(updates)).toHaveLength(0);
    // A failed hydration does not take the lane down with it.
    expect(res.events).toBe(0);
  });

  it("#3360: hands the events it applied to the time off edit check", async () => {
    const ev = {
      id: "evt-ooo",
      status: "confirmed",
      start: { dateTime: "2026-10-07T11:30:00-06:00" },
      end: { dateTime: "2026-10-07T23:59:00-06:00" },
    };
    calMock.syncEvents.mockResolvedValue({ events: [ev], nextSyncToken: "new-tok", truncated: false } as never);
    const { db } = recordingDb("old-tok");
    admin.current = db;

    await hydrateCalendar(cal("old-tok"));

    expect(oooNotice.noticeSyncedOooEvents).toHaveBeenCalledTimes(1);
    const deps = oooNotice.noticeSyncedOooEvents.mock.calls[0]![0];
    expect(deps.userId).toBe("agent-1");
    expect(deps.events).toEqual([ev]);
    // The booking ids the pass already loaded, so the check can skip the agent's own
    // Slate bookings without a read of its own.
    expect((deps as { bookingEventIds?: unknown }).bookingEventIds).toBeInstanceOf(Set);
  });

  it("#3360: a failing time off check never fails the pass or holds back its token", async () => {
    calMock.syncEvents.mockResolvedValue({
      events: [{ id: "evt-ooo", status: "confirmed", start: { dateTime: "2026-10-07T11:30:00Z" }, end: { dateTime: "2026-10-07T23:59:00Z" } }],
      nextSyncToken: "new-tok",
      truncated: false,
    } as never);
    oooNotice.noticeSyncedOooEvents.mockRejectedValueOnce(new Error("ooo_requests unreadable"));
    const { db, updates } = recordingDb("old-tok");
    admin.current = db;

    const res = await hydrateCalendar(cal("old-tok"));

    expect(res.ok).toBe(true);
    expect(tokenWrites(updates)).toHaveLength(1);
    expect(logSpy.error).toHaveBeenCalledWith(
      "google-sync",
      expect.objectContaining({ msg: "time off event check failed" }),
      expect.any(Error),
    );
  });

  it("records coverage only on success, in its OWN write, never coupled to the token", async () => {
    // Coupling them means every token write fails while code is deployed ahead of its
    // migration, and then every calendar re-bootstraps every minute against Google. The
    // token write is deliberately isolated for that reason and this must not undo it.
    const { db, updates } = recordingDb("old-tok");
    admin.current = db;

    await hydrateCalendar(cal("old-tok"));

    const windows = windowWrites(updates);
    const tokens = tokenWrites(updates);
    expect(windows).toHaveLength(1);
    expect(tokens).toHaveLength(1);
    // Two separate updates, so neither can fail on account of the other.
    expect(windows[0]).not.toBe(tokens[0]);
    expect(Object.keys(windows[0]!.values)).toEqual(["sync_window_to"]);
    expect(Object.keys(tokens[0]!.values)).toEqual(["sync_token"]);
  });

  it("writes the token CONDITIONALLY on the value the pass started with", async () => {
    // A push-driven sync can advance the token while this fetch is in flight. Overwriting
    // it would leave the stored coverage claiming a window the token does not correspond
    // to. Losing the race is harmless: the conditional write simply does nothing and the
    // next rotation re-establishes the window.
    const { db, updates } = recordingDb("old-tok");
    admin.current = db;

    await hydrateCalendar(cal("old-tok"));

    expect(tokenWrites(updates)[0]!.filters).toContain("eq:sync_token=old-tok");
  });

  it("uses an IS comparison when the pass started with no token at all", async () => {
    // `.eq` against null matches nothing in PostgREST, so a calendar that had never synced
    // would silently never get its token written and would re-bootstrap forever.
    const { db, updates } = recordingDb();
    admin.current = db;

    await hydrateCalendar(cal(null));

    expect(tokenWrites(updates)[0]!.filters).toContain("is:sync_token=null");
  });

  it("claims NO coverage for a page-capped pass", async () => {
    // A truncated pass read only part of the window, so recording the full window would
    // authorize the prune over a range that was never actually read.
    const { db, updates } = recordingDb("old-tok");
    admin.current = db;
    calMock.syncEvents.mockResolvedValue({
      events: [],
      nextSyncToken: null,
      truncated: true,
    } as never);

    await hydrateCalendar(cal("old-tok"));

    expect(windowWrites(updates)).toHaveLength(0);
    // But the attempt is still stamped, so the rotation moves on rather than retrying the
    // same pathological calendar on every tick.
    expect(attemptStamps(updates)).toHaveLength(1);
  });
});

// #2482: adding a calendar row is how a calendar becomes something Slate syncs at
// all. The insert used to discard its result, so a refusal left the agent with a
// calendar Google knows about and Slate does not: its busy time never reaches the
// cache, the agent is offered over meetings they really have, and every surface
// reported the reconcile as done. That is the stranded-agent shape (#2481) reached
// through the write nobody was reading.
describe("a calendar Slate could not record is not a calendar it has (#2482)", () => {
  // Slate stores nothing for this agent yet, and Google reports their primary. That
  // is the state a new hire is in, and the one write between them and being synced
  // at all. Only a PRIMARY is selectable (calendar-select.ts), so a fixture whose
  // primary is already stored has nothing to insert and would prove nothing.
  const listed = [
    { id: "agent@x.com", primary: true, selected: true, accessRole: "owner" },
    { id: "team@group.calendar.google.com", selected: true, accessRole: "reader" },
  ];

  it("reports an error rather than a reconcile that recorded nothing", async () => {
    const { db } = syncFlowDb({
      email: "agent@x.com",
      calendars: [],
      insertError: { message: "permission denied for table agent_calendars" },
    });
    admin.current = db;
    calMock.listCalendars.mockResolvedValue(listed);

    const result = await ensureWatches("agent-1");
    expect(result.status).toBe("error");
  });

  // CONTROL: the same listing with a database that accepts the write really does
  // add the calendar. Without this the assertion above is satisfied by an
  // ensureWatches that errors on everything (L159).
  it("CONTROL: the same listing adds the calendar when the write lands", async () => {
    const { db, inserts } = syncFlowDb({ email: "agent@x.com", calendars: [] });
    admin.current = db;
    calMock.listCalendars.mockResolvedValue(listed);

    const result = await ensureWatches("agent-1");
    expect(inserts.some((i) => i.table === "agent_calendars")).toBe(true);
    expect(result.status).not.toBe("error");
  });
});

// #3258: an upsert moves busy time only when its row is new or retimed. Compared as
// instants, because the store answers `+00:00` where the event wrote `Z`.
describe("movedBusyRows (#3258)", () => {
  const row = (id: string, start: string, end: string) => ({
    user_id: "u1",
    gcal_event_id: id,
    calendar_id: "cal-A",
    source: "gcal" as const,
    starts_at: start,
    ends_at: end,
  });
  it("counts new and retimed rows, and not a row with the same instants in another spelling", () => {
    const upserts = [
      row("same", "2026-01-01T10:00:00.000Z", "2026-01-01T11:00:00.000Z"),
      row("moved", "2026-01-01T12:00:00.000Z", "2026-01-01T13:00:00.000Z"),
      row("new", "2026-01-01T14:00:00.000Z", "2026-01-01T15:00:00.000Z"),
    ];
    const stored = [
      { gcal_event_id: "same", starts_at: "2026-01-01T10:00:00+00:00", ends_at: "2026-01-01T11:00:00+00:00" },
      { gcal_event_id: "moved", starts_at: "2026-01-01T12:00:00+00:00", ends_at: "2026-01-01T13:30:00+00:00" },
    ];
    expect(movedBusyRows(upserts, stored)).toBe(2);
  });
  it("counts a stored row with a missing stamp as moved (#3302 review)", () => {
    expect(
      movedBusyRows([row("x", "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z")], [
        { gcal_event_id: "x", starts_at: null, ends_at: "2026-01-01T11:00:00Z" },
      ]),
    ).toBe(1);
  });

  it("counts a row whose stored stamp cannot be read as moved, never as unchanged", () => {
    expect(
      movedBusyRows([row("x", "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z")], [
        { gcal_event_id: "x", starts_at: "garbage", ends_at: "2026-01-01T11:00:00Z" },
      ]),
    ).toBe(1);
  });
});

describe("a Slate booking's invite moved in Google Calendar (#3919)", () => {
  const BOOKED = { start: "2026-10-19T20:05:00.000Z", end: "2026-10-19T20:25:00.000Z" };
  const MOVED = { start: "2026-10-19T20:00:00.000Z", end: "2026-10-19T20:20:00.000Z" };

  /** The reads and writes one incremental pass makes, with the agent's booking in it. */
  function inviteSyncDb() {
    const upserts: Record<string, unknown>[] = [];
    const deletedIds: unknown[] = [];
    const tokenWrites: unknown[] = [];
    const from = (table: string) => {
      let mode: "read" | "delete" | "update" = "read";
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: () => b,
        not: () => b,
        gte: () => b,
        lt: () => b,
        gt: () => b,
        or: () => b,
        order: () => b,
        limit: () => b,
        range: () => b,
        in: (_col: string, vals: unknown[]) => {
          if (mode === "delete" && table === "busy_blocks") {
            deletedIds.push(...vals);
            return Promise.resolve({ error: null, count: vals.length });
          }
          return b;
        },
        upsert: (rows: Record<string, unknown>[]) => {
          upserts.push(...rows);
          return Promise.resolve({ error: null });
        },
        update: (p: Record<string, unknown>) => {
          mode = "update";
          if (table === "agent_calendars" && "sync_token" in p) tokenWrites.push(p.sync_token);
          return b;
        },
        delete: () => {
          mode = "delete";
          return b;
        },
        maybeSingle: () =>
          Promise.resolve({ data: table === "users" ? { email: "bkenny@trypennie.com" } : null, error: null }),
        then: (resolve: (v: { data: unknown[] | null; error: unknown }) => unknown) => {
          let data: unknown[] = [];
          if (table === "agent_calendars" && mode === "read") {
            data = [
              {
                id: "cal-1",
                user_id: "agent-1",
                calendar_id: "bkenny@trypennie.com",
                sync_token: "stored-token",
                consecutive_failures: 0,
                last_success_at: null,
                last_sync_error: null,
              },
            ];
          }
          if (table === "availability_schedules") data = [{ timezone: "America/New_York" }];
          if (table === "bookings") {
            data = [{ id: "booking-1", gcal_event_id: "slate-evt", starts_at: BOOKED.start, ends_at: BOOKED.end }];
          }
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return b;
    };
    return { db: { from } as unknown as ReturnType<typeof supabaseAdmin>, upserts, deletedIds, tokenWrites };
  }

  const event = (w: { start: string; end: string }) => ({
    id: "slate-evt",
    status: "confirmed",
    start: { dateTime: w.start },
    end: { dateTime: w.end },
    updated: "2026-10-19T12:19:04.000Z",
  });

  beforeEach(() => {
    inviteMoves.noticeOutOfStepInvites.mockClear();
    inviteMoves.reportInviteCheckFailures.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T13:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mirrors the moved invite as busy and hands it to the handler, rather than discarding it", async () => {
    calMock.syncEvents.mockImplementationOnce(async () => ({
      events: [event(MOVED)],
      nextSyncToken: "next-token",
      truncated: false,
    }) as never);
    const { db, upserts, deletedIds } = inviteSyncDb();
    admin.current = db;

    await runIncrementalSync("agent-1");

    expect(upserts.map((u) => [u.gcal_event_id, u.starts_at, u.ends_at])).toEqual([
      ["slate-evt", MOVED.start, MOVED.end],
    ]);
    expect(deletedIds).not.toContain("slate-evt");
    expect(inviteMoves.noticeOutOfStepInvites).toHaveBeenCalledTimes(1);
    expect(inviteMoves.noticeOutOfStepInvites.mock.calls[0]![1]).toEqual([
      { eventId: "slate-evt", bookingId: "booking-1", bookedStartsAt: BOOKED.start, step: "moved" },
    ]);
    // A delta saw the change happen, so the handler may put it back.
    expect(inviteMoves.noticeOutOfStepInvites.mock.calls[0]![2]).toEqual({ fullRead: false });
  });

  // #3925: a pass after Google expired the token reads every event, so a move first
  // seen there used to be mirrored and never reported. It is handed over too, marked
  // as a full read, which the handler reports and never puts back.
  it("hands a moved invite found on a full read after an expired token to the handler, as a full read", async () => {
    calMock.syncEvents
      .mockImplementationOnce(async () => {
        throw new SyncTokenExpired();
      })
      .mockImplementationOnce(async () => ({
        events: [event(MOVED)],
        nextSyncToken: "next-token",
        truncated: false,
      }) as never);
    const { db, upserts } = inviteSyncDb();
    admin.current = db;

    await runIncrementalSync("agent-1");

    expect(upserts.map((u) => u.gcal_event_id)).toEqual(["slate-evt"]);
    expect(inviteMoves.noticeOutOfStepInvites).toHaveBeenCalledTimes(1);
    expect(inviteMoves.noticeOutOfStepInvites.mock.calls[0]![1]).toEqual([
      { eventId: "slate-evt", bookingId: "booking-1", bookedStartsAt: BOOKED.start, step: "moved" },
    ]);
    expect(inviteMoves.noticeOutOfStepInvites.mock.calls[0]![2]).toEqual({ fullRead: true });
  });

  it("still discards an invite in step with its booking, and calls nothing", async () => {
    calMock.syncEvents.mockImplementationOnce(async () => ({
      events: [event(BOOKED)],
      nextSyncToken: "next-token",
      truncated: false,
    }) as never);
    const { db, upserts, deletedIds } = inviteSyncDb();
    admin.current = db;

    await runIncrementalSync("agent-1");

    expect(upserts).toEqual([]);
    expect(deletedIds).toContain("slate-evt");
    expect(inviteMoves.noticeOutOfStepInvites).not.toHaveBeenCalled();
  });

  it("never fails the pass over an invite it could not check: the token advances and the invite is paged", async () => {
    // A pass that threw here would never advance its token, so one unreadable invite
    // would stop every other meeting of this advisor being cached.
    calMock.syncEvents.mockImplementationOnce(async () => ({
      events: [event(MOVED)],
      nextSyncToken: "next-token",
      truncated: false,
    }) as never);
    inviteMoves.noticeOutOfStepInvites.mockImplementationOnce(async () => ({
      reverted: 0,
      left: 0,
      refused: 0,
      resized: 0,
      slateOwn: 0,
      nothing: 0,
      failed: [{ bookingId: "booking-1", reason: "503" }],
    }));
    const { db, tokenWrites, upserts } = inviteSyncDb();
    admin.current = db;

    await runIncrementalSync("agent-1");

    expect(tokenWrites).toEqual(["next-token"]);
    expect(upserts.map((u) => u.gcal_event_id)).toEqual(["slate-evt"]);
    expect(inviteMoves.reportInviteCheckFailures).toHaveBeenCalledWith("bkenny@trypennie.com", [
      { bookingId: "booking-1", reason: "503" },
    ]);
  });

  it("pages every delivered invite as unchecked when the handler itself throws, and still advances", async () => {
    calMock.syncEvents.mockImplementationOnce(async () => ({
      events: [event(MOVED)],
      nextSyncToken: "next-token",
      truncated: false,
    }) as never);
    inviteMoves.noticeOutOfStepInvites.mockImplementationOnce(async () => {
      throw new Error("a fault nobody predicted");
    });
    const { db, tokenWrites } = inviteSyncDb();
    admin.current = db;

    await runIncrementalSync("agent-1");

    expect(tokenWrites).toEqual(["next-token"]);
    expect(inviteMoves.reportInviteCheckFailures).toHaveBeenCalledWith("bkenny@trypennie.com", [
      { bookingId: "booking-1", reason: "a fault nobody predicted" },
    ]);
  });
});
