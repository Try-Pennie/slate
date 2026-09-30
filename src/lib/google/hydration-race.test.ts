/**
 * The hydration re-bootstrap against a concurrent writer (#2411).
 *
 * `hydrateCalendar` fetches a full snapshot with a null token, upserts it, and
 * reconciles every cached block in the window against it. Its own header reasons
 * about the TOKEN race and calls losing it harmless. The BLOCK CONTENTS are where
 * the harm is: a push-driven sync that lands mid-fetch writes an event at its new
 * time and advances the token past it, and hydration then writes its older
 * snapshot over the top. Google delivers an unchanged event exactly once, so
 * nothing re-sends it until the rotation comes round again, up to a day later.
 *
 * These tests drive the INTERLEAVING, not a proxy for it. A test that asserted a
 * claim had been taken would say nothing about whether the block survived (L63),
 * so each one runs two real writers against one store and then reads the store.
 *
 * The store and Google are both modelled here rather than mocked per call,
 * because the defect is an ORDER of writes and a per-call fake cannot express
 * one. The Google model is the part that matters: a sync token names a point in
 * the calendar's history, a delta returns only what changed after it, and a
 * change is delivered exactly ONCE. Convergence after the race depends entirely
 * on which token ends up stored, so a fake that re-delivered would hide the bug.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { GoogleEvent } from "@/lib/google/calendar";

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Mode = "select" | "insert" | "update" | "upsert" | "delete";

interface Filter {
  kind: "eq" | "is" | "in" | "gt" | "gte" | "lt" | "notIs" | "claimOr";
  column: string;
  value?: unknown;
  staleBefore?: string;
}

interface Fault {
  table: string;
  mode: Mode;
  times: number;
  message: string;
}

/** ISO timestamps from toISOString sort lexicographically, which is all these filters need. */
function cmp(a: unknown, b: unknown): number {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

class FakeDb {
  readonly tables: Record<string, Row[]> = {};
  private faults: Fault[] = [];
  private nextId = 1;

  seed(table: string, rows: Row[]): void {
    this.tables[table] = rows.map((r) => ({ ...r }));
  }
  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }
  /** Make the next `times` matching operations fail the way PostgREST does. */
  fail(table: string, mode: Mode, times = 1, message = "injected failure"): void {
    this.faults.push({ table, mode, times, message });
  }
  private takeFault(table: string, mode: Mode): Fault | null {
    const hit = this.faults.find((f) => f.table === table && f.mode === mode && f.times > 0);
    if (!hit) return null;
    hit.times -= 1;
    return hit;
  }
  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  run(q: FakeQuery): { data: unknown; error: { message: string } | null; count: number | null } {
    const fault = this.takeFault(q.table, q.mode);
    if (fault) return { data: null, error: { message: fault.message }, count: null };
    const rows = this.rows(q.table);
    const matches = (row: Row): boolean =>
      q.filters.every((f) => {
        const v = row[f.column];
        const present = v !== null && v !== undefined;
        switch (f.kind) {
          case "eq":
            return present && String(v) === String(f.value);
          case "is":
            return !present;
          case "notIs":
            return present;
          case "in":
            return (f.value as unknown[]).some((x) => String(x) === String(v));
          case "gt":
            return present && cmp(v, f.value) > 0;
          case "gte":
            return present && cmp(v, f.value) >= 0;
          case "lt":
            return present && cmp(v, f.value) < 0;
          case "claimOr":
            return !present || cmp(v, f.staleBefore) < 0;
        }
      });

    if (q.mode === "select") {
      let hits = rows.filter(matches).map((r) => ({ ...r }));
      if (q.rangeFrom !== null) hits = hits.slice(q.rangeFrom, (q.rangeTo ?? hits.length) + 1);
      if (q.limitTo !== null) hits = hits.slice(0, q.limitTo);
      if (q.head) return { data: null, error: null, count: hits.length };
      if (q.singleRow) return { data: hits[0] ?? null, error: null, count: null };
      return { data: hits, error: null, count: q.wantCount ? hits.length : null };
    }
    if (q.mode === "update") {
      const hits = rows.filter(matches);
      for (const row of hits) Object.assign(row, q.payload as Row);
      return {
        data: q.selectedAfterWrite ? hits.map((r) => ({ ...r })) : null,
        error: null,
        count: q.wantCount ? hits.length : null,
      };
    }
    if (q.mode === "delete") {
      const hits = rows.filter(matches);
      this.tables[q.table] = rows.filter((r) => !hits.includes(r));
      return { data: null, error: null, count: q.wantCount ? hits.length : null };
    }
    const incoming = (Array.isArray(q.payload) ? q.payload : [q.payload]) as Row[];
    const keys = q.onConflict ? q.onConflict.split(",") : [];
    for (const row of incoming) {
      const existing =
        keys.length > 0
          ? rows.find((r) => keys.every((k) => String(r[k]) === String(row[k])))
          : undefined;
      if (existing) Object.assign(existing, row);
      else rows.push({ id: `row-${this.nextId++}`, ...row });
    }
    return { data: null, error: null, count: null };
  }
}

