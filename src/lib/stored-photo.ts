/**
 * The photo a user row holds, or null when it holds none (#2837).
 *
 * `users.avatar_url` is written at Google sign in (`provision.ts`) and by the
 * Workspace directory backfill (#2600). An empty or blank value is no photo, the
 * same as null: drawing it would be a broken image, and counting it as a photo
 * would hide the person from the roster's "needs a photo" marker.
 *
 * One judge, so the lead's manage page, the roster's picture and the roster's
 * marker cannot disagree about whether somebody has a photo.
 */
export function storedPhotoUrl(avatarUrl: string | null | undefined): string | null {
  const url = avatarUrl?.trim();
  return url ? url : null;
}
