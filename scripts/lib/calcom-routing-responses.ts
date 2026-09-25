/**
 * Reading every cal.com routing form response over a range (#2484, #1956).
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
import { extractCode } from "./router-replay.ts";

export interface RoutingResponse {
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

type Getter = (path: string) => Promise<{ status: number; json: unknown }>;

interface RawForm {
  id: string;
  name: string;
}
interface RawResponse {
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
  const formsRes = await opts.get(`/organizations/${opts.org}/routing-forms`);
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
      );
      const data = (res.json as { data?: RawResponse[] } | null)?.data;
      if (res.status !== 200 || !Array.isArray(data)) {
        return { ok: false, reason: "responses-unreadable", status: res.status, formName: form.name };
      }
      for (const r of data) {
        rows.push({
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

/** The debt tier digit of a code ("1" is Low), or null for anything unreadable. */
/**
 * The pause between cal.com pages, read from MEASURE_PACE_MS, or null when it
 * cannot be read. Unguarded, a typo becomes NaN, which a timer reads as no wait at
 * all, and the run meets cal.com's rate limit on every page instead of refusing
 * (L50). One reader for both commands that page through this module.
 */
export function paceMsOrNull(raw: string): number | null {
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The refusal both commands print for an unreadable pace, so it reads the same. */
export const PACE_REFUSAL = "FAILED (bad-input): MEASURE_PACE_MS must be a number of milliseconds, 0 or more";

export function tierOf(code: string | null): string | null {
  return code && /^[1-5]/.test(code) ? code[0]! : null;
}