type DbResult = { data: unknown; error: { message: string } | null; count: number | null };

class FakeQuery implements PromiseLike<DbResult> {
  mode: Mode = "select";
  payload: unknown = null;
  onConflict: string | null = null;
  filters: Filter[] = [];
  rangeFrom: number | null = null;
  rangeTo: number | null = null;
  limitTo: number | null = null;
  singleRow = false;
  head = false;
  wantCount = false;
  selectedAfterWrite = false;

  constructor(
    private readonly db: FakeDb,
    readonly table: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (this.mode === "select") {
      this.wantCount = opts?.count === "exact";
      this.head = opts?.head === true;
    } else {
      this.selectedAfterWrite = true;
    }
    return this;
  }
  insert(rows: unknown): this {
    this.mode = "insert";
    this.payload = rows;
    return this;
  }
  update(patch: unknown): this {
    this.mode = "update";
    this.payload = patch;
    return this;
  }
  upsert(rows: unknown, opts?: { onConflict?: string }): this {
    this.mode = "upsert";
    this.payload = rows;
    this.onConflict = opts?.onConflict ?? null;
    return this;
  }
  delete(opts?: { count?: string }): this {
    this.mode = "delete";
    this.wantCount = opts?.count === "exact";
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }
  is(column: string, value: unknown): this {
    if (value !== null) throw new Error("fake db: .is supports null only");
    this.filters.push({ kind: "is", column });
    return this;
  }
  not(column: string, op: string, value: unknown): this {
    if (op !== "is" || value !== null) throw new Error("fake db: .not supports is-null only");
    this.filters.push({ kind: "notIs", column });
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.filters.push({ kind: "in", column, value: values });
    return this;
  }
  gt(column: string, value: unknown): this {
    this.filters.push({ kind: "gt", column, value });
    return this;
  }
  gte(column: string, value: unknown): this {
    this.filters.push({ kind: "gte", column, value });
    return this;
  }
  lt(column: string, value: unknown): this {
    this.filters.push({ kind: "lt", column, value });
    return this;
  }
  /** Only the claim predicate is supported, parsed rather than loosely matched, so a
   *  different `or` cannot silently read as this one (L143). */
  or(expr: string): this {
    const m = /^([a-z_]+)\.is\.null,\1\.lt\.(.+)$/.exec(expr);
    if (!m) throw new Error(`fake db: unsupported or() ${expr}`);
    this.filters.push({ kind: "claimOr", column: m[1], staleBefore: m[2] });
    return this;
  }
  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  limit(n: number): this {
    this.limitTo = n;
    return this;
  }
  maybeSingle(): this {
    this.singleRow = true;
    return this;
  }
  single(): this {
    this.singleRow = true;
    return this;
  }
  then<R1 = DbResult, R2 = never>(
    onfulfilled?: ((value: DbResult) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve()
      .then(() => this.db.run(this))
      .then(onfulfilled, onrejected);
  }
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

interface StoredEvent {
  id: string;
  start: string;
  end: string;
  cancelled: boolean;
  version: number;
}

/**
 * A calendar whose sync token names a point in its own history. `list(null)` is a
 * bootstrap and returns the current set; `list("t3")` is a delta and returns only
 * what changed after version 3. A change is therefore delivered exactly ONCE to a
 * given token holder, which is the property the whole defect rests on.
 */
class FakeGoogle {
  version = 0;
  readonly events = new Map<string, StoredEvent>();
  /** Runs inside a fetch, after its snapshot is taken and before it returns. */
  midFetch: (() => Promise<void>) | null = null;
  calls = 0;

  put(id: string, start: string, end: string): void {
    this.version += 1;
    this.events.set(id, { id, start, end, cancelled: false, version: this.version });
  }
  cancel(id: string): void {
    const ev = this.events.get(id);
    if (!ev) throw new Error(`fake google: no event ${id}`);
    this.version += 1;
    this.events.set(id, { ...ev, cancelled: true, version: this.version });
  }
  /** Remove an event from the calendar WITHOUT a delta, as a change made while a
   *  token was stale: only a bootstrap can notice it. */
  vanish(id: string): void {
    this.events.delete(id);
  }

  snapshot(token: string | null): { events: GoogleEvent[]; nextSyncToken: string; truncated: boolean } {
    const since = token === null ? null : Number(token.slice(1));
    const rows = [...this.events.values()].filter((e) =>
      since === null ? !e.cancelled : e.version > since,
    );
    return {
      events: rows.map((e) => ({
        id: e.id,
        status: e.cancelled ? "cancelled" : "confirmed",
        start: { dateTime: e.start },
        end: { dateTime: e.end },
      })),
      nextSyncToken: `t${this.version}`,
      truncated: false,
    };
  }
}

const db = vi.hoisted(() => ({ current: null as unknown }));
const google = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => db.current as FakeDb,
}));
vi.mock("@/lib/env", () => ({
  googlePushUrl: () => "https://slate.example/api/google/push",
}));
vi.mock("@/lib/availability/slot-cache", () => ({
  recomputeBucketsForAgent: vi.fn(async () => {}),
  recomputeBucketSlotsForToday: vi.fn(async () => {}),
}));
vi.mock("@/lib/after-response", () => ({
  afterResponse: (_label: string, fn: () => unknown) => {
    void fn();
  },
}));
vi.mock("@/lib/notify/dispatch", () => ({
  sendThrottledAlert: vi.fn(async () => {}),
  sendThrottledInfo: vi.fn(async () => {}),
  resolveAlert: vi.fn(async () => false),
  isAlertFiring: vi.fn(async () => false),
}));
vi.mock("@/lib/google/calendar", async () => {
  class SyncTokenExpired extends Error {
    readonly code = 410;
    constructor() {
      super("Google sync token expired");
      this.name = "SyncTokenExpired";
    }
  }
  return {
    SyncTokenExpired,
    listCalendars: vi.fn(async () => []),
    watchCalendar: vi.fn(async () => ({ resourceId: "r", expiration: "0" })),
    stopChannel: vi.fn(async () => {}),
    syncEvents: async (
      _email: string,
      _calendarId: string,
      token: string | null,
      _min: string,
      _max: string,
    ) => {
      const g = google.current as FakeGoogle;
      g.calls += 1;
      const snap = g.snapshot(token);
      const hook = g.midFetch;
      g.midFetch = null;
      if (hook) await hook();
      return snap;
    },
  };
});

