/**
 * The reads and probes behind the placeholder seat check (#4206), kept out of the monitor
 * route so the column lists and the probes are in one place.
 *
 * The two reads THROW on an error. The probes never throw: a failure IS their answer,
 * classified by the one vocabulary every Google check uses.
 */
import type { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap, unwrapCount } from "@/lib/db/result";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking/bulk-reassign-store";
import { classifyCalendarReachability, REACHABILITY_PROBE_TIMEOUT_MS } from "@/lib/google/reachability";
import { classifyGoogleStatus, parseGoogleErrorReason, reachabilityFromError } from "@/lib/google/reachability-classify";
import { getDelegatedToken, GMAIL_SEND_SCOPE, GMAIL_SETTINGS_READ_SCOPE } from "@/lib/google/dwd";
import { GoogleHttpError } from "@/lib/google/http-error";
import { log } from "@/lib/log";
import {
  isScopeNotGranted,
  judgeAutoReply,
  type AutoReplyProbe,
  type PlaceholderSeatRow,
  type SeatProbe,
  type VacationSettings,
} from "@/lib/monitor/placeholder-seat";

type Db = ReturnType<typeof supabaseAdmin>;

const TAG = "placeholder-seat";

/**
 * The real placeholder rows, every org: never the test placeholder the drills book. Both
 * are read (at most one of each per org, `users_one_placeholder_per_org`) and the test
 * one dropped here, because a bare test filter on a users read is the shared real
 * advisor rule's to spell (scripts/test-real-advisor-reads.ts).
 */
export async function loadRealPlaceholders(db: Db): Promise<PlaceholderSeatRow[]> {
  const rows = unwrap(
    // cap-safe: users is roster bounded, and holds at most two placeholders per org.
    // any-advisor-ok: this read is ABOUT the placeholder advisor, the one row the real
    // advisor rule exists to leave out.
    await db.from("users").select("id, name, email, deactivated_at, is_test").eq("is_placeholder", true),
    "monitor placeholder seat rows",
  ) as (PlaceholderSeatRow & { is_test: boolean | null })[];
  return rows
    .filter((r) => r.is_test !== true)
    .map((r) => ({ id: r.id, name: r.name, email: r.email, deactivated_at: r.deactivated_at }));
}

/** Active calls on these placeholders that have not yet ended, counted server side. */
export async function countFutureCallsOnPlaceholders(db: Db, placeholderIds: string[], nowIso: string): Promise<number> {
  return unwrapCount(
    await db
      // agent-link-ok: calls on the placeholder are staff_placed, never routed demand.
      // test-data-ok: scoped to the REAL placeholders' ids, which already leaves the test
      // placeholder's drill calls out; bookings carries no is_test of its own.
      .from("bookings")
      .select("id", { count: "exact", head: true })
      // in-chunk-ok: at most one real placeholder per org, and Slate has one org.
      .in("assigned_user_id", placeholderIds)
      .in("status", ACTIVE_BOOKING_STATUSES)
      .gt("ends_at", nowIso),
    "monitor placeholder future calls",
  );
}

/** The calendar half: the activation gate's own probe, logged under this check's tag. */
export function probePlaceholderCalendar(email: string): Promise<SeatProbe> {
  return classifyCalendarReachability(email, TAG);
}

/**
 * The Gmail half: mint the seat's `gmail.send` token, which reads and sends nothing. See
 * `placeholder-seat.ts` for what this can and cannot see.
 */
export async function probePlaceholderGmail(email: string): Promise<SeatProbe> {
  try {
    await getDelegatedToken(email, GMAIL_SEND_SCOPE, REACHABILITY_PROBE_TIMEOUT_MS);
    return "reachable";
  } catch (err) {
    const kind = reachabilityFromError(err);
    log.warn(TAG, { msg: "gmail token probe failed", email, kind }, err);
    return kind;
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The seat's standing Gmail auto reply (#4265): `users.settings.getVacation` under a
 * token for `gmail.settings.basic` alone, judged by `judgeAutoReply`. A mint refused
 * because the delegation does not grant that scope is `not-granted`, never a failure of
 * the seat; every other refusal or failed read is classified like any Google read. Never
 * throws.
 */
export async function probePlaceholderAutoReply(
  email: string,
  nowMs: number = Date.now(),
  // deadline-ok: the read below carries AbortSignal.timeout(REACHABILITY_PROBE_TIMEOUT_MS)
  fetchImpl: FetchLike = fetch,
): Promise<AutoReplyProbe> {
  let token: string;
  try {
    token = await getDelegatedToken(email, GMAIL_SETTINGS_READ_SCOPE, REACHABILITY_PROBE_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof GoogleHttpError && isScopeNotGranted(err.status, err.reason)) {
      log.info(TAG, {
        msg: "auto reply not read: the gmail.settings.basic permission is not granted to the delegation yet",
        email,
      });
      return "not-granted";
    }
    const kind = reachabilityFromError(err);
    log.warn(TAG, { msg: "auto reply token mint failed", email, kind }, err);
    return kind;
  }
  try {
    const res = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(email)}/settings/vacation`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REACHABILITY_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      // swallow-ok: the body only names the reason; the status classifies it either way.
      const body = await res.text().catch(() => "");
      const kind = classifyGoogleStatus(res.status, parseGoogleErrorReason(body));
      log.warn(TAG, { msg: "auto reply read refused", email, status: res.status, kind });
      return kind;
    }
    return judgeAutoReply((await res.json()) as VacationSettings, nowMs);
  } catch (err) {
    // No answer, a missed deadline, or a body that is not JSON: nothing was measured.
    log.warn(TAG, { msg: "auto reply read failed", email, kind: "transient" }, err);
    return "transient";
  }
}
