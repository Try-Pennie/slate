/**
 * Resolving the advisor a booking is currently with (#1337, #1338).
 *
 * Read LIVE from the assignee, never a copy captured when the booking was made:
 * coverage reassignment (#1219) and the bulk reassign path both move a booking to
 * a different agent, so a stamped name would promise a lead one person and send
 * another.
 *
 * Every failure resolves to `null`, which the surfaces treat as "render no name".
 * That is the fail-safe direction: naming nobody is a visible absence, while
 * naming the wrong person looks exactly like success and is what L75 is about.
 * The client is injected so this is testable with a hand written fake rather than
 * module mocking.
 */

/**
 * Whether a lead may be told who their call is with (#4391). Never for a call on the
 * placeholder advisor (`staff_placed`): Marcia holds the time, and a real advisor from the
 * pool makes the call, so "Your loan advisor, Marcia" would promise the lead somebody who
 * never rings. The one rule for the confirmation, the moved call, the manage page and the
 * existing call notice, so no surface can name her while another does not.
 */
export function namesAdvisorToLead(booking: { kind?: string | null }): boolean {
  return booking.kind !== "staff_placed";
}

/** The narrow slice of the Supabase client this needs. */
export interface AdvisorNameReader {
  from(table: "users"): {
    select(cols: "name, is_placeholder"): {
      eq(
        col: "id",
        value: string,
      ): {
        maybeSingle(): Promise<{
          data: { name: string | null; is_placeholder?: boolean | null } | null;
          error: unknown;
        }>;
      };
    };
  };
}

/**
 * The agent's display name, or null when there is nothing usable to show:
 * no id, no row, a blank name, a read that failed, or (#4391) the placeholder
 * advisor, whom a lead is never told their call is with (`namesAdvisorToLead`, by
 * the assignee here, since a caller of this holds only the assignee's id).
 */
export async function resolveAdvisorName(
  db: AdvisorNameReader,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  try {
    // error-ok: naming the advisor is presentational, and a read error must drop
    // the name rather than substitute one. The `error` branch below is the whole
    // reason this is not an `unwrap`: an empty result here is SAFE (the surface
    // shows no name), it is never mistaken for an answer.
    const { data, error } = await db.from("users").select("name, is_placeholder").eq("id", userId).maybeSingle();
    if (error) return null;
    if (data?.is_placeholder === true) return null;
    const name = data?.name?.trim();
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}
