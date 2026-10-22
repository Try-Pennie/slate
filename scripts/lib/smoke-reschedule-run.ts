// The reschedule smoke's run, with its network and its clock injected (#4060), so
// the way a crashed run affects the NEXT one is node-testable
// (scripts/test-smoke-reschedule-run.ts). scripts/smoke-reschedule.ts wires the real
// `jpost` and `slots` into it and owns only the process exit.
//
// What #4060 changed, after 2026-10-21 (runs 39694932888 and 39698605820):
//
//  1. The attendee carries a per run PHONE (rescheduleSmokeIdentity), not the fixed
//     +12025550123 that let a leftover booking weak match the next run.
//  2. The create must answer 200 `created` before its manage token is taken
//     (`createRefusal`, scripts/lib/smoke-own-booking.ts).
//  3. The teardown cancel retries, and names the booking when it stays active
//     (`cancelSmokeBooking`, same module).
import { tokenFrom, type Json } from "../smoke-lib.ts";
import {
  cancelSmokeBooking,
  createCheckMessage,
  createRefusal,
  teardownCheckMessage,
  type SmokePost,
} from "./smoke-own-booking.ts";
import { rescheduleSmokeIdentity } from "./smoke-reschedule-identity.ts";
import { SMOKE_NAMES } from "./smoke-failure-log.ts";

export type { SmokePost };

export interface RescheduleSmokeDeps {
  bucket: string;
  /** The run's nonce (Date.now() in production): makes the identity unique per run. */
  nonce: number;
  post: SmokePost;
  slots: (bucket: string) => Promise<string[]>;
  check: (cond: boolean, msg: string) => void;
  /** The teardown's backoff. Injected so a test never waits for real (L524). */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const REASON = "schedule_conflict";

/** How the reschedule smoke names itself in the crash record and the alert (#4062). */
export const RESCHEDULE_SMOKE_NAME = SMOKE_NAMES.reschedule;

/**
 * The script's exit code: 1 when the run crashed, the bucket could not host it or any
 * check failed, 0 only when every check passed.
 */
export function rescheduleSmokeExitCode(outcome: "ran" | "too_few_slots" | "crashed", failures: number): 0 | 1 {
  return outcome !== "ran" || failures > 0 ? 1 : 0;
}

/**
 * Run the reschedule smoke once. Returns "too_few_slots" when the bucket cannot host
 * the run (a failed check is already recorded); otherwise "ran". A thrown network
 * error propagates, after the teardown has had its chance to cancel.
 */
export async function runRescheduleSmoke(deps: RescheduleSmokeDeps): Promise<"ran" | "too_few_slots"> {
  const { post, check } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const open = await deps.slots(deps.bucket);
  // Need 4 WELL-SPACED future slots: SMOKE slots are 10 min apart but the
  // appointment is longer, so adjacent slots overlap the booking's own time
  // (the agent looks busy -> reassign -> no other agent). Space them 6 slots
  // (~1h) apart so each reschedule target is genuinely free.
  check(open.length >= 19, `SMOKE has >= 19 future slots (got ${open.length})`);
  if (open.length < 19) return "too_few_slots";
  const s0 = open[0], s1 = open[6], s2 = open[12], s3 = open[18];

  // #3576: a per-run nonce so each run's idempotency key (and therefore its
  // deterministic Google event id) is unique. #4060: the phone too, so a booking an
  // earlier run left active cannot weak match this one. Stable WITHIN the run (one
  // nonce), so create/reschedule/cancel agree.
  const { externalId, email, phone } = rescheduleSmokeIdentity(s0, deps.nonce);
  let token = "";
  let bookingId = "";

  try {
    // 1. Book a throwaway appointment in the test bucket.
    const created = await post(
      "/api/bookings",
      {
        bucketCode: deps.bucket,
        start: s0,
        timezone: "America/New_York",
        attendee: { name: "Resched Smoke", email, phone },
        externalId,
        confirmReschedule: false,
        dryRun: false,
      },
      true,
    );
    const refused = createRefusal(created);
    check(refused === null, createCheckMessage(created, refused));
    // #4060: stop here. The booking in a non created answer is not this run's.
    if (refused !== null) return "ran";
    const booking = created.body.booking as Json | undefined;
    token = tokenFrom(booking?.manageUrl ?? created.body.manageUrl);
    bookingId = String(booking?.id ?? "");
    check(!!token, "create returns a manage token");
    if (!token) return "ran";

    // 2. A normal reschedule to a different time must succeed (new code + real DB).
    const moved = await post(`/api/bookings/${token}/reschedule`, { start: s1, reason: REASON });
    check(moved.status === 200, `reschedule -> 200 (got ${moved.status}${moved.status !== 200 ? ` err=${moved.body.error}` : ""})`);
    check(moved.body.startsAt === s1, `reschedule lands on the new time (${moved.body.startsAt} == ${s1})`);

    // 3. Two DIFFERENT-target reschedules at once: exactly one wins, the other 409s.
    const [a, b] = await Promise.all([
      post(`/api/bookings/${token}/reschedule`, { start: s2, reason: REASON }),
      post(`/api/bookings/${token}/reschedule`, { start: s3, reason: REASON }),
    ]);
    const statuses = [a.status, b.status].sort();
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 409);
    log(`  concurrent statuses: ${a.status}, ${b.status}`);
    if (conflicts.length === 1) {
      check(oks.length === 1 && conflicts.length === 1, "concurrent: exactly one wins, one conflicts (409)");
      check(
        /just changed/i.test(String(conflicts[0].body.error ?? "")),
        `conflict carries the refresh message (got: ${conflicts[0].body.error})`,
      );
    } else {
      // The two requests serialized (the winner released before the other claimed):
      // both are valid sequential reschedules. Not a failure, but flag it so the run
      // is re-tried if we specifically wanted to exercise the conflict path.
      log(
        `  NOTE: both reschedules serialized (${statuses.join(",")}), no overlap this run; re-run to exercise the conflict path.`,
      );
      check(oks.length === 2, "concurrent: serialized run still left the booking consistent (both 200)");
    }
  } finally {
    // 4. Teardown: cancel the booking (frees the slot + deletes the calendar event).
    if (token) {
      const cancelled = await cancelSmokeBooking(post, token, deps.sleep);
      check(cancelled.ok, teardownCheckMessage(bookingId, cancelled));
    }
  }
  return "ran";
}