import { hydrateCalendar, syncByChannel, runIncrementalSync } from "@/lib/google/sync";
import { recomputeBucketsForAgent } from "@/lib/availability/slot-cache";
import type { AgentCalendar } from "@/lib/db/types";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const CAL_ID = "cal-1";
const USER_ID = "user-1";
const CALENDAR = "agent@trypennie.com";
const CHANNEL = "chan-1";

/**
 * One time base per test, taken once, so the same offset always renders the same
 * string. Reading the clock per call made an instant written during a fetch differ
 * from the same instant asserted afterwards by however long the pass took, which is
 * a test measuring the machine rather than the code (L130, L290). Offsets are hours,
 * so every instant used here sits inside the hydration window (24h back, 21 days
 * ahead) whatever the wall clock says.
 */
let base = 0;
function at(hoursFromBase: number): string {
  return new Date(base + hoursFromBase * 3_600_000).toISOString();
}
const DAY = 24;

function calendarRow(overrides: Partial<AgentCalendar> = {}): Row {
  return {
    id: CAL_ID,
    user_id: USER_ID,
    calendar_id: CALENDAR,
    sync_token: null,
    watch_channel_id: CHANNEL,
    watch_resource_id: "res-1",
    watch_expiration: null,
    sync_pending: false,
    sync_claimed_at: null,
    last_sync_error: null,
    consecutive_failures: 0,
    last_success_at: null,
    last_failure_kind: null,
    watch_consecutive_failures: 0,
    watch_last_success_at: null,
    watch_last_error: null,
    watch_last_failure_kind: null,
    last_bootstrap_attempt_at: null,
    sync_window_to: null,
    ...overrides,
  } as Row;
}

