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
  /** Matching operations to let through before failing. */
  skip?: number;
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
  /** Fail the next `times` matching operations, after letting `skip` of them through. */
  fail(table: string, mode: Mode, times = 1, message = "injected failure", skip = 0): void {
    this.faults.push({ table, mode, times, message, skip });
  }
  private takeFault(table: string, mode: Mode): Fault | null {
    const hit = this.faults.find((f) => f.table === table && f.mode === mode && f.times > 0);
    if (!hit) return null;
    if ((hit.skip ?? 0) > 0) {
      hit.skip! -= 1;
      return null;
    }
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

  private readonly db: FakeDb;
  readonly table: string;

  constructor(db: FakeDb, table: string) {
    this.db = db;
    this.table = table;
  }

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
  order(): this {
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
  refreshAgentPoolsAfterPush: vi.fn(async () => null),
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
// #3925: what the rotation hands the moved invite handler. Its decisions are pinned in
// scripts/test-invite-moves.ts; here only what it is given, and how.
const inviteMoves = vi.hoisted(() => ({
  noticeOutOfStepInvites: vi.fn(async (_deps: unknown, _items: unknown[], _opts?: unknown) => ({
    reverted: 0,
    left: 0,
    refused: 0,
    resized: 0,
    reported: 0,
    slateOwn: 0,
    nothing: 0,
    silenced: 0,
    failed: [] as { bookingId: string; reason: string }[],
  })),
}));
vi.mock("@/lib/google/invite-move-notice", () => ({
  noticeOutOfStepInvites: inviteMoves.noticeOutOfStepInvites,
}));
vi.mock("@/lib/google/invite-move-deps", () => ({
  realInviteMoveDeps: (args: unknown) => ({ args }),
  reportInviteCheckFailures: vi.fn(async () => {}),
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
import { calendarsDueForHydration, type HydrationCandidate } from "@/lib/google/hydration";
import { refreshAgentPoolsAfterPush } from "@/lib/availability/slot-cache";
import { GoogleHttpError } from "@/lib/google/http-error";
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

// #3925: the rotation and a calendar's first hydration read every event, so a move
// first seen there used to be mirrored and never reported. Handed over as a full read,
// which the handler reports and never puts back.
describe("hydrateCalendar hands an out of step invite to the handler as a full read (#3925)", () => {
  it("hands over the moved invite of a booking, marked as a full read", async () => {
    await bootstrap();
    (db.current as FakeDb).seed("bookings", [
      {
        id: "bk-1",
        assigned_user_id: USER_ID,
        status: "confirmed",
        gcal_event_id: "evt-slate",
        starts_at: at(DAY + 3),
        ends_at: at(DAY + 4),
      },
    ]);
    // The advisor moved it while nothing delivered the change.
    (google.current as FakeGoogle).put("evt-slate", at(DAY + 5), at(DAY + 6));
    inviteMoves.noticeOutOfStepInvites.mockClear();

    const res = await hydrateCalendar(cal());

    expect(res.ok).toBe(true);
    expect(blockFor("evt-slate")).toBeTruthy();
    expect(inviteMoves.noticeOutOfStepInvites).toHaveBeenCalledTimes(1);
    expect(inviteMoves.noticeOutOfStepInvites.mock.calls[0]![1]).toEqual([
      { eventId: "evt-slate", bookingId: "bk-1", bookedStartsAt: at(DAY + 3), step: "moved" },
    ]);
    expect(inviteMoves.noticeOutOfStepInvites.mock.calls[0]![2]).toEqual({ fullRead: true });
  });

  it("hands nothing over when every invite is in step", async () => {
    await bootstrap();
    (db.current as FakeDb).seed("bookings", [
      {
        id: "bk-1",
        assigned_user_id: USER_ID,
        status: "confirmed",
        gcal_event_id: "evt-slate",
        starts_at: at(DAY + 3),
        ends_at: at(DAY + 4),
      },
    ]);
    (google.current as FakeGoogle).put("evt-slate", at(DAY + 3), at(DAY + 4));
    inviteMoves.noticeOutOfStepInvites.mockClear();

    await hydrateCalendar(cal());

    expect(inviteMoves.noticeOutOfStepInvites).not.toHaveBeenCalled();
  });
});

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

// #3211: a FIRST load abandoned with token-moved used to leave its rotation stamp
// behind, so a calendar that had never been hydrated dropped out of the onboarding
// lane into a day long queue (measured: 8 of 90 calendars, up to about 11 hours).
// These drive the race through the real pass and then ask the real selection what
// the next tick would pick, because the stamp and the selection are only wrong
// together.
describe("a hydration pass that loses the token race keeps its rotation place (#3211)", () => {
  /** Two calendars the rotation has already refreshed, oldest first. */
  const OLDER = "2026-01-01T00:00:00.000Z";
  const NEWER = "2026-01-02T00:00:00.000Z";
  function seedNeighbours(): void {
    const store = db.current as FakeDb;
    for (const [id, stamp] of [
      ["cal-older", OLDER],
      ["cal-newer", NEWER],
    ] as const) {
      store.rows("agent_calendars").push(
        calendarRow({
          id,
          user_id: `user-${id}`,
          calendar_id: `${id}@trypennie.com`,
          watch_channel_id: `chan-${id}`,
          sync_token: "t-other",
          last_bootstrap_attempt_at: stamp,
          sync_window_to: at(21 * DAY),
        }),
      );
    }
  }
  function nextTick(batchSize: number): string[] {
    const rows = (db.current as FakeDb).rows("agent_calendars") as unknown as HydrationCandidate[];
    return calendarsDueForHydration(rows, Date.now(), batchSize).map((c) => c.id);
  }
  /** What the minute lane's own bootstrap does when it lands mid-fetch: it loads the
   *  same window into the cache and stores the token Google gave it. */
  function minuteLaneBootstrapsMidFetch(): void {
    const g = google.current as FakeGoogle;
    g.midFetch = async () => {
      const row = (db.current as FakeDb).rows("agent_calendars").find((r) => r.id === CAL_ID);
      if (!row) throw new Error("calendar row missing");
      // A change lands first, so the token it stores differs from any token this
      // calendar held before, the way a real later point in its history does.
      g.put("evt-mid", at(DAY + 5), at(DAY + 6));
      row.sync_token = `t${g.version}`;
    };
  }

  it("puts a never hydrated calendar first on the next tick after a token-moved first load", async () => {
    const g = google.current as FakeGoogle;
    g.put("evt-E", at(DAY + 2), at(DAY + 3));
    (db.current as FakeDb).seed("agent_calendars", [calendarRow()]);
    seedNeighbours();

    minuteLaneBootstrapsMidFetch();
    const res = await hydrateCalendar(cal());

    expect(res.skipped).toBe("token-moved");
    // The abandonment itself is unchanged: no coverage is claimed for a snapshot
    // this pass could no longer vouch for.
    expect(cal().sync_window_to).toBeNull();
    // A batch of ONE: the onboarding lane takes it in addition to the batch, so the
    // single maintenance place still goes to the oldest neighbour.
    expect(nextTick(1)).toEqual([CAL_ID, "cal-older"]);
    expect(cal().last_bootstrap_attempt_at).toBeNull();
  });

  it("returns an already hydrated calendar to the place it held when it loses the race", async () => {
    const g = google.current as FakeGoogle;
    g.put("evt-E", at(DAY + 2), at(DAY + 3));
    await bootstrap();
    const stamp = "2025-12-31T00:00:00.000Z";
    (db.current as FakeDb).rows("agent_calendars")[0].last_bootstrap_attempt_at = stamp;
    seedNeighbours();

    minuteLaneBootstrapsMidFetch();
    const res = await hydrateCalendar(cal());

    expect(res.skipped).toBe("token-moved");
    expect(cal().last_bootstrap_attempt_at).toBe(stamp);
    expect(nextTick(3)).toEqual([CAL_ID, "cal-older", "cal-newer"]);
  });

  it("control: a calendar whose pass completes goes to the back of the rotation", async () => {
    const g = google.current as FakeGoogle;
    g.put("evt-E", at(DAY + 2), at(DAY + 3));
    (db.current as FakeDb).seed("agent_calendars", [calendarRow()]);
    seedNeighbours();

    const res = await hydrateCalendar(cal());

    expect(res.ok).toBe(true);
    expect(cal().sync_window_to).not.toBeNull();
    expect(cal().last_bootstrap_attempt_at).not.toBeNull();
    expect(nextTick(3)).toEqual(["cal-older", "cal-newer", CAL_ID]);
  });

  it("control: a calendar whose fetch FAILS still moves back, so it cannot hold the head", async () => {
    const g = google.current as FakeGoogle;
    (db.current as FakeDb).seed("agent_calendars", [
      calendarRow({ sync_token: "t-own", last_bootstrap_attempt_at: "2025-12-31T00:00:00.000Z" }),
    ]);
    seedNeighbours();
    g.midFetch = async () => {
      throw new Error("503 backendError");
    };

    const res = await hydrateCalendar(cal());

    expect(res.ok).toBe(false);
    expect(res.skipped).toBeUndefined();
    expect(nextTick(3)).toEqual(["cal-older", "cal-newer", CAL_ID]);
  });
});

describe("the hydration failure log line names Google's reason (#3805)", () => {
  // The all failing alert sends its reader to tag=hydrate-calendars "for the reason". On
  // 2026-10-16 those lines carried a calendar id and a stack, and the 403 was found only in
  // agent_calendars.last_sync_error. The line itself must carry it.
  it("carries reason= and the failure kind", async () => {
    const g = google.current as FakeGoogle;
    (db.current as FakeDb).seed("agent_calendars", [calendarRow({ sync_token: "t-own" })]);
    const body = JSON.stringify({
      error: {
        errors: [{ domain: "calendar", reason: "notACalendarUser", message: "notACalendarUser" }],
        code: 403,
      },
    });
    g.midFetch = async () => {
      throw new GoogleHttpError(`events.list failed: 403 ${body}`, 403, "notACalendarUser");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await hydrateCalendar(cal());
      expect(res.ok).toBe(false);
      const lines = warn.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes('msg="calendar hydration failed"'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('reason="403 notACalendarUser"');
      expect(lines[0]).toContain('kind="not-provisioned"');
      expect(lines[0]).toContain(`calendar_id="${CALENDAR}"`);
    } finally {
      warn.mockRestore();
    }
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
    vi.mocked(refreshAgentPoolsAfterPush).mockImplementationOnce(async (userId) => {
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

// #3258: a push whose sync changed no busy time refreshes nothing. Production
// (2026-10-05) measured the push path at two thirds of the Worker's CPU, about
// 10s a push, and every push refreshed every pool of its agent even when Google's
// delta held nothing that moves busy time: a title edit, or the echo of the event
// Slate itself created for a booking, whose pool the booking already refreshed.
describe("a push refreshes slots only when its sync changed busy time (#3258)", () => {
  it("refreshes nothing when the delta carried no change", async () => {
    await bootstrap();
    vi.mocked(refreshAgentPoolsAfterPush).mockClear();
    await expect(syncByChannel(CHANNEL)).resolves.toBe("synced");
    expect(refreshAgentPoolsAfterPush).not.toHaveBeenCalled();
  });

  it("refreshes nothing when the only change was the event Slate itself created", async () => {
    await bootstrap();
    (db.current as FakeDb).seed("bookings", [
      { id: "bk-1", assigned_user_id: USER_ID, status: "confirmed", gcal_event_id: "evt-slate" },
    ]);
    (google.current as FakeGoogle).put("evt-slate", at(DAY + 3), at(DAY + 4));
    vi.mocked(refreshAgentPoolsAfterPush).mockClear();
    await expect(syncByChannel(CHANNEL)).resolves.toBe("synced");
    expect(blockFor("evt-slate")).toBeUndefined();
    expect(refreshAgentPoolsAfterPush).not.toHaveBeenCalled();
  });

  it("refreshes nothing when a meeting's title changed and its times did not", async () => {
    await bootstrap();
    const g = google.current as FakeGoogle;
    g.put("evt-renamed", at(DAY + 2), at(DAY + 3));
    await syncByChannel(CHANNEL);
    expect(blockFor("evt-renamed")).toBeTruthy();
    // Google redelivers the event for a title or description edit: same times.
    g.put("evt-renamed", at(DAY + 2), at(DAY + 3));
    vi.mocked(refreshAgentPoolsAfterPush).mockClear();
    await expect(syncByChannel(CHANNEL)).resolves.toBe("synced");
    expect(refreshAgentPoolsAfterPush).not.toHaveBeenCalled();
  });

  it("fails the pass, with its token unadvanced, when the read before the upsert fails", async () => {
    await bootstrap();
    const tokenBefore = cal().sync_token;
    const g = google.current as FakeGoogle;
    g.put("evt-later", at(DAY + 6), at(DAY + 7));
    (db.current as FakeDb).fail("busy_blocks", "select", 1, "read refused");
    vi.mocked(refreshAgentPoolsAfterPush).mockClear();
    await expect(syncByChannel(CHANNEL)).rejects.toThrow(/read before upsert failed/);
    expect(cal().sync_token).toBe(tokenBefore);
    expect(blockFor("evt-later")).toBeUndefined();
    expect(refreshAgentPoolsAfterPush).not.toHaveBeenCalled();
    // The next pass re-reads the same delta and lands it, refreshing once.
    await expect(syncByChannel(CHANNEL)).resolves.toBe("synced");
    expect(blockFor("evt-later")).toBeTruthy();
    expect(refreshAgentPoolsAfterPush).toHaveBeenCalledTimes(1);
  });

  it("refreshes when a meeting kept its id and moved (positive control for the edit case)", async () => {
    await bootstrap();
    const g = google.current as FakeGoogle;
    g.put("evt-moved", at(DAY + 2), at(DAY + 3));
    await syncByChannel(CHANNEL);
    g.put("evt-moved", at(DAY + 4), at(DAY + 5));
    vi.mocked(refreshAgentPoolsAfterPush).mockClear();
    await syncByChannel(CHANNEL);
    expect(refreshAgentPoolsAfterPush).toHaveBeenCalledTimes(1);
  });

  it("refreshes the agent's pools once when the sync moved busy time (positive control)", async () => {
    await bootstrap();
    (google.current as FakeGoogle).put("evt-meeting", at(DAY + 5), at(DAY + 6));
    vi.mocked(refreshAgentPoolsAfterPush).mockClear();
    await expect(syncByChannel(CHANNEL)).resolves.toBe("synced");
    expect(blockFor("evt-meeting")).toBeTruthy();
    expect(refreshAgentPoolsAfterPush).toHaveBeenCalledTimes(1);
    expect(refreshAgentPoolsAfterPush).toHaveBeenCalledWith(USER_ID);
  });

  it("refreshes when a meeting was cancelled, since that frees time", async () => {
    await bootstrap();
    const g = google.current as FakeGoogle;
    g.put("evt-gone", at(DAY + 7), at(DAY + 8));
    await syncByChannel(CHANNEL);
    g.cancel("evt-gone");
    vi.mocked(refreshAgentPoolsAfterPush).mockClear();
    await syncByChannel(CHANNEL);
    expect(blockFor("evt-gone")).toBeUndefined();
    expect(refreshAgentPoolsAfterPush).toHaveBeenCalledTimes(1);
  });
});

// #3302 review: the read that tells a retimed row from a redelivered one is paid
// ONLY by the incremental push sync, the one caller that uses the count. A full
// resync counts as a change whatever it wrote, and hydration ignores the count, so a
// bootstrap reading before every upsert batch would be a subrequest bought for nothing.
describe("only the incremental push sync reads before its upserts (#3302 review)", () => {
  /** Selects on busy_blocks filtered by event id: the pre upsert read's shape. */
  function countPreReads(): () => number {
    const fake = db.current as FakeDb;
    const original = fake.run.bind(fake);
    let n = 0;
    fake.run = (q: FakeQuery) => {
      if (
        q.table === "busy_blocks" &&
        q.mode === "select" &&
        q.filters.some((f) => f.kind === "in" && f.column === "gcal_event_id")
      ) {
        n += 1;
      }
      return original(q);
    };
    return () => n;
  }

  it("hydration makes no pre read", async () => {
    (db.current as FakeDb).seed("agent_calendars", [calendarRow()]);
    (google.current as FakeGoogle).put("evt-a", at(DAY + 1), at(DAY + 2));
    const reads = countPreReads();
    expect((await hydrateCalendar(cal())).ok).toBe(true);
    expect(reads()).toBe(0);
  });

  it("a full resync (no token yet) makes no pre read", async () => {
    (db.current as FakeDb).seed("agent_calendars", [calendarRow()]);
    (google.current as FakeGoogle).put("evt-b", at(DAY + 1), at(DAY + 2));
    const reads = countPreReads();
    await expect(syncByChannel(CHANNEL)).resolves.toBe("synced");
    expect(blockFor("evt-b")).toBeTruthy();
    expect(reads()).toBe(0);
  });

  it("the cron's incremental sync makes no pre read", async () => {
    await bootstrap();
    (google.current as FakeGoogle).put("evt-c", at(DAY + 1), at(DAY + 2));
    const reads = countPreReads();
    await runIncrementalSync(USER_ID);
    expect(blockFor("evt-c")).toBeTruthy();
    expect(reads()).toBe(0);
  });

  it("the incremental push sync does make it (positive control)", async () => {
    await bootstrap();
    (google.current as FakeGoogle).put("evt-d", at(DAY + 1), at(DAY + 2));
    const reads = countPreReads();
    await syncByChannel(CHANNEL);
    expect(reads()).toBe(1);
  });
});

// #3302 lessons review: a push sync whose first pass moved busy time and whose
// second pass then threw used to lose the refresh, because the throw left the
// function before the refresh ran. Busy time that moved must still be refreshed.
describe("a push sync refreshes what moved even when a later pass throws (#3302)", () => {
  it("refreshes once, then rethrows", async () => {
    await bootstrap();
    const g = google.current as FakeGoogle;
    g.put("evt-first", at(DAY + 1), at(DAY + 2));
    g.midFetch = async () => {
      // A second push lands during pass 1, so a second pass runs, and Google
      // fails that second fetch.
      const row = (db.current as FakeDb).rows("agent_calendars").find((r) => r.id === CAL_ID)!;
      row.sync_pending = true;
      g.midFetch = async () => {
        throw new Error("google down on pass 2");
      };
    };
    vi.mocked(refreshAgentPoolsAfterPush).mockClear();
    await expect(syncByChannel(CHANNEL)).rejects.toThrow(/google down on pass 2/);
    expect(blockFor("evt-first")).toBeTruthy();
    expect(refreshAgentPoolsAfterPush).toHaveBeenCalledTimes(1);
    expect(cal().sync_claimed_at).toBeNull();
  });

  it("refreshes nothing when the pass that threw was the only one (control)", async () => {
    await bootstrap();
    const g = google.current as FakeGoogle;
    g.put("evt-x", at(DAY + 1), at(DAY + 2));
    g.midFetch = async () => {
      throw new Error("google down on pass 1");
    };
    vi.mocked(refreshAgentPoolsAfterPush).mockClear();
    await expect(syncByChannel(CHANNEL)).rejects.toThrow(/pass 1/);
    expect(refreshAgentPoolsAfterPush).not.toHaveBeenCalled();
  });
});

// #3302 lessons review: a pass that throws after it began writing busy time may have
// moved some, and a retry would find those rows already stored and count zero, so
// it is treated as having moved: the refresh runs, and the error is rethrown.
describe("a pass that fails part way through its writes still refreshes (#3302)", () => {
  it("refreshes once and rethrows when the second upsert chunk fails", async () => {
    await bootstrap();
    const g = google.current as FakeGoogle;
    // More than one upsert chunk (500 rows each).
    for (let i = 0; i < 501; i++) g.put(`evt-bulk-${i}`, at(DAY + 1 + (i % 50) / 10), at(DAY + 2 + (i % 50) / 10));
    (db.current as FakeDb).fail("busy_blocks", "upsert", 1, "chunk 2 refused", 1);
    vi.mocked(refreshAgentPoolsAfterPush).mockClear();
    await expect(syncByChannel(CHANNEL)).rejects.toThrow(/chunk 2 refused/);
    expect(blockFor("evt-bulk-0")).toBeTruthy();
    expect(refreshAgentPoolsAfterPush).toHaveBeenCalledTimes(1);
  });

  it("refreshes once and rethrows when the delete after the upserts fails", async () => {
    await bootstrap();
    const g = google.current as FakeGoogle;
    g.put("evt-keep", at(DAY + 1), at(DAY + 2));
    g.put("evt-drop", at(DAY + 3), at(DAY + 4));
    await syncByChannel(CHANNEL);
    g.put("evt-new", at(DAY + 5), at(DAY + 6));
    g.cancel("evt-drop");
    (db.current as FakeDb).fail("busy_blocks", "delete", 1, "delete refused");
    vi.mocked(refreshAgentPoolsAfterPush).mockClear();
    await expect(syncByChannel(CHANNEL)).rejects.toThrow(/delete refused/);
    expect(refreshAgentPoolsAfterPush).toHaveBeenCalledTimes(1);
  });
});
