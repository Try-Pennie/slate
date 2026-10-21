// #3248: finding the target of a reroute (phase 2 of #3244).
//
// An admin corrects a booking's bucket; Slate routes it AS IF it were a new booking
// into that bucket, at the booking's existing time, through the booker's own
// round robin, verify on book and tier ladder. Dan's search order (2026-10-04):
//   1. keep the current advisor if they are eligible in the corrected bucket;
//   2. otherwise anyone else free in it;
//   3. otherwise down the tiers, the current advisor first at each rung;
//   4. otherwise keep the current advisor as the last resort, with a warning, but
//      only when they can take the call themselves (#3487); one on time off, off
//      shift or not free is none-current-unavailable, never a keep.
// The time never changes, and a live verify failure is a retriable error, never a
// silent keep.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reroute-target.ts
import {
  findRerouteTarget,
  currentAgentUnavailableIn,
  VerifyUnavailableError,
  type RerouteTargetDeps,
  type CurrentAgentPicture,
} from "../src/lib/booking/orchestration.ts";
import type { Booking, Bucket, EventType } from "../src/lib/db/types.ts";
import type { MemberAvailability } from "../src/lib/availability/compute.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const OPEN = {
  zone: "UTC",
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
  exceptions: [],
};
const eventType = {
  id: "et1", duration_min: 20, buffer_before_min: 10, buffer_after_min: 10,
  min_notice_min: 120, daily_cap: 8, slot_interval_min: 10,
} as unknown as EventType;
const bucketFor = (code: string, isTest = false) =>
  ({ id: `b${code}`, org_id: "org1", code, is_test: isTest, event_type_id: "et1", fallback_user_id: null }) as unknown as Bucket;

// The booking: 10:00 to 10:20 on a Tuesday, held by advisor CUR, 30 minutes from
// "now", which is well inside the two hour minimum notice a NEW lead must give.
const START = "2031-03-04T10:00:00.000Z";
const END = "2031-03-04T10:20:00.000Z";
const NOW = Date.parse("2031-03-04T09:30:00.000Z");
const booking = {
  id: "K1", assigned_user_id: "CUR", starts_at: START, ends_at: END, bucket_id: "b100", kind: "routed",
} as unknown as Booking;

const curShift = (over: Partial<MemberAvailability> = {}): MemberAvailability => ({
  userId: "CUR", timezone: "UTC", rules: [{ weekday: 2, start_minute: 9 * 60, end_minute: 17 * 60 }],
  // Their own write through block for this booking.
  busy: [{ start: Date.parse(START), end: Date.parse(END) }],
  bookingStartsMs: [], dayCounts: new Map([["2031-03-04", 1]]),
  ...over,
});

interface FakeOpts {
  /** Codes that exist as buckets (others resolve to null). */
  buckets?: string[];
  /** Per code: who the round robin offers, BEFORE the current advisor is excluded. */
  candidates?: Record<string, string[]>;
  /** Emails live verify finds free. */
  free?: Set<string>;
  /** Emails live verify could not read. */
  unverified?: Set<string>;
  /** Per code: is the current advisor a member, and do they carry Low. */
  membership?: Record<string, { member: boolean; low?: boolean; fallbackApplied?: boolean; lowUnknown?: boolean }>;
  currentMember?: MemberAvailability | null;
  onTimeOff?: boolean;
  pictureThrows?: boolean;
  testBuckets?: Set<string>;
}

