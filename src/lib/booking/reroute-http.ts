import { NextResponse } from "next/server";
import type { z } from "zod";
import { RerouteRefusedError, type RerouteRefusal } from "@/lib/booking/reroute";
import { VerifyUnavailableError } from "@/lib/booking/orchestration";
import { mapReassignError } from "@/lib/booking/reassign-http";

/**
 * How the reroute routes answer each refusal (#3249). One sentence per cause, so two
 * different problems never read alike (L11), and a `Record` over the whole
 * vocabulary, so a new word cannot ship without a message (`tsc` names the
 * omission, L113). Three pairs share a sentence on purpose because they are one
 * cause seen from two places: another org's booking reads as not found (so the
 * route never confirms it exists), a bucket outside the org reads as no bucket, and
 * the place and swap words for a bucket of another event type read the same.
 *
 * Status follows the reassign routes' classification: 404 bad input, 409 a genuine
 * conflict (retrying the same request changes nothing until something moves), 503
 * transient. The admin panel shows `error` as written.
 */
const REFUSAL: Record<RerouteRefusal, { status: number; error: string }> = {
  booking_not_found: { status: 404, error: "That booking could not be found." },
  unknown_bucket: { status: 400, error: "That is not a bucket Slate routes to." },
  no_current_advisor: { status: 409, error: "This booking has no advisor to keep, so its bucket cannot be corrected this way." },
  no_calendar_event: { status: 409, error: "This booking has no calendar event on its advisor's calendar, so its bucket cannot be corrected this way." },
  across_worlds: { status: 409, error: "A test booking can only move to a test bucket, and a real booking to a real one." },
  kept_off_ladder: { status: 400, error: "The bucket kept in must be the one asked for or one the search reaches below it." },
  current_on_time_off: { status: 409, error: "The advisor is on time off for this call, so they cannot keep it. Find an advisor again." },
  current_not_free: { status: 409, error: "The advisor is no longer free for this call, so they cannot keep it. Find an advisor again." },
  current_no_schedule: { status: 409, error: "The advisor has no schedule in Slate, so they cannot keep this call. Find an advisor again." },
  booking_inactive: { status: 409, error: "This booking is cancelled or completed, so it cannot be rerouted." },
  agent_link: { status: 409, error: "This lead booked a specific advisor by link, so there is no bucket to correct." },
  booking_started: { status: 409, error: "This call has already started, so it cannot be rerouted." },
  booking_moved: { status: 409, error: "The lead moved this call while it was being rerouted. Find an advisor again." },
  org_mismatch: { status: 404, error: "That booking could not be found." },
  agent_is_current: { status: 409, error: "That advisor already has this booking." },
  agent_not_in_org: { status: 409, error: "That advisor is not in this organization." },
  bucket_not_in_org: { status: 400, error: "That is not a bucket Slate routes to." },
  event_type_mismatch: { status: 409, error: "That bucket books a different kind of call, so this booking cannot move into it." },
  confirm_in_progress: { status: 409, error: "A reroute of this booking is already being confirmed. Wait a moment and reload." },
  agent_busy: { status: 409, error: "The advisor found was booked a moment ago. Find an advisor again." },
  agent_held: { status: 409, error: "The advisor found is being held for another bucket correction. Find an advisor again." },
  hold_not_found: { status: 409, error: "This hold is no longer active. Find an advisor again." },
  hold_consumed: { status: 409, error: "This reroute was already confirmed." },
  hold_expired: { status: 409, error: "The hold ran out. Find an advisor again." },
  hold_not_claimed: { status: 409, error: "This hold was not ready to confirm. Find an advisor again." },
  hold_mismatch: { status: 409, error: "This hold is for a different advisor or bucket. Find an advisor again." },
  bucket_mismatch: { status: 409, error: "That bucket books a different kind of call, so this booking cannot move into it." },
};

/** The status and sentence for a refusal word; exported for the copy test. */
export function rerouteRefusalResponse(code: RerouteRefusal): { status: number; error: string } {
  return REFUSAL[code];
}

/** Map a reroute failure to a response. Anything unrecognised falls to the reassign mapper. */
export async function mapRerouteError(err: unknown, context: string): Promise<NextResponse> {
  if (err instanceof RerouteRefusedError) {
    const { status, error } = REFUSAL[err.code];
    return NextResponse.json({ error, code: err.code }, { status });
  }
  // A calendar Slate could not read: nothing was decided, so the admin retries.
  if (err instanceof VerifyUnavailableError) {
    return NextResponse.json(
      { error: "Slate could not check the advisors' calendars just now. Please try again.", code: "VERIFY_UNAVAILABLE" },
      { status: 503 },
    );
  }
  return mapReassignError(err, context);
}

/**
 * Read and check a reroute route's JSON body: the parsed value, or the 400 to
 * answer. One place, so the reroute routes refuse a bad body the same way.
 */
export async function readRerouteBody<T extends z.ZodTypeAny>(
  req: { json(): Promise<unknown> },
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return { ok: false, response: NextResponse.json({ error: "Invalid request" }, { status: 400 }) };
  return { ok: true, data: parsed.data };
}
