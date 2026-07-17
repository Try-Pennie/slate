import { describe, it, expect } from "vitest";
import { claimRescheduleLock } from "./service";

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
function makeFakeDb(seed: { locks?: Row[]; bookings?: Row[]; updateError?: { code?: string } } = {}) {
  const store: Record<string, Map<string, Row>> = {
    reschedule_locks: new Map((seed.locks ?? []).map((r) => [String(r.booking_id), r])),
    bookings: new Map((seed.bookings ?? []).map((r) => [String(r.id), r])),
  };
  const pkCol = (table: string) => (table === "bookings" ? "id" : "booking_id");

  class Builder {
    private mode: "select" | "insert" | "update" = "select";
    private insertRow?: Row;
    private patch?: Row;
    private selected = false;
    private single = false;
    private filters: ((r: Row) => boolean)[] = [];
    constructor(private table: string) {}
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
        const key = String(this.insertRow![pkCol(this.table)]);
        if (table.has(key)) return { data: null, error: { code: "23505" } };
        table.set(key, { ...this.insertRow! });
        return { data: null, error: null };
      }
      const matches = [...table.values()].filter((r) => this.filters.every((f) => f(r)));
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

  it("fails CLOSED (throws) when the takeover UPDATE errors", async () => {
    // A takeover we can't confirm must not silently proceed as a holder.
    const db = makeFakeDb({
      locks: [expiredLockAtT()],
      bookings: [{ id: "bk1", starts_at: OLD }],
      updateError: { code: "57014" },
    });
    await expect(claimRescheduleLock(db, "bk1", T, NOW)).rejects.toThrow(/lock this booking/i);
  });
});