function fake(o: FakeOpts) {
  const calls = { verify: [] as string[][], rr: [] as { code: string; opts: unknown; excludeLow: boolean }[], pictures: [] as string[] };
  const deps: RerouteTargetDeps = {
    resolveBucketByCode: async (code) =>
      (o.buckets ?? []).includes(code) ? { bucket: bucketFor(code, o.testBuckets?.has(code)), eventType } : null,
    roundRobinCandidates: async (b, _e, startMs, _preview, _only, excludeLow, opts) => {
      calls.rr.push({ code: b.code, opts, excludeLow: !!excludeLow });
      assert(startMs === Date.parse(START), `the round robin is asked about the booking's own start on ${b.code}`);
      const list = o.candidates?.[b.code] ?? [];
      return { candidates: list, memberCount: list.length };
    },
    loadEmails: async (ids) => new Map(ids.map((id) => [id, `${id}@x.com`])),
    verifyFree: async (emails, fromIso, toIso) => {
      calls.verify.push(emails);
      assert(fromIso === "2031-03-04T09:50:00.000Z" && toIso === "2031-03-04T10:30:00.000Z",
        `verify is asked about the BUFFERED stored window (got ${fromIso} to ${toIso})`);
      return {
        free: new Set(emails.filter((e) => o.free?.has(e))),
        unverified: new Set(emails.filter((e) => o.unverified?.has(e))),
      };
    },
    loadCurrentAgentPicture: async (bucket): Promise<CurrentAgentPicture> => {
      calls.pictures.push(bucket.code);
      if (o.pictureThrows) throw new Error("ooo_requests read failed: connection reset");
      const m = o.membership?.[bucket.code] ?? { member: false };
      return {
        pool: {
          ids: m.member ? ["CUR", "X"] : ["X"],
          fallbackApplied: !!m.fallbackApplied,
          ...(m.lowUnknown ? {} : { lowIds: m.low ? ["CUR"] : [] }),
        },
        member: o.currentMember === undefined ? curShift() : o.currentMember,
        onTimeOff: !!o.onTimeOff,
        businessHours: OPEN,
      };
    },
    now: () => NOW,
  };
  return { deps, calls };
}

const requested = (code: string) => ({ bucket: bucketFor(code), eventType });

