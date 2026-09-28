// The times a booking may be MOVED to (#2827).
//
// A booking made through an advisor's own link (#2073, kind = 'agent_link') can
// only be moved to a time that same advisor can take: the reschedule keeps the
// agent or refuses. So every surface that offers a move time for one must offer
// THAT advisor's times, never the pool of the bucket the booking is stored in, or
// a lead picks a time somebody else in the pool is free and is told it is taken.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reschedule-times.ts
import {
  bookingRescheduleTimes,
  RESCHEDULE_TIMES_UNAVAILABLE_CODE,
  type RescheduleTimesBooking,
  type RescheduleTimesDeps,
} from "../src/lib/booking/reschedule-times.ts";
import {
  adminRescheduleTimesUrl,
  leadRescheduleTimesUrl,
  rescheduleTimesFrom,
} from "../src/lib/booking/reschedule-times-url.ts";
import { rescheduleNoTimes, RESCHEDULE_COPY } from "../src/lib/booking/manage-copy.ts";
import { rescheduleTimesRefusalSentence } from "../src/lib/booking/reschedule-times-refusal.ts";
import type { EventType } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-06-08T12:00:00.000Z"); // a Monday
const TOKEN = "cd".repeat(32);
const eventType = {
  id: "et1",
  name: "Follow up call",
  description: null,
  duration_min: 30,
  min_notice_min: 60,
} as unknown as EventType;
const openAllWeek = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
  exceptions: [],
};

// Two times. The ADVISOR can take only the first; somebody else in the pool can
// take the second. That second one is the time this issue is about.
const BOTH_FREE = "2026-06-09T14:00:00.000Z";
const POOL_ONLY = "2026-06-09T15:00:00.000Z";
const ADVISOR = "advisor-1";

const advisorBooking: RescheduleTimesBooking = {
  status: "confirmed",
  kind: "agent_link",
  assignedUserId: ADVISOR,
  bucketCode: "411",
};
const routedBooking: RescheduleTimesBooking = { ...advisorBooking, kind: "routed" };

/**
 * A fake of the ONE compute both reads rest on: asked for a named agent it
 * answers that agent's times, which is what `namedAgentResolver` narrows the
 * bucket's pool to. The pool's own answer is what `/api/availability?bucket=`
 * serves, so a test can compare the two.
 */
function poolSlots(): string[] {
  return [BOTH_FREE, POOL_ONLY];
}
function slotsForAgent(agentUserId: string): string[] {
  return agentUserId === ADVISOR ? [BOTH_FREE] : [BOTH_FREE, POOL_ONLY];
}

function deps(booking: RescheduleTimesBooking | null, over: Partial<RescheduleTimesDeps> = {}) {
  const calls = {
    slotsFor: [] as { code: string; agent: string }[],
    refusals: [] as string[],
    loaded: [] as string[],
  };
  const d: RescheduleTimesDeps = {
    loadBooking: async (key) => {
      calls.loaded.push(key);
      return booking;
    },
    horizonDays: async () => 4,
    slotsFor: async (code, agentId) => {
      calls.slotsFor.push({ code, agent: agentId });
      return { slots: slotsForAgent(agentId), eventType, orgName: "Pennie" };
    },
    businessHours: async () => openAllWeek as never,
    logRefusal: (why) => calls.refusals.push(why),
    ...over,
  };
  return { d, calls };
}

