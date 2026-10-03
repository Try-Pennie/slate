"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { formatWhenLine, normalizeTzLabel } from "@/lib/ooo/core";
import {
  CANCEL_ACT_WORDS,
  type CancelOutcomeKind,
} from "@/lib/ooo/cancel-copy";
import {
  roundDownToQuarterHour,
  roundUpToQuarterHour,
} from "@/lib/date/parse";
import { cancelOoo, modifyOoo, submitOoo } from "@/lib/ooo/service";
import type { SubmitOooInput } from "@/lib/ooo/service";
import type { OooRequest } from "@/lib/db/types";
import { MISSING_TIMEZONE_TIME_OFF, submittedTimezone } from "@/lib/submitted-timezone";

/**
 * Agent self-service time off actions. Void server actions have no return
 * channel, so outcomes travel back as /me/time-off?ooo=<ok message>&ooo_error=<error>
 * and the page renders the banner.
 */

/**
 * `cancelled` and `withdrawn` are not two spellings of one outcome: they are the
 * two acts the request row's destructive control performs, and they come from
 * the one vocabulary in `@/lib/ooo/cancel-copy` so the banner cannot name an act
 * the action did not perform.
 */
type Outcome = "sent" | "changed" | CancelOutcomeKind;

function done(message: string, kind: Outcome = "sent"): never {
  revalidatePath("/me/time-off");
  // The nonce makes every success URL unique so the form (keyed on it) remounts
  // and clears its fields, even on back-to-back submits with the same message.
  // `kind` lets the banner pick the right header/icon (a cancel isn't a "sent").
  redirect(
    `/me/time-off?ooo=${encodeURIComponent(message)}&ooo_kind=${kind}&t=${Date.now()}`,
  );
}

function failed(error: string): never {
  redirect(`/me/time-off?ooo_error=${encodeURIComponent(error)}`);
}

/** Just the request fields the confirmation copy reads. */
type ConfirmRequest = Pick<
  OooRequest,
  "starts_at" | "ends_at" | "display_tz_id" | "display_tz_label" | "manager_id"
>;

/**
 * Warm confirmation copy that names the dates back (the Pennie DS's one
 * specific confirmation moment), e.g. "Tue, Oct 7 2025 from 4:00pm - 6:00pm ET.
 * Bobby will confirm." The manager's first name is resolved from the request's
 * manager snapshot; it falls back to "Your manager" if the name isn't on file.
 */
async function confirmationMessage(
  lead: "You're set for" | "Updated to",
  request: ConfirmRequest,
): Promise<string> {
  const whenLine = formatWhenLine(
    request.starts_at,
    request.ends_at,
    request.display_tz_id,
    request.display_tz_label,
  );
  let who = "Your manager";
  if (request.manager_id) {
    // error-ok: empty degrades to the documented default. `who` is already the
    // no-name fallback this read only ever narrows, the request is committed
    // before this copy is built, and nothing acts on the sentence: a failed read
    // renders "Your manager will confirm", which is exactly what a manager row
    // holding no name renders and is true either way.
    const { data } = await supabaseAdmin()
      .from("users")
      .select("name")
      .eq("id", request.manager_id)
      .maybeSingle();
    const first = (data as { name: string | null } | null)?.name
      ?.trim()
      .split(/\s+/)[0];
    if (first) who = first;
  }
  return `${lead} ${whenLine}. ${who} will confirm.`;
}

/** Builds the UTC window + display tz from the form's local date/time fields. */
function windowFrom(form: FormData): SubmitOooInput | { error: string } {
  // #1989: no zone is refused, never read as Eastern, which would move the whole
  // window by the agent's offset and still report the request as sent.
  const tz = submittedTimezone(form);
  if (!tz) return { error: MISSING_TIMEZONE_TIME_OFF };
  const allDay = form.get("all_day") === "on";
  const startDate = String(form.get("start_date") ?? "");
  const endDate = String(form.get("end_date") ?? "");
  if (!startDate || !endDate) {
    return { error: "Pick a start and end date for your time off." };
  }
  // Times snap to a quarter hour (matches the pickers; safety net if a client
  // value slips through off-grid). Start rounds down, end rounds up so the
  // window never shrinks. All-day uses the full day as-is.
  const startTime = allDay
    ? "00:00"
    : roundDownToQuarterHour(String(form.get("start_time") ?? ""));
  const endTime = allDay
    ? "23:59"
    : roundUpToQuarterHour(String(form.get("end_time") ?? ""));
  if (!startTime || !endTime) {
    return { error: "Pick start and end times, or choose all day." };
  }
  const start = DateTime.fromISO(`${startDate}T${startTime}`, { zone: tz });
  const end = DateTime.fromISO(`${endDate}T${endTime}`, { zone: tz });
  if (!start.isValid || !end.isValid) {
    return { error: "Those dates could not be read. Please pick them again." };
  }
  return {
    startIso: start.toUTC().toISO()!,
    endIso: end.toUTC().toISO()!,
    displayTzId: tz,
    displayTzLabel: normalizeTzLabel(tz),
    allDay,
    reason: String(form.get("reason") ?? ""),
    notes: String(form.get("notes") ?? "") || undefined,
  };
}

/**
 * Form state for the useActionState-driven OOO form. On a validation/business
 * error we RETURN the message (no redirect) so the page stays put, the typed
 * values survive, and the error renders inline as a styled banner instead of
 * the browser's native tooltip. Success still redirects (which clears the form
 * and shows the success banner).
 */
export type OooFormState = {
  error: string | null;
  /** Set on the overlap error so the banner can link to the clashing request. */
  conflictRequestId?: string | null;
};

export async function submitMyOoo(
  _prev: OooFormState,
  form: FormData,
): Promise<OooFormState> {
  const me = await currentUser();
  if (!me) redirect("/login");
  const input = windowFrom(form);
  if ("error" in input) return { error: input.error };
  const result = await submitOoo(me, input);
  if (!result.ok) {
    return { error: result.error, conflictRequestId: result.conflictRequestId };
  }
  done(await confirmationMessage("You're set for", result.request));
}

export async function modifyMyOoo(
  _prev: OooFormState,
  form: FormData,
): Promise<OooFormState> {
  const me = await currentUser();
  if (!me) redirect("/login");
  const requestId = String(form.get("request_id") ?? "");
  if (!requestId) return { error: "That request could not be found." };
  const input = windowFrom(form);
  if ("error" in input) return { error: input.error };
  const result = await modifyOoo(requestId, me, input);
  if (!result.ok) {
    return { error: result.error, conflictRequestId: result.conflictRequestId };
  }
  done(await confirmationMessage("Updated to", result.request), "changed");
}

export async function cancelMyOoo(form: FormData): Promise<void> {
  const me = await currentUser();
  if (!me) redirect("/login");
  const requestId = String(form.get("request_id") ?? "");
  if (!requestId) failed("That request could not be found.");
  const result = await cancelOoo(requestId, me);
  if (!result.ok) failed(result.error);
  // #2406: the banner names the act that just happened, taken from what the call
  // DID and not from the row it left behind, which reads `cancelled` whether the
  // agent withdrew a pending request or cancelled an approved one (L680).
  const words = CANCEL_ACT_WORDS[result.act];
  done(words.outcomeMessage, words.outcomeKind);
}
