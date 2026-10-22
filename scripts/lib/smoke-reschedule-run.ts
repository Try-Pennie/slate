// The reschedule smoke's run, with its network and its clock injected (#4060), so
// the way a crashed run affects the NEXT one is node-testable
// (scripts/test-smoke-reschedule-run.ts). scripts/smoke-reschedule.ts wires the real
// `jpost` and `slots` into it and owns only the process exit.
//
// What #4060 changed, after 2026-10-21 (runs 39694932888 and 39698605820):
//
//  1. The attendee carries a per run PHONE (rescheduleSmokeIdentity), not the fixed
//     +12025550123 that let a leftover booking weak match the next run.
//  2. The create must be a 200 that CREATED a booking before its manage token is
//     taken. A `409 confirm_required` carries ANOTHER booking's manage link (the one
//     dedupe matched), and a 200 `rescheduled` is an existing booking moved; reading
//     a token from either made the run reschedule and cancel a booking it never
//     created, and then report ok.
//  3. The teardown cancel is retried on a transient network error or a 503 (the
//     gated write did not run, so a retry can succeed). Cancel is safe to repeat: a
//     booking already cancelled answers 200. If it still does not land, the run
//     records a failed check NAMING the booking left active, so the alert says which
//     booking to cancel by hand instead of the next run finding it.
import { shortErrorReason } from "@/lib/notify/error-text";
import { isTransientNetworkError, tokenFrom, withRetry, type Json } from "../smoke-lib.ts";
import { rescheduleSmokeIdentity } from "./smoke-reschedule-identity.ts";

export type SmokePost = (
  path: string,
  body: Json,
  auth?: boolean,
) => Promise<{ status: number; body: Json }>;

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
/** Cancel attempts at teardown, the first included. */
const CANCEL_ATTEMPTS = 3;

/** A completed response worth another attempt: the cancel's gated write did not run. */
class RetryableStatus extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`got ${status}`);
    this.status = status;
  }
}

/** A thrown error as one short line, keeping the socket code a fetch failure hides. */
function thrownReason(err: unknown): string {
  if (err instanceof RetryableStatus) return err.message;
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  const reason = shortErrorReason(err);
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? `${reason} (${code})` : reason;
}

/**
 * Cancel the run's booking, retrying what a retry can fix. Never throws: a teardown
 * that throws replaces the error the run crashed on, and loses the booking's id.
 */
export async function cancelSmokeBooking(
  post: SmokePost,
  token: string,
  sleep?: (ms: number) => Promise<void>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await withRetry(
      async () => {
        const r = await post(`/api/bookings/${token}/cancel`, { reason: "no_longer_interested" });
        if (r.status === 503) throw new RetryableStatus(r.status);
        return r;
      },
      {
        attempts: CANCEL_ATTEMPTS,
        retryable: (err) => err instanceof RetryableStatus || isTransientNetworkError(err),
        sleep,
      },
    );
    return res.status === 200 ? { ok: true } : { ok: false, reason: `got ${res.status}` };
  } catch (err) {
    return { ok: false, reason: thrownReason(err) };
  }
}

/** Why a create response is not this run's own new booking, or null when it is. */
function notCreatedReason(created: { status: number; body: Json }): string | null {
  const outcome = created.body.outcome;
  if (created.status === 200 && outcome === "created") return null;
  const booking = created.body.booking as Json | undefined;
  const parts = [`got ${created.status}`];
  if (typeof outcome === "string") parts.push(outcome);
  if (booking?.id) parts.push(`against booking ${String(booking.id)}`);
  return parts.join(" ");
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
    const refused = notCreatedReason(created);
    check(refused === null, `create -> 200 created (${refused ?? `got ${created.status}`})`);
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
      check(
        cancelled.ok,
        cancelled.ok
          ? "teardown: booking cancelled"
          : `teardown: booking ${bookingId || "(id unknown)"} left active, cancel it by hand (${cancelled.reason})`,
      );
    }
  }
  return "ran";
}