async function run() {
  // --- 1. keep the current advisor when they are eligible in the corrected bucket --------
  {
    const { deps, calls } = fake({ buckets: ["212"], membership: { "212": { member: true } }, candidates: { "212": ["CUR", "A"] }, free: new Set(["A@x.com"]) });
    const r = await findRerouteTarget(deps, booking, requested("212"));
    eq(r.outcome, "keep-in-requested", "an eligible current advisor is kept in the requested bucket");
    eq(calls.verify.length, 0, "and nobody is verified live: a keep never asks Google");
    eq(r.rungsDropped, 0, "with no tiers dropped");
    eq(r.bucket.code, "212", "in the requested bucket");
  }
  // The booking being 30 minutes away does not stop the keep: minimum notice is a
  // rule for a lead choosing a time, and this time is already chosen.
  {
    const { deps } = fake({ buckets: ["212"], membership: { "212": { member: true } } });
    eq((await findRerouteTarget(deps, booking, requested("212"))).outcome, "keep-in-requested",
      "minimum notice does not refuse a keep 30 minutes before the call");
  }

  // --- #3249: a re-search after the held advisor fell through never offers them again ---
  {
    const { deps, calls } = fake({ buckets: ["212"], membership: { "212": { member: false } }, candidates: { "212": ["CUR", "A", "B"] }, free: new Set(["A@x.com", "B@x.com"]) });
    const r = await findRerouteTarget(deps, booking, requested("212"), { excludeUserIds: ["A"] });
    eq(r.outcome === "move-in-requested" ? r.userId : null, "B", "an excluded advisor is passed over even when free and first in order");
    assert(!calls.verify.flat().includes("A@x.com"), "and is never verified at all");
  }

  // --- 2. otherwise anyone else free in it -------------------------------------------------
  {
    const { deps, calls } = fake({ buckets: ["212"], membership: { "212": { member: false } }, candidates: { "212": ["CUR", "A", "B"] }, free: new Set(["B@x.com", "CUR@x.com"]) });
    const r = await findRerouteTarget(deps, booking, requested("212"));
    eq(r.outcome, "move-in-requested", "a current advisor who is not in the pool moves (red team 4)");
    eq(r.outcome === "move-in-requested" ? r.userId : null, "B", "to the first advisor verified free, in round robin order");
    assert(!calls.verify.flat().includes("CUR@x.com"), "the current advisor is never sought through Google verify, where their own call makes them busy");
    const opts = calls.rr[0]?.opts as { fixedTime?: boolean; forBookingId?: string } | undefined;
    assert(opts?.fixedTime === true && opts.forBookingId === "K1",
      "the round robin is asked at the fixed time (exact window, no minimum notice) for this booking, so its own hold excludes nobody");
  }
  // Free in the pool but busy at the time.
  {
    const busy = curShift({ busy: [{ start: Date.parse("2031-03-04T10:25:00Z"), end: Date.parse("2031-03-04T11:00:00Z") }] });
    const { deps } = fake({ buckets: ["212"], membership: { "212": { member: true } }, currentMember: busy, candidates: { "212": ["A"] }, free: new Set(["A@x.com"]) });
    eq((await findRerouteTarget(deps, booking, requested("212"))).outcome, "move-in-requested",
      "a member whose after buffer runs into another meeting is not kept");
  }
  {
    const { deps } = fake({ buckets: ["212"], membership: { "212": { member: true } }, onTimeOff: true, candidates: { "212": ["A"] }, free: new Set(["A@x.com"]) });
    eq((await findRerouteTarget(deps, booking, requested("212"))).outcome, "move-in-requested",
      "a member on approved time off is not kept");
  }
  {
    const capped = curShift({ dayCounts: new Map([["2031-03-04", 9]]) });
    const { deps } = fake({ buckets: ["212"], membership: { "212": { member: true } }, currentMember: capped, candidates: { "212": ["A"] }, free: new Set(["A@x.com"]) });
    eq((await findRerouteTarget(deps, booking, requested("212"))).outcome, "move-in-requested",
      "a member over their daily cap with OTHER calls is not kept");
    const atCapWithThis = curShift({ dayCounts: new Map([["2031-03-04", 8]]) });
    const { deps: d2 } = fake({ buckets: ["212"], membership: { "212": { member: true } }, currentMember: atCapWithThis });
    eq((await findRerouteTarget(d2, booking, requested("212"))).outcome, "keep-in-requested",
      "control: at the cap only because of THIS booking, they are kept, since it does not count against itself");
  }
  {
    const { deps } = fake({ buckets: ["212"], membership: { "212": { member: true, fallbackApplied: true } }, candidates: { "212": ["A"] }, free: new Set(["A@x.com"]) });
    eq((await findRerouteTarget(deps, booking, requested("212"))).outcome, "move-in-requested",
      "the bucket's fallback advisor stand in is not membership");
  }
  {
    const off = curShift({ rules: [{ weekday: 2, start_minute: 11 * 60, end_minute: 17 * 60 }] });
    const { deps } = fake({ buckets: ["212"], membership: { "212": { member: true } }, currentMember: off, candidates: { "212": ["A"] }, free: new Set(["A@x.com"]) });
    eq((await findRerouteTarget(deps, booking, requested("212"))).outcome, "move-in-requested",
      "a member off shift at the time is not kept");
  }
  // An off grid booking with a current advisor whose shift starts at :05 (red team 9).
  {
    const fiveShift = curShift({ rules: [{ weekday: 2, start_minute: 9 * 60 + 5, end_minute: 17 * 60 }] });
    const { deps } = fake({ buckets: ["212"], membership: { "212": { member: true } }, currentMember: fiveShift });
    eq((await findRerouteTarget(deps, booking, requested("212"))).outcome, "keep-in-requested",
      "a :05 advisor is kept at a 10:00 booking: the exact window is judged, not their offering grid");
  }

  // --- 3. down the tiers, the current advisor first at each rung ----------------------------
  {
    const { deps } = fake({ buckets: ["212", "112"], membership: { "112": { member: true } }, candidates: { "212": ["A"], "112": ["B"] }, free: new Set(["B@x.com"]) });
    const r = await findRerouteTarget(deps, booking, requested("212"));
    eq(r.outcome, "keep-cascaded", "the current advisor eligible one rung down is kept there before anyone else on that rung");
    eq(`${r.bucket.code}|${r.rungsDropped}`, "112|1", "naming the bucket used and the rungs dropped");
  }
  {
    const { deps } = fake({ buckets: ["212", "112"], candidates: { "212": ["A"], "112": ["B"] }, free: new Set(["B@x.com"]) });
    const r = await findRerouteTarget(deps, booking, requested("212"));
    eq(r.outcome, "move-cascaded", "nobody free in the requested bucket moves to somebody free one rung down");
    eq(`${r.bucket.code}|${r.rungsDropped}|${r.outcome === "move-cascaded" ? r.userId : ""}`, "112|1|B", "naming bucket, rungs and advisor");
  }
  // A rung below a top tier lead's own tier skips Low carriers (#2842), for the
  // current advisor too.
  {
    const { deps, calls } = fake({ buckets: ["411", "311", "211"], membership: { "311": { member: true, low: true }, "211": { member: true, low: false } } });
    const r = await findRerouteTarget(deps, booking, requested("411"));
    eq(`${r.outcome}|${r.bucket.code}`, "keep-cascaded|211", "a current advisor carrying Low is not kept on a rung that excludes Low");
    assert(calls.rr.filter((c) => c.code === "311").every((c) => c.excludeLow), "and the round robin on that rung excluded Low too");
  }
  {
    const { deps } = fake({ buckets: ["411", "311"], membership: { "311": { member: true, lowUnknown: true } } });
    eq((await findRerouteTarget(deps, booking, requested("411"))).outcome, "keep-last-resort",
      "an unknown Low answer on an excluding rung fails closed: not kept there");
  }
  // A test bucket is never a rung for a real booking.
  {
    const { deps } = fake({ buckets: ["212", "112"], testBuckets: new Set(["112"]), membership: { "112": { member: true } } });
    eq((await findRerouteTarget(deps, booking, requested("212"))).outcome, "keep-last-resort", "a test bucket rung is skipped for a real booking");
  }

  // --- 4. the last resort ----------------------------------------------------------------------
  {
    const { deps } = fake({ buckets: ["212", "112"], candidates: { "212": ["A"], "112": ["B"] }, free: new Set() });
    const r = await findRerouteTarget(deps, booking, requested("212"));
    eq(r.outcome, "keep-last-resort", "nobody anywhere: the current advisor is the last resort");
    eq(r.bucket.code, "212", "and the bucket is still corrected to the requested one");
  }

  // --- #3487: the last resort keeps only an advisor who can take the call ----------------------
  // Reroute kept an advisor on approved time off, and said they stay, because the last
  // resort never asked whether the current advisor could serve the time at all.
  {
    const { deps } = fake({ buckets: ["212", "112"], membership: { "212": { member: true } }, onTimeOff: true, candidates: { "212": ["A"], "112": ["B"] }, free: new Set() });
    const r = await findRerouteTarget(deps, booking, requested("212"));
    eq(r.outcome, "none-current-unavailable", "an advisor on time off with nobody else free is NOT kept as the last resort");
    eq(r.outcome === "none-current-unavailable" ? r.reason : null, "time_off", "and the reason says it is the time off");
  }
  {
    const off = curShift({ rules: [{ weekday: 2, start_minute: 11 * 60, end_minute: 17 * 60 }] });
    const { deps } = fake({ buckets: ["212"], currentMember: off, candidates: { "212": ["A"] }, free: new Set() });
    const r = await findRerouteTarget(deps, booking, requested("212"));
    eq(r.outcome === "none-current-unavailable" ? r.reason : r.outcome, "not_free", "an advisor off shift at the time is not kept either");
  }
  {
    const busy = curShift({ busy: [{ start: Date.parse(START), end: Date.parse(END) }, { start: Date.parse("2031-03-04T10:10:00Z"), end: Date.parse("2031-03-04T10:40:00Z") }] });
    const { deps } = fake({ buckets: ["212"], currentMember: busy, candidates: { "212": ["A"] }, free: new Set() });
    const r = await findRerouteTarget(deps, booking, requested("212"));
    eq(r.outcome === "none-current-unavailable" ? r.reason : r.outcome, "not_free", "an advisor with another meeting over the call is not kept");
  }
  {
    const { deps } = fake({ buckets: ["212"], currentMember: null, candidates: { "212": ["A"] }, free: new Set() });
    const r = await findRerouteTarget(deps, booking, requested("212"));
    eq(r.outcome === "none-current-unavailable" ? r.reason : r.outcome, "no_schedule", "an advisor with no schedule row is not kept");
  }
  {
    // Control: outside every pool on the ladder, but free and on shift, they still stay.
    const { deps } = fake({ buckets: ["212", "112"], candidates: { "212": ["A"] }, free: new Set() });
    eq((await findRerouteTarget(deps, booking, requested("212"))).outcome, "keep-last-resort",
      "control: an available advisor with nobody else free is still the last resort");
  }
  {
    // The rule is judged on the REQUESTED bucket's event type, whose buffers the kept call keeps.
    const { deps, calls } = fake({ buckets: ["212", "112"], onTimeOff: true, candidates: {}, free: new Set() });
    await findRerouteTarget(deps, booking, requested("212"));
    eq(calls.pictures.filter((c) => c === "212").length, 1, "the requested bucket's picture is read once, not again for the last resort");
  }

  // --- #3487: the keep confirm's own check reads the same picture and rule ---------------------
  {
    const { deps, calls } = fake({ buckets: ["412"], onTimeOff: true });
    eq(await currentAgentUnavailableIn(deps, booking, requested("412")), "time_off", "the confirm check names time off");
    eq(calls.pictures, ["412"], "read in the bucket the advisor would be kept in");
    const { deps: d2 } = fake({ buckets: ["412"] });
    eq(await currentAgentUnavailableIn(d2, booking, requested("412")), null, "control: an available advisor passes");
    const { deps: d3, calls: c3 } = fake({ buckets: ["412"] });
    eq(await currentAgentUnavailableIn(d3, { ...booking, assigned_user_id: null } as Booking, requested("412")), null,
      "a booking with nobody on it has nobody to judge");
    eq(c3.pictures.length, 0, "and reads nothing");
    const { deps: d4 } = fake({ buckets: ["412"], pictureThrows: true });
    let err = "";
    try { await currentAgentUnavailableIn(d4, booking, requested("412")); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert(/ooo_requests read failed/.test(err), "a failed read throws, never reads as available");
  }

  // --- a verify outage or an unreadable read is retriable, never a keep ------------------------
  {
    const { deps } = fake({ buckets: ["212", "112"], candidates: { "212": ["A"] }, unverified: new Set(["A@x.com"]), membership: { "112": { member: true } } });
    let err: unknown = null;
    try { await findRerouteTarget(deps, booking, requested("212")); } catch (e) { err = e; }
    assert(err instanceof VerifyUnavailableError, "a live verify outage throws the retriable error rather than cascading or keeping");
  }
  {
    const { deps } = fake({ buckets: ["212"], pictureThrows: true, candidates: { "212": ["A"] }, free: new Set(["A@x.com"]) });
    let err = "";
    try { await findRerouteTarget(deps, booking, requested("212")); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert(/ooo_requests read failed/.test(err), `a failed time off or cap read throws, never reads as a keep or a move (got ${err})`);
  }
}

run().then(finish);