function cal(): AgentCalendar {
  const row = (db.current as FakeDb).rows("agent_calendars").find((r) => r.id === CAL_ID);
  if (!row) throw new Error("calendar row missing");
  return { ...row } as unknown as AgentCalendar;
}

function blockFor(eventId: string): Row | undefined {
  return (db.current as FakeDb).rows("busy_blocks").find((b) => b.gcal_event_id === eventId);
}

beforeEach(() => {
  base = Date.now();
  const fresh = new FakeDb();
  fresh.seed("users", [{ id: USER_ID, email: CALENDAR }]);
  fresh.seed("availability_schedules", [{ user_id: USER_ID, timezone: "America/New_York" }]);
  fresh.seed("bookings", []);
  fresh.seed("busy_blocks", []);
  db.current = fresh;
  google.current = new FakeGoogle();
});

/** Bring the cache up to date the ordinary way, so a test starts from a converged
 *  state rather than from one it asserted into place. */
async function bootstrap(): Promise<void> {
  (db.current as FakeDb).seed("agent_calendars", [calendarRow()]);
  const res = await hydrateCalendar(cal());
  expect(res.ok).toBe(true);
}

describe("hydrateCalendar against a concurrent push sync (#2411)", () => {
  it("does not revert an event a push sync moved while its fetch was in flight", async () => {
    const g = google.current as FakeGoogle;
    g.put("evt-E", at(DAY + 10), at(DAY + 11));
    await bootstrap();
    expect(blockFor("evt-E")?.starts_at).toBe(at(DAY + 10));

    // E moves, and Google pushes, while hydration's own fetch is in flight.
    g.midFetch = async () => {
      g.put("evt-E", at(DAY + 14), at(DAY + 15));
      await syncByChannel(CHANNEL);
    };
    await hydrateCalendar(cal());

    // Whatever happened to the claim, the next ordinary incremental tick must
    // leave the cache agreeing with Google. It cannot if hydration wrote its
    // older snapshot AND a token minted after the move: the delta for E was
    // consumed by the push and Google never re-sends it.
    await runIncrementalSync(USER_ID);
    expect(blockFor("evt-E")?.starts_at).toBe(at(DAY + 14));
    expect(blockFor("evt-E")?.ends_at).toBe(at(DAY + 15));
  });

  it("does not delete an event created while its fetch was in flight", async () => {
    const g = google.current as FakeGoogle;
    g.put("evt-old", at(DAY + 1), at(DAY + 2));
    await bootstrap();

    g.midFetch = async () => {
      g.put("evt-new", at(DAY + 16), at(DAY + 17));
      await syncByChannel(CHANNEL);
    };
    await hydrateCalendar(cal());

    await runIncrementalSync(USER_ID);
    expect(blockFor("evt-new")?.starts_at).toBe(at(DAY + 16));
    expect(blockFor("evt-old")).toBeTruthy();
  });

  it("still purges a block whose event really has vanished", async () => {
    // The control that stops an over-broad fix passing: nothing concurrent here,
    // so the reconcile must do exactly what it has always done.
    const g = google.current as FakeGoogle;
    g.put("evt-gone", at(DAY + 3), at(DAY + 4));
    g.put("evt-kept", at(DAY + 5), at(DAY + 6));
    await bootstrap();
    expect(blockFor("evt-gone")).toBeTruthy();

    g.vanish("evt-gone");
    const res = await hydrateCalendar(cal());

    expect(res.ok).toBe(true);
    expect(blockFor("evt-gone")).toBeUndefined();
    expect(blockFor("evt-kept")).toBeTruthy();
  });

  it("converges when the push lands BEFORE the fetch, with no duplicate block", async () => {
    const g = google.current as FakeGoogle;
    g.put("evt-E", at(DAY + 10), at(DAY + 11));
    await bootstrap();

    g.put("evt-E", at(DAY + 14), at(DAY + 15));
    await syncByChannel(CHANNEL);
    expect(blockFor("evt-E")?.starts_at).toBe(at(DAY + 14));

    const res = await hydrateCalendar(cal());
    expect(res.ok).toBe(true);
    expect(blockFor("evt-E")?.starts_at).toBe(at(DAY + 14));
    expect(
      (db.current as FakeDb).rows("busy_blocks").filter((b) => b.gcal_event_id === "evt-E"),
    ).toHaveLength(1);
  });
});

