// The two rules that keep a smoke run on ITS OWN booking (#4060), shared by every
// smoke script that books and then tears down (smoke-reschedule, smoke-523-stickiness,
// smoke-create-resume), so a new one cannot carry the old copy.
//
// 2026-10-21 (runs 39694932888 and 39698605820): a run lost the network after 4
// passing checks, its teardown cancel never landed, and its booking stayed active. The
// next run's create was answered `409 confirm_required` carrying that OLD booking, and
// the script took the old booking's manage token from the answer and rescheduled and
// cancelled it as its own, reporting ok.
//
//  1. `createRefusal`: a create is this run's only when it answers 200 `created`. A
//     409 `confirm_required` carries ANOTHER booking (the one dedupe matched), and a 200
//     `rescheduled` or `deduped` is an existing booking moved or returned. Taking a
//     token from either acts on a booking this run never made.
//  2. `cancelSmokeBooking`: the teardown cancel retries what a retry can fix (a
//     transient network error, or a 503 when the gated write did not run). Cancel is
//     safe to repeat: a booking already cancelled answers 200. It never throws, because
//     a teardown that throws replaces the error the run crashed on.
//     `teardownCheckMessage` then names the booking when it was left active, so the
//     failure log, and the alert built from it, say which booking to cancel by hand.
import { shortErrorReason } from "@/lib/notify/error-text";
import { isTransientNetworkError, withRetry, type Json } from "../smoke-lib.ts";

export type SmokePost = (
  path: string,
  body: Json,
  auth?: boolean,
) => Promise<{ status: number; body: Json }>;

/** Why a create response is not this run's own new booking, or null when it is. */
export function createRefusal(created: { status: number; body: Json }): string | null {
  const outcome = created.body.outcome;
  if (created.status === 200 && outcome === "created") return null;
  const booking = created.body.booking as Json | undefined;
  const parts = [`got ${created.status}`];
  if (typeof outcome === "string") parts.push(outcome);
  if (booking?.id) parts.push(`against booking ${String(booking.id)}`);
  return parts.join(" ");
}

/** The create check's line, carrying the refusal and the server's error when refused. */
export function createCheckMessage(created: { status: number; body: Json }, refused: string | null): string {
  const err = refused !== null && created.body.error ? ` err=${String(created.body.error)}` : "";
  return `create -> 200 created (${refused ?? `got ${created.status}`}${err})`;
}

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

export type CancelResult = { ok: true } | { ok: false; reason: string };

/** Cancel a smoke booking by its manage token, retrying what a retry can fix. */
export async function cancelSmokeBooking(
  post: SmokePost,
  token: string,
  sleep?: (ms: number) => Promise<void>,
): Promise<CancelResult> {
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

/** The teardown check's line: plain on success, naming the booking when it stayed. */
export function teardownCheckMessage(bookingId: string, result: CancelResult): string {
  return result.ok
    ? "teardown: booking cancelled"
    : `teardown: booking ${bookingId || "(id unknown)"} left active, cancel it by hand (${result.reason})`;
}
