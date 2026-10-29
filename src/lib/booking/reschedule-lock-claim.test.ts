import { describe, it, expect } from "vitest";
import { claimRescheduleLock, releaseAbandonedPinLock, takeOverAbandonedPinLock } from "./service";
import { RescheduleLockUnavailableError, type AbandonedReschedulePin } from "./orchestration";
import { mayTakeOverLock } from "@/lib/google/invite-moves";

// AUD-050 / #480: the expired-lease takeover in claimReschedule used to re-lease
// UNCONDITIONALLY, so two claimants that both read the same crashed (expired)
// lease could BOTH adopt the pin and both fire the move (two history rows, two
// dedupe keys, a double `rescheduled` webhook). The fix makes the takeover a
// compare-and-swap on the still-expired lease so exactly one claimant wins.
//
// These drive the real `claimRescheduleLock` seam against a store-backed fake DB
// that enforces the same CAS semantics Postgres does (a conditional UPDATE only
// touches rows still matching its WHERE), so the test proves OUR handling of the
// 0-rows / error / winner results, not a mock that rubber-stamps them.

type Row = Record<string, unknown>;

// Minimal query-builder fake honoring the exact chains claimRescheduleLock uses:
// insert (PK-conflict aware), select().eq().maybeSingle(), and
// update().eq().or().select() with the `.or()` predicate actually evaluated.
function makeFakeDb(
  seed: { locks?: Row[]; bookings?: Row[]; updateError?: { code?: string }; insertError?: { code?: string } } = {},
) {
  const store: Record<string, Map<string, Row>> = {
    reschedule_locks: new Map((seed.locks ?? []).map((r) => [String(r.booking_id), r])),
    bookings: new Map((seed.bookings ?? []).map((r) => [String(r.id), r])),
  };
  const pkCol = (table: string) => (table === "bookings" ? "id" : "booking_id");

  class Builder {
    private mode: "select" | "insert" | "update" | "delete" = "select";
    private insertRow?: Row;
    private patch?: Row;
    private selected = false;
    private single = false;
    private filters: ((r: Row) => boolean)[] = [];
    private table: string;
    constructor(table: string) {
      this.table = table;
    }
    insert(row: Row) {
      this.mode = "insert";
      this.insertRow = row;
      return this;
    }
    update(patch: Row) {
      this.mode = "update";
      this.patch = patch;
      return this;
    }
    select(_cols?: string) {
      this.selected = true;
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push((r) => String(r[col]) === String(val));
      return this;
    }
    // #3924: the abandoned pin sweep's takeover and release.
    delete() {
      this.mode = "delete";
      return this;
    }
    lt(col: string, val: string) {
      this.filters.push((r) => r[col] != null && Date.parse(String(r[col])) < Date.parse(val));
      return this;
    }
    or(expr: string) {
      // e.g. "lease_until.is.null,lease_until.lte.<iso>" (a term is col.op.value,
      // value re-joined because ISO timestamps contain dots).
      const terms = expr.split(",").map((t) => {
        const [col, op, ...rest] = t.split(".");
        return { col, op, val: rest.join(".") };
      });
      this.filters.push((r) =>
        terms.some((t) => {
          const cell = r[t.col];
          if (t.op === "is" && t.val === "null") return cell == null;
          if (t.op === "lte") return cell != null && Date.parse(String(cell)) <= Date.parse(t.val);
          return false;
        }),
      );
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    private run(): { data: unknown; error: { code?: string } | null } {
      const table = store[this.table];
      if (this.mode === "insert") {
        // A non-conflict insert error (e.g. a half-applied migration): fail closed.
        if (this.table === "reschedule_locks" && seed.insertError) {
          return { data: null, error: seed.insertError };
        }
        const key = String(this.insertRow![pkCol(this.table)]);
        if (table.has(key)) return { data: null, error: { code: "23505" } };
        table.set(key, { ...this.insertRow! });
        return { data: null, error: null };
      }
      const matches = [...table.values()].filter((r) => this.filters.every((f) => f(r)));
      if (this.mode === "delete") {
        for (const r of matches) table.delete(String(r[pkCol(this.table)]));
        return { data: null, error: null };
      }
      if (this.mode === "update") {
        if (this.table === "reschedule_locks" && seed.updateError) {
          return { data: null, error: seed.updateError };
        }
        for (const r of matches) Object.assign(r, this.patch);
        return { data: this.selected ? matches.map((r) => ({ booking_id: r.booking_id })) : null, error: null };
      }
      if (this.single) return { data: matches[0] ?? null, error: null };
      return { data: matches, error: null };
    }
    then<T>(resolve: (v: { data: unknown; error: { code?: string } | null }) => T) {
      return Promise.resolve(this.run()).then(resolve);
    }
  }

  return { from: (table: string) => new Builder(table) } as unknown as Parameters<
    typeof claimRescheduleLock
  >[0];
}

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const T = "2026-06-09T14:00:00.000Z"; // the reschedule target
const OLD = "2026-06-08T13:00:00.000Z"; // where the booking still sits (not yet moved)
const fullPin = {
  pinned_user_id: "a",
  pinned_agent_email: "a@x.com",
  gcal_client_id: "slate-abc",
  branch: "in_place",
  reschedule_seq: 1,
};
const expiredLockAtT = (): Row => ({
  booking_id: "bk1",
  target_starts_at: T,
  lease_until: new Date(NOW - 1000).toISOString(), // crashed holder: lease already past
  ...fullPin,
});

describe("claimRescheduleLock expired-lease takeover CAS (AUD-050)", () => {
  it("lets only ONE of two concurrent claimants adopt the same crashed lease", async () => {
    const db = makeFakeDb({ locks: [expiredLockAtT()], bookings: [{ id: "bk1", starts_at: OLD }] });

    // Both racers read the SAME expired lease before either re-leases (Promise.all
    // interleaves them at each await), exactly the AUD-050 window.
    const [a, b] = await Promise.all([
      claimRescheduleLock(db, "bk1", T, NOW),
      claimRescheduleLock(db, "bk1", T, NOW),
    ]);

    const holders = [a, b].filter((c) =>
      c.outcome === "resume" || c.outcome === "won" || c.outcome === "fresh-after-abandon",
    );
    expect(holders).toHaveLength(1); // exactly one fires the move
    expect(holders[0].outcome).toBe("resume"); // same target + written pin -> resume
    const loser = [a, b].find((c) => holders[0] !== c)!;
    expect(loser.outcome).toBe("idempotent"); // the CAS loser no-ops, never double-fires
  });

  it("the sole claimant of a crashed same-target lease resumes its pin", async () => {
    const db = makeFakeDb({ locks: [expiredLockAtT()], bookings: [{ id: "bk1", starts_at: OLD }] });
    const claim = await claimRescheduleLock(db, "bk1", T, NOW);
    expect(claim.outcome).toBe("resume");
  });

  it("fails CLOSED with a typed retriable error when the takeover UPDATE errors (#479)", async () => {
    // A takeover we can't confirm must not silently proceed as a holder. The throw
    // is the typed RescheduleLockUnavailableError so the route maps it to 503 (a
    // retriable transient fault), not a generic 500.
    const db = makeFakeDb({
      locks: [expiredLockAtT()],
      bookings: [{ id: "bk1", starts_at: OLD }],
      updateError: { code: "57014" },
    });
    await expect(claimRescheduleLock(db, "bk1", T, NOW)).rejects.toThrow(RescheduleLockUnavailableError);
  });

  it("fails CLOSED with a typed retriable error when the claim INSERT errors (#479)", async () => {
    // A non-conflict insert error (not a 23505 lease-exists) must also fail closed
    // with the typed retriable error, never re-open the concurrent-duplicate window.
    const db = makeFakeDb({ insertError: { code: "57014" } });
    await expect(claimRescheduleLock(db, "bk1", T, NOW)).rejects.toThrow(RescheduleLockUnavailableError);
  });
});

// #3924: the abandoned pin sweep takes a crashed in place pin's lock over before it
// puts the lead's invite back, so nothing else acts on the booking meanwhile. These
// drive the real seams against the same CAS honouring fake.
describe("abandoned pin sweep takeover (#3924)", () => {
  const GRACE = 2 * 60_000;
  const abandoned = (): Row => ({ ...expiredLockAtT(), claimed_at: "2026-06-01T11:00:00.000Z", lease_until: new Date(NOW - GRACE - 1000).toISOString() });
  const pin: AbandonedReschedulePin = {
    booking_id: "bk1",
    pinned_agent_email: "a@x.com",
    gcal_client_id: "slate-abc",
    branch: "in_place",
    booking_gcal_event_id: "slate-abc",
    target_starts_at: T,
    booking_starts_at: OLD,
  };
  const lockRow = async (db: ReturnType<typeof makeFakeDb>) =>
    (await db.from("reschedule_locks").select("*").eq("booking_id", "bk1").maybeSingle()).data as Row | null;

  it("takes the row over, keeps its pin, and leaves it held to everything else", async () => {
    const db = makeFakeDb({ locks: [abandoned()], bookings: [{ id: "bk1", starts_at: OLD }] });
    const token = await takeOverAbandonedPinLock(db, pin, GRACE, NOW);
    expect(token).toBe(new Date(NOW).toISOString());
    const row = (await lockRow(db))!;
    expect(Date.parse(String(row.lease_until))).toBeGreaterThan(NOW);
    expect(row.gcal_client_id).toBe("slate-abc");
    // Its target is the booking's own time while the sweep holds it...
    expect(row.target_starts_at).toBe(OLD);
    // ...so the moved invite handler finds it held (a live, pinned lock)...
    expect(mayTakeOverLock({ lease_until: String(row.lease_until), gcal_client_id: String(row.gcal_client_id) }, NOW + 1)).toBe(false);
    // ...and a lead re-sending the abandoned move is told it just changed, never "done".
    expect((await claimRescheduleLock(db, "bk1", T, NOW + 1)).outcome).toBe("conflict");
  });

  it("of two sweeps at once, only one takes the row", async () => {
    const db = makeFakeDb({ locks: [abandoned()] });
    const tokens = await Promise.all([
      takeOverAbandonedPinLock(db, pin, GRACE, NOW),
      takeOverAbandonedPinLock(db, pin, GRACE, NOW),
    ]);
    expect(tokens.filter((t) => t !== null)).toHaveLength(1);
  });

  it("leaves a row a reschedule has since re-leased, or re-pinned to another event", async () => {
    const live = makeFakeDb({ locks: [{ ...abandoned(), lease_until: new Date(NOW + 60_000).toISOString() }] });
    expect(await takeOverAbandonedPinLock(live, pin, GRACE, NOW)).toBeNull();
    const repinned = makeFakeDb({ locks: [{ ...abandoned(), gcal_client_id: "slate-other" }] });
    expect(await takeOverAbandonedPinLock(repinned, pin, GRACE, NOW)).toBeNull();
    // Inside the grace is not abandoned yet either: the sweep chose it by the same rule.
    const fresh = makeFakeDb({ locks: [{ ...abandoned(), lease_until: new Date(NOW - 1000).toISOString() }] });
    expect(await takeOverAbandonedPinLock(fresh, pin, GRACE, NOW)).toBeNull();
  });

  it("throws when the takeover cannot be confirmed, so no invite is touched on a guess", async () => {
    const db = makeFakeDb({ locks: [abandoned()], updateError: { code: "57014" } });
    await expect(takeOverAbandonedPinLock(db, pin, GRACE, NOW)).rejects.toThrow(/could not be taken over/);
  });

  it("frees only the row it took, never one a reschedule has claimed since", async () => {
    const db = makeFakeDb({ locks: [abandoned()] });
    const token = (await takeOverAbandonedPinLock(db, pin, GRACE, NOW))!;
    await releaseAbandonedPinLock(db, "bk1", token);
    expect(await lockRow(db)).toBeNull();

    const taken = makeFakeDb({ locks: [abandoned()] });
    const mine = (await takeOverAbandonedPinLock(taken, pin, GRACE, NOW))!;
    // The sweep's lease ran out and a reschedule claimed the row with its own stamp.
    await taken.from("reschedule_locks").update({ claimed_at: "2026-06-01T12:05:00.000Z" }).eq("booking_id", "bk1");
    await releaseAbandonedPinLock(taken, "bk1", mine);
    expect(await lockRow(taken)).not.toBeNull();
  });
});