describe("hydrateCalendar and the sync claim (#2411)", () => {
  it("skips a calendar another pass is holding, and touches nothing", async () => {
    const g = google.current as FakeGoogle;
    g.put("evt-E", at(DAY + 2), at(DAY + 3));
    await bootstrap();
    const callsBefore = g.calls;

    (db.current as FakeDb).seed("agent_calendars", [
      calendarRow({
        sync_token: cal().sync_token,
        sync_claimed_at: new Date().toISOString(),
        last_bootstrap_attempt_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const res = await hydrateCalendar(cal());

    expect(res.ok).toBe(false);
    expect(res.skipped).toBe("claimed");
    expect(g.calls).toBe(callsBefore);
    // The rotation stamp must NOT move, or a calendar skipped this tick would go
    // to the back of a day-long queue instead of being retried on the next one.
    expect(cal().last_bootstrap_attempt_at).toBe("2026-01-01T00:00:00.000Z");
    expect(blockFor("evt-E")).toBeTruthy();
  });

  it("takes over a claim whose holder died", async () => {
    const g = google.current as FakeGoogle;
    g.put("evt-E", at(DAY + 2), at(DAY + 3));
    (db.current as FakeDb).seed("agent_calendars", [
      // Older than CALENDAR_CLAIM_TTL_MS: a pass that crashed without releasing.
      calendarRow({ sync_claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() }),
    ]);

    const res = await hydrateCalendar(cal());

    expect(res.ok).toBe(true);
    expect(blockFor("evt-E")).toBeTruthy();
  });

  it("releases its claim when the pass throws, and only its own", async () => {
    await bootstrap();
    (db.current as FakeDb).fail("busy_blocks", "select", 1, "boom");
    const g = google.current as FakeGoogle;
    g.put("evt-E", at(DAY + 2), at(DAY + 3));

    const res = await hydrateCalendar(cal());

    expect(res.ok).toBe(false);
    expect(cal().sync_claimed_at).toBeNull();
  });

  it("holds the claim against a push sync for the whole pass", async () => {
    const g = google.current as FakeGoogle;
    g.put("evt-E", at(DAY + 2), at(DAY + 3));
    await bootstrap();

    let pushOutcome: string | null = null;
    g.midFetch = async () => {
      pushOutcome = await syncByChannel(CHANNEL);
    };
    await hydrateCalendar(cal());

    expect(pushOutcome).toBe("coalesced");
  });

  it("does nothing at all when the claim cannot be read", async () => {
    const g = google.current as FakeGoogle;
    g.put("evt-E", at(DAY + 2), at(DAY + 3));
    await bootstrap();
    const callsBefore = g.calls;
    const blocksBefore = (db.current as FakeDb).rows("busy_blocks").length;

    (db.current as FakeDb).fail("agent_calendars", "update", 1, "claim write refused");
    const res = await hydrateCalendar(cal());

    expect(res.ok).toBe(false);
    expect(res.skipped).toBe("claim-unreadable");
    expect(g.calls).toBe(callsBefore);
    expect((db.current as FakeDb).rows("busy_blocks")).toHaveLength(blocksBefore);
  });
});

describe("hydrateCalendar will not write over a token that moved (#2411)", () => {
  it("writes nothing when an unclaimed pass advanced the token mid-fetch", async () => {
    // The minute lane takes no per-calendar claim (it cannot afford one at 100
    // agents a tick), so a pass that listed before the claim landed can still be
    // running. Hydration cannot exclude it, so it refuses to write a snapshot it
    // can no longer vouch for.
    const g = google.current as FakeGoogle;
    g.put("evt-E", at(DAY + 10), at(DAY + 11));
    await bootstrap();

    g.midFetch = async () => {
      g.put("evt-E", at(DAY + 14), at(DAY + 15));
      const row = (db.current as FakeDb).rows("agent_calendars")[0];
      // Exactly what an in-flight incremental does: writes the block, advances the token.
      (db.current as FakeDb).rows("busy_blocks").forEach((b) => {
        if (b.gcal_event_id === "evt-E") {
          b.starts_at = at(DAY + 14);
          b.ends_at = at(DAY + 15);
        }
      });
      row.sync_token = `t${g.version}`;
    };
    const res = await hydrateCalendar(cal());

    expect(res.ok).toBe(false);
    expect(res.skipped).toBe("token-moved");
    expect(blockFor("evt-E")?.starts_at).toBe(at(DAY + 14));
  });

  it("writes nothing when the token cannot be re-read", async () => {
    const g = google.current as FakeGoogle;
    g.put("evt-gone", at(DAY + 3), at(DAY + 4));
    await bootstrap();
    g.vanish("evt-gone");

    (db.current as FakeDb).fail("agent_calendars", "select", 1, "token re-read refused");
    const res = await hydrateCalendar(cal());

    expect(res.ok).toBe(false);
    expect(res.skipped).toBe("token-unreadable");
    // A purge it could not vouch for must not run: the block stays.
    expect(blockFor("evt-gone")).toBeTruthy();
  });
});

describe("the minute lane honours a hydration claim (#2411)", () => {
  it("skips a calendar hydration is holding and reports it", async () => {
    const g = google.current as FakeGoogle;
    g.put("evt-E", at(DAY + 2), at(DAY + 3));
    await bootstrap();
    (db.current as FakeDb).rows("agent_calendars")[0].sync_claimed_at = new Date().toISOString();
    const callsBefore = g.calls;

    const res = await runIncrementalSync(USER_ID);

    expect(res.claimSkipped).toBe(1);
    expect(res.goneSkipped).toBe(0);
    expect(g.calls).toBe(callsBefore);
  });

  it("syncs a calendar whose claim has aged out", async () => {
    const g = google.current as FakeGoogle;
    await bootstrap();
    (db.current as FakeDb).rows("agent_calendars")[0].sync_claimed_at = new Date(
      Date.now() - 10 * 60_000,
    ).toISOString();
    g.put("evt-late", at(DAY + 6), at(DAY + 7));

    const res = await runIncrementalSync(USER_ID);

    expect(res.claimSkipped).toBe(0);
    expect(blockFor("evt-late")).toBeTruthy();
  });
});

// #2922: the push path's slot refresh is AWAITED inside syncByChannel rather than
// scheduled beside it. The push route already runs syncByChannel under after(), so
// awaiting keeps the refresh in that same post response window and lets the route
// time the sync and the refresh as the one unit Cloudflare cancels. A nested
// schedule would let syncByChannel resolve, and the route log "push work
// finished", while the refresh was still running and about to be cut off.
describe("a push sync waits for its slot refresh (#2922)", () => {
  it("does not resolve until the agent's refresh has settled, and releases its claim first", async () => {
    const g = google.current as FakeGoogle;
    await bootstrap();
    g.put("evt-new", at(DAY + 9), at(DAY + 10));

    let release!: () => void;
    let claimDuringRefresh: string | null | undefined;
    vi.mocked(recomputeBucketsForAgent).mockImplementationOnce(async (userId) => {
      expect(userId).toBe(USER_ID);
      claimDuringRefresh = cal().sync_claimed_at;
      await new Promise<void>((r) => (release = r));
      return null;
    });

    let settled = false;
    const pending = syncByChannel(CHANNEL).then((out) => {
      settled = true;
      return out;
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await Promise.resolve();
    expect(settled).toBe(false);
    // The claim is released before the refresh, so a push arriving meanwhile
    // syncs rather than coalescing behind four seconds of compute per pool.
    expect(claimDuringRefresh).toBeNull();

    release();
    await expect(pending).resolves.toBe("synced");
    expect(blockFor("evt-new")).toBeTruthy();
  });
});
