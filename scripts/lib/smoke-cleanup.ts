// The booking canary's cleanup (scripts/smoke-booking-api.ts), with its calls
// injected so its failure paths are node-testable (scripts/test-smoke-cleanup.ts).
//
// Two passes, as before (#396): cancel every manage token this run tracked, then
// sweep every identity (external id) it booked under, deleting any booking still
// active there. The sweep can only reach this run's own bookings, because lookup is
// keyed on the external id, which is unique per run (#3581).
//
// What #4060 changed:
//
//  1. A token is tracked only from a 200 `created` answer (createRefusal). A
//     `409 confirm_required` hands back ANOTHER booking, the one person dedupe matched,
//     and the old trackForCleanup took its token from any answer, so cleanup cancelled
//     a booking this run never made. A booking this run made by moving its own (a cross
//     bucket rebook) is reached by the identity sweep instead.
//  2. Nothing is swallowed. Each pass used `.catch(() => {})`, so a run that lost the
//     network left its bookings active and named none of them. Now a booking still
//     active after both passes is a failed check naming its id (teardownCheckMessage),
//     and an identity whose sweep read failed is a failed check naming the identity,
//     since nothing can then prove its bookings are gone. Each booking is named once:
//     a token cancel that failed is forgiven when the sweep deletes the booking, or
//     when every sweep read succeeded and none listed it (lookup lists active only).
import {
  cancelSmokeBooking,
  createRefusal,
  teardownCheckMessage,
  thrownReason,
  type SmokePost,
} from "./smoke-own-booking.ts";
import { tokenFrom, type Json } from "../smoke-lib.ts";

export interface SmokeCleanupDeps {
  post: SmokePost;
  /** GET /api/bookings?externalId=: the identity's ACTIVE bookings. */
  list: (externalId: string) => Promise<{ status: number; body: { bookings?: { id: string }[] } }>;
  /** DELETE /api/bookings?externalId=&bookingId=: 200 cancelled, 404 already gone. */
  remove: (externalId: string, bookingId: string) => Promise<{ status: number; body: Json }>;
  check: (cond: boolean, msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function createSmokeCleanup(deps: SmokeCleanupDeps) {
  /** booking id (or the token, when an answer carried no id) -> manage token. */
  const tokens = new Map<string, string>();
  const identities = new Set<string>();

  return {
    /** Record an identity this run booked under, whatever came back. */
    trackIdentity(externalId: string): void {
      identities.add(externalId);
    },

    /** Track a create answer's manage token, only when it is this run's new booking. */
    track(res: { status: number; body: Json }): boolean {
      if (createRefusal(res) !== null) return false;
      const booking = res.body.booking as Json | undefined;
      const token = tokenFrom(booking?.manageUrl);
      if (!token) return false;
      tokens.set(String(booking?.id ?? "") || token, token);
      return true;
    },

    async run(): Promise<void> {
      const left = new Map<string, string>();
      for (const [id, token] of tokens) {
        const r = await cancelSmokeBooking(deps.post, token, deps.sleep);
        if (!r.ok) left.set(id, r.reason);
      }
      tokens.clear();

      let everyIdentityRead = true;
      const listedActive = new Set<string>();
      for (const externalId of identities) {
        let listed: Awaited<ReturnType<SmokeCleanupDeps["list"]>>;
        try {
          listed = await deps.list(externalId);
        } catch (err) {
          everyIdentityRead = false;
          deps.check(false, `teardown: could not list bookings under ${externalId} to sweep (${thrownReason(err)})`);
          continue;
        }
        if (listed.status !== 200) {
          everyIdentityRead = false;
          deps.check(false, `teardown: could not list bookings under ${externalId} to sweep (got ${listed.status})`);
          continue;
        }
        for (const b of listed.body.bookings ?? []) {
          if (!b.id) continue;
          listedActive.add(b.id);
          try {
            const del = await deps.remove(externalId, b.id);
            if (del.status === 200 || del.status === 404) left.delete(b.id);
            else left.set(b.id, `got ${del.status}`);
          } catch (err) {
            left.set(b.id, thrownReason(err));
          }
        }
      }
      identities.clear();

      for (const [id, reason] of left) {
        // Every read succeeded and none listed it: it is no longer active.
        if (everyIdentityRead && !listedActive.has(id)) continue;
        deps.check(false, teardownCheckMessage(id, { ok: false, reason }));
      }
    },
  };
}