async function run() {
  // --- which times a booking may be moved to, decided once -----------------------
  eq(rescheduleTimesFrom({ kind: "agent_link" }), "advisor", "an advisor link booking moves within its advisor's times");
  eq(rescheduleTimesFrom({ kind: "routed" }), "pool", "a routed booking moves within its bucket's pool");

  // --- the headline: a time only the POOL can take ------------------------------
  {
    const { d, calls } = deps(advisorBooking);
    const r = await bookingRescheduleTimes(TOKEN, { from: null, to: null }, NOW, d);
    assert(r.status === 200, "an active advisor link booking answers 200");
    if (r.status === 200) {
      assert(!r.body.slots.includes(POOL_ONLY), "a time only the pool can take is NOT offered for an advisor link booking");
      assert(r.body.slots.includes(BOTH_FREE), "a time the advisor can take IS offered");
      eq(r.body.bucket.code, "", "the bucket the booking is stored in is never sent");
    }
    eq(calls.slotsFor, [{ code: "411", agent: ADVISOR }], "computed for the booking's own advisor, in the booking's own bucket");
  }
  {
    // The routed booking reads its bucket's pool, through the path it always has.
    const url = leadRescheduleTimesUrl(rescheduleTimesFrom(routedBooking), { bucketCode: "411", manageToken: TOKEN });
    eq(url, "/api/availability?bucket=411", "a routed booking's picker reads the bucket's pooled times");
    assert(poolSlots().includes(POOL_ONLY), "and that pool read IS where the pool-only time is offered for a routed booking");
    const { d, calls } = deps(routedBooking);
    const r = await bookingRescheduleTimes(TOKEN, { from: null, to: null }, NOW, d);
    assert(r.status === 404, "the booking-keyed read refuses a routed booking, so it can never serve a narrowed pool by accident");
    eq(calls.slotsFor.length, 0, "and computes nothing for it");
  }

  // --- every surface reads the same way -------------------------------------------
  eq(
    leadRescheduleTimesUrl("advisor", { bucketCode: "411", manageToken: TOKEN }),
    `/api/availability?booking=${TOKEN}`,
    "the manage page and the booker read an advisor booking's times by its manage token",
  );
  eq(
    adminRescheduleTimesUrl("advisor", { bucketCode: "411", bookingId: "b 1" }),
    "/api/admin/bookings/b%201/availability",
    "the admin move reads an advisor booking's times through the staff route, keyed on the booking id",
  );
  eq(
    adminRescheduleTimesUrl("pool", { bucketCode: "411", bookingId: "b1" }),
    "/api/availability?bucket=411",
    "the admin move reads a routed booking's times from the pool, as it always has",
  );
  eq(adminRescheduleTimesUrl("pool", { bucketCode: null, bookingId: "b1" }), null, "no bucket, nothing to read");

  // --- the refusals are one body, and name no cause -------------------------------
  for (const [label, booking, why] of [
    ["no booking holds the token", null, "booking_not_found"],
    ["a cancelled booking", { ...advisorBooking, status: "cancelled" }, "booking_not_active"],
    ["a completed booking", { ...advisorBooking, status: "completed" }, "booking_not_active"],
    ["an advisor booking with nobody on it", { ...advisorBooking, assignedUserId: null }, "no_advisor"],
    ["a routed booking", routedBooking, "not_an_advisor_booking"],
  ] as const) {
    const { d, calls } = deps(booking as RescheduleTimesBooking | null);
    const r = await bookingRescheduleTimes(TOKEN, { from: null, to: null }, NOW, d);
    assert(r.status === 404, `${label}: refused`);
    if (r.status !== 200) {
      eq(r.body.code, RESCHEDULE_TIMES_UNAVAILABLE_CODE, `${label}: one code for every cause`);
      eq(r.body.error, RESCHEDULE_COPY.unavailable, `${label}: one sentence for every cause`);
    }
    eq(calls.refusals, [why], `${label}: the cause goes to the log`);
  }
  {
    const { d, calls } = deps(advisorBooking, { slotsFor: async () => null });
    const r = await bookingRescheduleTimes(TOKEN, { from: null, to: null }, NOW, d);
    assert(r.status === 404, "a bucket that vanished refuses rather than answering an empty week");
    eq(calls.refusals, ["bucket_unresolvable"], "and says why in the log");
  }
  {
    const { d, calls } = deps(advisorBooking);
    const r = await bookingRescheduleTimes(TOKEN, { from: "not a date", to: null }, NOW, d);
    assert(r.status === 400, "an unreadable window is a 400");
    eq(calls.loaded.length, 0, "and is refused before the booking is read");
  }
  {
    // A read that FAILS is not a booking that does not exist: it throws, so the
    // route answers 500 rather than the refusal, which reads as final (#277).
    const { d } = deps(advisorBooking, {
      loadBooking: async () => {
        throw new Error("db down");
      },
    });
    let threw = false;
    try {
      await bookingRescheduleTimes(TOKEN, { from: null, to: null }, NOW, d);
    } catch (err) {
      threw = (err as Error).message === "db down";
    }
    assert(threw, "a failed booking read throws rather than refusing");
  }

  // --- the window is the same horizon the advisor link uses ----------------------
  {
    const seen: { from: string; to: string }[] = [];
    const { d } = deps(advisorBooking, {
      slotsFor: async (_c, _a, from, to) => {
        seen.push({ from, to });
        return { slots: [], eventType, orgName: "Pennie" };
      },
    });
    const r = await bookingRescheduleTimes(TOKEN, { from: "2020-01-01T00:00:00.000Z", to: "2030-01-01T00:00:00.000Z" }, NOW, d);
    assert(Date.parse(seen[0].from) === NOW, "a window starting in the past starts now");
    assert(Date.parse(seen[0].to) === NOW + 5 * 86_400_000, "a window past the horizon stops at the horizon plus one day");
    assert(r.status === 200 && r.body.slots.length === 0 && r.body.emptyBecause !== undefined, "an empty week is an answer, not a refusal");
  }

  // --- what the lead reads -------------------------------------------------------
  eq(
    rescheduleNoTimes({ from: "advisor", advisorName: "Aisha Bello" }),
    "Aisha Bello has no other open times in the next few days. Keep your current time, or check back later.",
    "an advisor with nothing left is named, and the lead is told what they can still do",
  );
  eq(
    rescheduleNoTimes({ from: "advisor", advisorName: null }),
    "Your advisor has no other open times in the next few days. Keep your current time, or check back later.",
    "with no name to give, the advisor is still the subject, never a placeholder",
  );
  eq(rescheduleNoTimes({ from: "pool", advisorName: "Aisha Bello" }), RESCHEDULE_COPY.noTimes, "a routed booking keeps the pooled sentence");
  eq(
    rescheduleTimesRefusalSentence({ code: RESCHEDULE_TIMES_UNAVAILABLE_CODE }),
    RESCHEDULE_COPY.unavailable,
    "a refused read is said in the reschedule's own words, not the advisor link's",
  );
  eq(rescheduleTimesRefusalSentence({ code: "OTHER" }), null, "any other failure is left to the ordinary retry");
}

run().then(finish);
