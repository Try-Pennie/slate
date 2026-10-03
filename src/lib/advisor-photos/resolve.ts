/**
 * The one judge of which picture a person gets (#3027).
 *
 * Every surface that draws an advisor's face (the lead's manage page, the
 * roster, the agent page, the account menu in both layouts) asks THIS, so they
 * cannot disagree about whether somebody has a photo. It returns one
 * discriminated value rather than a URL and a flag beside it (L544), because
 * the four states mean different things to a reader:
 *
 *   photo        the directory photo Slate holds, served from Slate's own origin
 *   none         the directory was READ and holds no photo: draw initials
 *   never-read   the daily run has not reached this person yet, so the photo
 *                Google gave Slate at sign in (if any) is drawn until it does
 *   unreadable   Slate could not read its own photo table, so the same stand in
 *                is used and the page says the photos could not be read
 *
 * The directory photo wins over the sign in photo, and a MEASURED "none" hides a
 * stored sign in photo (Dan, 2026-10-02). That deliberately reverses #2600's
 * rule that only a photo may overwrite a photo: the sign in photo can itself be
 * Google's letter placeholder, which is what one advisor's was when measured.
 *
 * Pure: the readers live in `store.ts`.
 */

/** What `advisor_photos` holds for one person, without the image. */
export interface PhotoRecord {
  state: "photo" | "none";
  sha256: string | null;
}

export type AdvisorPhoto =
  | { kind: "photo"; src: string }
  | { kind: "none" }
  | { kind: "never-read"; src: string | null }
  | { kind: "unreadable"; src: string | null };

/** The public, content addressed route a stored photo is served from. */
export function advisorPhotoPath(sha256: string): string {
  return `/advisor-photo/${sha256}`;
}

/**
 * The photo Google gave at sign in (`users.avatar_url`), or null. Blank is no
 * photo, the same as null: drawing it would be a broken image.
 */
function signInPhoto(avatarUrl: string | null | undefined): string | null {
  const url = avatarUrl?.trim();
  return url ? url : null;
}

/**
 * Resolve one person's picture.
 *
 * `records` is the result of reading `advisor_photos` for the people on the
 * page, or null when that read FAILED. A person absent from a successful read
 * has never been read.
 */
export function resolveAdvisorPhoto(
  person: { id: string; avatar_url: string | null },
  records: Map<string, PhotoRecord> | null,
): AdvisorPhoto {
  const fallback = signInPhoto(person.avatar_url);
  if (records === null) return { kind: "unreadable", src: fallback };
  const record = records.get(person.id);
  if (!record) return { kind: "never-read", src: fallback };
  if (record.state === "photo" && record.sha256) return { kind: "photo", src: advisorPhotoPath(record.sha256) };
  return { kind: "none" };
}

/**
 * Whether the photo refresh covers this person (#3161): the ONE definition of who
 * gets a photo read from Google. The refresh's target list and every surface that
 * says somebody has not been read yet ask this, so the sentence can never name a
 * gap the refresh was built never to close (L16, L342).
 *
 * Active people only. Most deactivated people have left and the directory no
 * longer holds them, so reading them would only report them missing.
 */
export function photoRefreshCovers(person: { deactivated_at: string | null }): boolean {
  return person.deactivated_at == null;
}

/**
 * Whether this person is waiting for the refresh to reach them: no record yet,
 * and somebody the refresh covers. A deactivated person with no record is not
 * waiting for anything, so their sign in photo is drawn with nothing said (Dan,
 * 2026-10-03). The only judge of `never-read` outside this file, which
 * scripts/test-advisor-photo-reads.ts enforces.
 */
export function awaitingFirstRead(photo: AdvisorPhoto, person: { deactivated_at: string | null }): boolean {
  return photo.kind === "never-read" && photoRefreshCovers(person);
}

/** The address to draw, or null for the initials. */
export function photoSrc(photo: AdvisorPhoto): string | null {
  return photo.kind === "none" ? null : photo.src;
}

/**
 * Whether this person needs a photo added in Google. Keyed on the MEASURED
 * "none" only: a person the run has not reached, or a table Slate could not
 * read, is not evidence that anybody is missing a photo.
 */
export function needsPhoto(photo: AdvisorPhoto): boolean {
  return photo.kind === "none";
}
