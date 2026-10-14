/**
 * The texting line a lead can message after pressing Call me now (#3718), for the
 * card's Text us option.
 *
 * Asked of Pennie's automations service at `/get-phone-line`, exactly as
 * trypennie.com asks it on its own Call me now page (its
 * `InternalAutomationsService.getPhoneLine`): a POST carrying the lead's phone as
 * digits and the submission id when there is one, answered with
 * `{ success, phoneNumber, usageCount }`.
 *
 * FAILS CLOSED (Dan, 2026-10-14): with no service address configured
 * (`AUTOMATIONS_API_URL` unset) nothing is asked and the answer is null, so the card
 * shows no Text us and no error until the address is set. Every other way of not
 * getting a usable number (a refusal, an unexpected body, a number that does not
 * parse, no answer within the deadline) is null too, reported through `onUnread` so
 * the logs say why. A wrong number is worse than none (L75), so only a number
 * libphonenumber calls valid is returned.
 *
 * It is NOT the calling number (`lead-calling-number.ts`), which is the line Pennie
 * calls from and must never be offered as a text target.
 *
 * Pure apart from the injected fetch and timer, so `scripts/test-texting-line.ts`
 * drives every outcome without the service and without waiting (L524).
 */
import { callingNumberOf } from "../salesforce/lead-calling-number.ts";
import { readWithinDeadline, realTimer, type ScheduleTimer } from "../read-within-deadline.ts";

/** How long the confirmation waits for the line before going on without it. */
export const TEXTING_LINE_DEADLINE_MS = 2_500;

export interface TextingLineDeps {
  /** The service's address; blank means not configured, and nothing is asked. */
  baseUrl: string;
  fetchImpl: typeof fetch;
  timer?: ScheduleTimer;
  onUnread: (err: unknown) => void;
}

export async function readTextingLine(
  lead: { phone: string | null; submissionId: string | null },
  deps: TextingLineDeps,
): Promise<string | null> {
  const base = deps.baseUrl.trim().replace(/\/+$/, "");
  // The ten digits trypennie sends: a stored +1 number loses its country code.
  const digits = (lead.phone ?? "").replace(/\D/g, "");
  const phone = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (base === "" || phone === "") return null;
  const body: Record<string, string> = { phone };
  if (lead.submissionId) body.submission_id = lead.submissionId;
  // Called bare: Cloudflare's fetch throws "Illegal invocation" when called as a
  // method of another object, which `deps.fetchImpl(...)` would be.
  const doFetch = deps.fetchImpl;
  return readWithinDeadline(
    async () => {
      const res = await doFetch(`${base}/get-phone-line`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`get-phone-line answered ${res.status}`);
      const data = (await res.json()) as { success?: unknown; phoneNumber?: unknown };
      if (data.success !== true) throw new Error("get-phone-line answered without success");
      const line = callingNumberOf(data.phoneNumber);
      if (line === null) throw new Error("get-phone-line answered no valid phone number");
      return line;
    },
    TEXTING_LINE_DEADLINE_MS,
    deps.onUnread,
    deps.timer ?? realTimer,
  );
}
