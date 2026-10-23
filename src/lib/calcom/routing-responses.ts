/**
 * Reading every cal.com routing form response over a range (#2484, #1956).
 *
 * In `src` since #2893, because the monitor lane's daily refit reads it too, to count
 * cal.com's bookings per tier beside Slate's. No `@/` imports, so the measure
 * commands still import it directly.
 *
 * One reader for the two commands that measure real traffic from cal.com
 * (`measure:lead-hours` and `measure:volume-floors`), so "what counts as the
 * traffic cal.com saw" is decided once. Two copies of a paging loop drift in the
 * worst direction: one of them stops refusing a partial read.
 *
 * A partial read is REFUSED rather than returned. Every count built on top of it
 * would otherwise be a measurement of whichever forms happened to answer (L98),
 * and a floor fitted to part of the traffic is one the whole traffic clears
 * easily, which is an alarm that never fires.
 *
 * The response BODY is reduced here to the one thing either command needs from
 * it, the lead's code, so the lead's own answers (their name, email and phone)
 * never leave this function.
 */

import { parseStampMs } from "../date/stamp.ts";
import { tierOfBucketCode } from "../monitor/volume-tiers.ts";

export interface RoutingResponse {
  /** cal.com's id for the response, as text, when it carried one (#3124). A paged read
   *  sorted newest first can return a response twice when a new one arrives between
   *  pages, so a per minute count dedupes on this. */
  id?: string;
  /** The form (landing page) the lead filled in. */
  formName: string;
  /** When the response was recorded, as cal.com wrote it. */
  createdAt: string;
  /** The code the lead carried, or null when it carried none. */
  code: string | null;
  /** True when the response went on to a booking (cal.com's `routedToBookingUid`). */
  booked: boolean;
}

export type RoutingReadResult =
  | { ok: true; rows: RoutingResponse[]; formCount: number }
  | { ok: false; reason: "forms-unreadable" | "responses-unreadable"; status: number; formName?: string };

/**
 * The cal.com API version every routing response read asks for, owned here rather than
 * by each caller: the volume measurements were read at it, and a caller asking at
 * another (or at none) could count the same traffic differently (L728, #2893).
 */
export const ROUTING_API_VERSION = "2024-06-14";

/** One GET against cal.com, sent with the `cal-api-version` header the reader names. */
type Getter = (path: string, apiVersion: string) => Promise<{ status: number; json: unknown }>;

interface RawForm {
  id: string;
  name: string;
}
interface RawResponse {
  id?: unknown;
  response: unknown;
  createdAt: string;
  routedToBookingUid?: string | null;
}

/**
 * Every response created at or after `fromIso`, across every routing form in the org.
 * `sleep` is injected so a test crossing the pacing does not wait for real (L524).
 */
export async function readRoutingResponses(opts: {
  get: Getter;
  org: string;
  fromIso: string;
  paceMs: number;
  sleep: (ms: number) => Promise<void>;
  pageSize?: number;
}): Promise<RoutingReadResult> {
  const page = opts.pageSize ?? 250;
  const formsRes = await opts.get(`/organizations/${opts.org}/routing-forms`, ROUTING_API_VERSION);
  const forms = (formsRes.json as { data?: RawForm[] } | null)?.data;
  if (formsRes.status !== 200 || !Array.isArray(forms) || forms.length === 0) {
    return { ok: false, reason: "forms-unreadable", status: formsRes.status };
  }
  const rows: RoutingResponse[] = [];
  for (const form of forms) {
    for (let skip = 0; ; skip += page) {
      const res = await opts.get(
        `/organizations/${opts.org}/routing-forms/${form.id}/responses` +
          `?take=${page}&skip=${skip}&sortCreatedAt=desc&afterCreatedAt=${encodeURIComponent(opts.fromIso)}`,
        ROUTING_API_VERSION,
      );
      const data = (res.json as { data?: RawResponse[] } | null)?.data;
      if (res.status !== 200 || !Array.isArray(data)) {
        return { ok: false, reason: "responses-unreadable", status: res.status, formName: form.name };
      }
      for (const r of data) {
        rows.push({
          ...(typeof r.id === "number" || typeof r.id === "string" ? { id: String(r.id) } : {}),
          formName: form.name,
          createdAt: r.createdAt,
          code: extractCode(r.response),
          booked: typeof r.routedToBookingUid === "string" && r.routedToBookingUid.length > 0,
        });
      }
      if (data.length < page) break;
      if (opts.paceMs > 0) await opts.sleep(opts.paceMs);
    }
  }
  return { ok: true, rows, formCount: forms.length };
}


/**
 * The xbc a routing form response carried, as text, or `null` when the form has no
 * such field.
 *
 * `null` and `""` are deliberately different: a form with no xbc field never asked,
 * and a blank one asked and got nothing. Both end at the catch-all, and both are
 * reported as `catchall-absent`, but the extraction keeps them apart so the count
 * of forms that do not carry a code at all is knowable.
 *
 * cal.com stores the value as a NUMBER when it looks like one, measured live on
 * 2026-09-11: `{"label":"xbc","value":22}`. So the digits are recovered with
 * `String`, and a two digit value stays two digits and is refused downstream,
 * exactly as it is by the live booker.
 */
export function extractCode(response: unknown): string | null {
  if (response === null || typeof response !== "object") return null;
  for (const field of Object.values(response as Record<string, unknown>)) {
    if (field === null || typeof field !== "object") continue;
    const { label, value } = field as { label?: unknown; value?: unknown };
    if (typeof label !== "string" || label.trim().toLowerCase() !== "xbc") continue;
    if (typeof value === "number") return String(value);
    if (typeof value === "string") return value;
    return "";
  }
  return null;
}

/**
 * The debt tier digit of a code ("1" is Low), or null for anything that is not a
 * whole XBC code.
 *
 * Read WHOLE, through the same reader Slate's own bookings are tiered by (#3671,
 * L1023). The code is text from outside Slate, and reading it by its first digit
 * counted `22`, `1320` or `1abc` as a tier with full confidence, while the live
 * booker refuses every one of them and the comparison this feeds tiers Slate's side
 * strictly, so the two sides counted different things.
 */
export function tierOf(code: string | null): string | null {
  return tierOfBucketCode(code);
}

type Tier = "1" | "2" | "3" | "4" | "5";

/**
 * cal.com's bookings per debt tier among responses created in [fromMs, toMs) (#2893):
 * a response that went on to a booking, filed under its lead's code, exactly as the
 * volume measurements count them, so a share read against a measurement counts the
 * same thing on both sides. A response carrying no usable code belongs to no tier,
 * as it does in the measurements. An unreadable stamp THROWS rather than being
 * dropped, since a response left out is a booking cal.com took that the share never
 * sees, and the share would lean toward Slate.
 */
export function bookedByTier(rows: readonly RoutingResponse[], fromMs: number, toMs: number): Record<Tier, number> {
  const out: Record<Tier, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const r of rows) {
    const at = parseStampMs(r.createdAt);
    if (at === null) throw new Error("cal.com routing responses: a response carried a creation time that is not a time");
    if (!r.booked || at < fromMs || at >= toMs) continue;
    const tier = tierOf(r.code);
    if (tier !== null && tier in out) out[tier as Tier] += 1;
  }
  return out;
}
