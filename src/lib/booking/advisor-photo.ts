/**
 * The advisor's photo for the manage page (#2600).
 *
 * The sibling of `advisor-name.ts` and deliberately the same shape: read LIVE
 * from the assignee rather than stamped on the booking, because a booking can be
 * reassigned and a stamped photo would show a lead the face of somebody who is
 * no longer taking their call. Every failure resolves to `null`, and the reader
 * is injected so it can be driven with a hand written fake.
 *
 * It reads the stored column rather than asking Google at render. `avatar_url`
 * is written at login, and #2600's backfill filled it for the agents who had
 * never signed in, so by the time this runs the answer is already in the row.
 * Going to the directory here would be a network call on a lead-facing render
 * for a value that does not change, and it would not have helped the page Dan
 * actually asked about: the admin roster lists 132 people, and that is 132 calls
 * a page. One column serves both.
 */

/** The narrow slice of the Supabase client this needs. */
export interface AdvisorPhotoReader {
  from(table: "users"): {
    select(cols: "avatar_url"): {
      eq(
        col: "id",
        value: string,
      ): {
        maybeSingle(): Promise<{
          data: { avatar_url: string | null } | null;
          error: unknown;
        }>;
      };
    };
  };
}

/**
 * The advisor's photo, or null when there is nothing to show: no id, no row, no
 * photo on file, or a read that failed. Every one of those draws the initials
 * circle, which is a correct picture rather than an empty frame, so none of them
 * is worth telling a lead apart from another.
 */
export async function resolveAdvisorPhoto(
  db: AdvisorPhotoReader,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  try {
    // error-ok: the photo is presentational and its absence is a designed state,
    // so a read error drops to the initials circle. Nothing downstream acts on
    // the empty value, so it can never be mistaken for a fact about the agent.
    const { data, error } = await db
      .from("users")
      .select("avatar_url")
      .eq("id", userId)
      .maybeSingle();
    if (error) return null;
    const url = data?.avatar_url?.trim();
    return url && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}
