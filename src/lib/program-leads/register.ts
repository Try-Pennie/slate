/**
 * Registering a program lead (#4388, part of #4255): Bidspoke names an accepted lead's
 * Salesforce Lead id, and for 30 days from its latest registration that lead's texted
 * booking link is recognised as a program lead's. The mark lives in `program_leads`
 * (migration 0213), keyed by `leadIdKey`, and the database function
 * `register_program_lead` makes a re-register extend it, never shorten it.
 *
 * Who may call: Bidspoke's own key, checked by `POST /api/program-leads`. What it
 * touches: `program_leads`, through that one function, and nothing else.
 */
import { idCaseChecksumMatches, isLeadId, leadIdKey } from "@/lib/salesforce/lead-xbc";
import type { supabaseAdmin } from "@/lib/supabase/admin";

/** Who registers, recorded on the row as `registered_by`. */
export const PROGRAM_LEAD_CALLER = "bidspoke";

/** Why a body was refused, each its own code because each is fixed differently. */
export type ProgramLeadIdRefusal = "VALIDATION" | "NOT_A_LEAD_ID" | "LEAD_ID_CASE_MISMATCH";

export type ProgramLeadIdRead =
  | { ok: true; leadKey: string }
  | { ok: false; code: ProgramLeadIdRefusal; error: string };

/**
 * Read `{ salesforceLeadId }` from a parsed body (null for one that was not JSON). A
 * Lead id is the `00Q` key prefix and 15 or 18 characters; an 18 character one must
 * agree with its own case checksum, or the 15 character key taken from it would name a
 * different record than the one Bidspoke meant.
 */
export function readProgramLeadId(body: unknown): ProgramLeadIdRead {
  const raw =
    body !== null && typeof body === "object" ? (body as { salesforceLeadId?: unknown }).salesforceLeadId : undefined;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    return { ok: false, code: "VALIDATION", error: "salesforceLeadId is required, as a string" };
  }
  if (!isLeadId(id)) {
    return {
      ok: false,
      code: "NOT_A_LEAD_ID",
      error: "salesforceLeadId is not a Salesforce Lead id: it must start 00Q and be 15 or 18 letters and digits",
    };
  }
  if (!idCaseChecksumMatches(id)) {
    return {
      ok: false,
      code: "LEAD_ID_CASE_MISMATCH",
      error:
        "salesforceLeadId's last three characters do not match the case of the first fifteen, so its letters' case was changed somewhere; send the id exactly as Salesforce gives it",
    };
  }
  return { ok: true, leadKey: leadIdKey(id) };
}

/** The store did not record the registration; the caller should retry. */
export class ProgramLeadStoreError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`program lead not registered: ${detail}`, options);
    this.name = "ProgramLeadStoreError";
  }
}

/**
 * Register (or extend) a lead's mark and return when it lapses. Throws
 * `ProgramLeadStoreError` on any failure, a missing answer included: a registration the
 * store did not confirm is never reported as made.
 */
export async function registerProgramLead(
  db: ReturnType<typeof supabaseAdmin>,
  leadKey: string,
): Promise<string> {
  let result: { data: unknown; error: { message: string } | null };
  try {
    result = await db.rpc("register_program_lead", { p_lead_key: leadKey, p_caller: PROGRAM_LEAD_CALLER });
  } catch (err) {
    throw new ProgramLeadStoreError("the register call failed", { cause: err });
  }
  if (result.error) throw new ProgramLeadStoreError(result.error.message);
  if (typeof result.data !== "string" || result.data === "") {
    throw new ProgramLeadStoreError("the register call returned no lapse time");
  }
  return result.data;
}
