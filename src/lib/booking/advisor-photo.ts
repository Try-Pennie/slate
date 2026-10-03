/**
 * The advisor's photo for the manage page (#2600, #3027).
 *
 * The sibling of `advisor-name.ts` and deliberately the same shape: read LIVE
 * from the assignee rather than stamped on the booking, because a booking can be
 * reassigned and a stamped photo would show a lead the face of somebody who is
 * no longer taking their call.
 *
 * Which picture is decided by the one resolver every surface uses
 * (`resolveAdvisorPhoto`), so the lead's page and the roster cannot disagree.
 * The directory photo is served from Slate's own origin, which is also what the
 * content security policy's `img-src 'self'` allows.
 *
 * Every failure resolves to `null`, the initials circle, because this runs inside
 * a lead-facing render: anything that escapes is a page that does not draw. The
 * one exception is the photo table alone failing, which keeps the sign in photo
 * as the resolver's `unreadable` state rather than dropping a face that is there.
 */
import { photoSrc, resolveAdvisorPhoto, type PhotoRecord } from "../advisor-photos/resolve.ts";

/** The two reads, injected so this can be driven with hand written fakes. */
export interface AdvisorPhotoReads {
  /** The assignee's id and sign in photo, or null when there is no such user. */
  readUser(userId: string): Promise<{ id: string; avatar_url: string | null } | null>;
  /** Their `advisor_photos` state; throws when the table cannot be read. */
  readRecords(userIds: string[]): Promise<Map<string, PhotoRecord>>;
}

export async function resolveBookingAdvisorPhoto(
  reads: AdvisorPhotoReads,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const [user, records] = await Promise.all([
    // swallow-ok: a failed user read draws the initials, a designed state on a
    // lead-facing page; nothing downstream reads the absence as a fact.
    reads.readUser(userId).catch(() => undefined),
    // swallow-ok: null is the resolver's explicit unreadable state, never "no photo".
    reads.readRecords([userId]).catch(() => null),
  ]);
  // No user, or a user read that failed: no face is better than a wrong one.
  if (!user) return null;
  return photoSrc(resolveAdvisorPhoto(user, records));
}
