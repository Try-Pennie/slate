import { calcomApiKey, calcomBaseUrl, calcomOrgId } from "@/lib/env";
import { isLoadtest, loadtestRefusal, refuseUnderLoadtest } from "@/lib/loadtest-guard";
import { OUTCOME_NOT_CONFIGURED, OUTCOME_NOTHING_TO_REMOVE_PREFIX, notInCalcomOutcome } from "./outcomes.ts";
import {
  datesCoveredBy,
  recomputeOverrides,
  type AbsenceWindow,
  type CalcomAvailabilityRule,
  type DateOverride,
} from "@/lib/calcom/overrides";
import { CAL_SCHEDULES_API_VERSION, pickDefaultSchedule } from "@/lib/calcom/schedule-import";
import { bookedByTier, readRoutingResponses, type RoutingReadResult } from "@/lib/calcom/routing-responses";
import {
  readCalcomBookingByUid,
  readCalcomBookingsCreated,
  readCalcomListedBookingByUid,
  readUpcomingCalcomBookings,
  type CalcomListingStatus,
  type CalcomListedRead,
  type CalcomListedByUidRead,
  type CalcomBookingRead,
  type CalcomGetter,
  type CalcomUpcomingRead,
} from "@/lib/calcom/upcoming-bookings";

/**
 * Minimal Cal.com v2 org-API client for the OOO dual-write during the cutover
 * transition: resolve user -> default schedule -> patch its date overrides.
 * fetch-based (Cloudflare Workers safe). The exported add/remove helpers never
 * throw — they return "ok" | "failed: <why>" for the side_effects record.
 * Known exposure (same as the Apps Script): PATCH replaces the whole override
 * list, so a concurrent edit in the Cal.com UI between read and patch loses.
 */

interface CalcomSchedule {
  id: number;
  name?: string;
  timeZone?: string;
  isDefault?: boolean;
  availability?: CalcomAvailabilityRule[];
  overrides?: DateOverride[];
}

export function calcomConfigured(): boolean {
  return calcomOrgId().length > 0 && calcomApiKey().length > 0;
}

/**
 * How long one cal.com request may wait when its caller sets no bound of its own
 * (#3972). cal.com answers in well under a second (measured 2026-09-30); a time off
 * write is up to three attempts (`RETRY_WAITS_MS`), each ending at its first stalled
 * request, so a hung cal.com is reported "failed" after about 18 seconds, inside the
 * 30 second `after()` window the Slack approve button runs in, where the monitor
 * lane's retry sweep picks it up. Without a bound it was killed with no outcome.
 */
export const CALCOM_REQUEST_TIMEOUT_MS = 6_000;

async function calcomFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; data: unknown }> {
  // The choke point: every cal.com request the app makes is one of these (#2335).
  // The OOO dual write is ON in `env.loadtest`'s vars, so a run reaching cal.com
  // would patch a real agent's real schedule.
  refuseUnderLoadtest("cal.com");
  const res = await fetch(`${calcomBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${calcomApiKey()}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    // #3972: a caller's own signal wins; every other call gets this one, so a hung
    // cal.com is a "failed" outcome rather than a time off write killed mid await by
    // the 30 second `after()` cancel (the Slack approve button) or a lane's limit.
    signal: init.signal ?? AbortSignal.timeout(CALCOM_REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: unknown };
  return { status: res.status, data: body.data };
}

/**
 * A lookup answer that keeps the three cases apart (#1250). Collapsing them into
 * `null` made a rotated key, a 500 and a changed response shape all report as "no
 * cal.com user for <email>": a cause the code never measured, which sends the
 * reader after a missing person instead of a broken integration, and which any
 * retry would then re-attempt forever.
 */
type Lookup<T> =
  | { kind: "found"; value: T }
  | { kind: "absent" }
  | { kind: "error"; detail: string; retryable: boolean };

/**
 * Which failures a second attempt could plausibly fix (#1253). A 5xx or a 429 is
 * transient: the incident this retry exists for was a single 500 on the patch that
 * permanently consumed an absence's protection. A 401, 403 or 404 cannot succeed on
 * a retry, so retrying only delays the report and hammers a system already refusing
 * us. An unexpected body shape is a contract change, not a blip.
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/** Non-2xx, or a 2xx whose body is not the array the API contract promises. */
function httpProblem(
  what: string,
  status: number,
  data: unknown,
): { detail: string; retryable: boolean } | null {
  if (status < 200 || status >= 300) {
    return { detail: `cal.com ${what} returned ${status}`, retryable: isRetryableStatus(status) };
  }
  if (!Array.isArray(data)) {
    return { detail: `cal.com ${what} returned an unexpected shape`, retryable: false };
  }
  return null;
}

async function getUserIdByEmail(email: string): Promise<Lookup<number>> {
  const { status, data } = await calcomFetch(
    `/organizations/${calcomOrgId()}/users?emails[]=${encodeURIComponent(email)}`,
  );
  const problem = httpProblem("user lookup", status, data);
  if (problem) return { kind: "error", ...problem };
  const user = (data as unknown[])[0] as { id?: number } | undefined;
  // cal.com answered and matched nobody: genuinely absent, not a failure.
  return user?.id ? { kind: "found", value: user.id } : { kind: "absent" };
}

/** Prefer the default schedule, falling back to the first; hydrate if thin. */
async function getDefaultSchedule(userId: number): Promise<Lookup<CalcomSchedule>> {
  const base = `/organizations/${calcomOrgId()}/users/${userId}/schedules`;
  const { status, data } = await calcomFetch(base);
  const problem = httpProblem("schedule lookup", status, data);
  if (problem) return { kind: "error", ...problem };
  const list = data as CalcomSchedule[];
  let schedule = list.find((s) => s.isDefault) ?? list[0];
  // The user exists in cal.com but has no schedule to patch. Someone can fix
  // that, so it stays a reportable problem rather than a skip.
  if (!schedule) return { kind: "absent" };
  if (!schedule.availability || !schedule.timeZone) {
    const one = await calcomFetch(`${base}/${schedule.id}`);
    if (one.status >= 200 && one.status < 300 && one.data) {
      schedule = one.data as CalcomSchedule;
    }
  }
  return { kind: "found", value: schedule };
}

async function patchOverrides(
  userId: number,
  schedule: CalcomSchedule,
  overrides: DateOverride[],
): Promise<Attempt> {
  const { status } = await calcomFetch(
    `/organizations/${calcomOrgId()}/users/${userId}/schedules/${schedule.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        name: schedule.name,
        timeZone: schedule.timeZone,
        availability: schedule.availability,
        isDefault: !!schedule.isDefault,
        overrides,
      }),
    },
  );
  if (status >= 200 && status < 300) return done("ok");
  return {
    outcome: `failed: schedule patch returned ${status}`,
    retryable: isRetryableStatus(status),
  };
}

type OverrideMode = "add" | "remove";

/** One pass at the dual-write, and whether trying again could change the answer. */
interface Attempt {
  outcome: string;
  retryable: boolean;
}

/** A settled answer: correct, or wrong in a way a retry cannot fix. */
const done = (outcome: string): Attempt => ({ outcome, retryable: false });

/**
 * Attempts per dual-write, and the waits between them (#1253).
 *
 * Deliberately small and quick, because this runs inside an approval a manager is
 * waiting on, not a background job. Two extra tries at under a second in total
 * covers the transient blip that consumed a real absence's protection in June,
 * while the 5-minute sweep is what covers a failure that outlives them.
 */
const RETRY_WAITS_MS = [200, 600];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function applyOoo(
  mode: OverrideMode,
  agentEmail: string,
  startIso: string,
  endIso: string,
  otherApproved: AbsenceWindow[],
): Promise<string> {
  let last: Attempt = { outcome: "failed: cal.com never attempted", retryable: false };
  for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_WAITS_MS[attempt - 1]);
    last = await attemptOoo(mode, agentEmail, startIso, endIso, otherApproved);
    if (!last.retryable) return last.outcome;
  }
  // Out of attempts: report the LAST cause seen, so the message says what is
  // actually happening now rather than what happened first.
  return last.outcome;
}

async function attemptOoo(
  mode: OverrideMode,
  agentEmail: string,
  startIso: string,
  endIso: string,
  otherApproved: AbsenceWindow[],
): Promise<Attempt> {
  try {
    // Not a failure: cal.com is being wound down, so an unconfigured integration
    // is a deliberate state with nothing for anyone to do. Alerting on it would
    // page on every single approval.
    if (!calcomConfigured()) return done(OUTCOME_NOT_CONFIGURED);
    // The refusal is asked HERE as well, and the second placement is what makes it
    // settled rather than retried. `calcomFetch` throws, this function catches a
    // throw as a transport problem and reports it retryable, so the choke point
    // alone would cost the whole retry ladder and then say the same thing (L110).
    // One wording, from `loadtestRefusal`, so the two cannot drift (L41).
    if (isLoadtest()) return done(`failed: ${loadtestRefusal("cal.com")}`);
    const user = await getUserIdByEmail(agentEmail);
    if (user.kind === "error") {
      return { outcome: `failed: ${user.detail}`, retryable: user.retryable };
    }
    // Nobody can book an agent who does not exist in cal.com, so there is no
    // availability to block and no action for a human: a skip, not a failure
    // (#1249). Expected to become more common as new hires land in Slate only.
    if (user.kind === "absent") return done(notInCalcomOutcome(agentEmail));
    const userId = user.value;
    const found = await getDefaultSchedule(userId);
    if (found.kind === "error") {
      return { outcome: `failed: ${found.detail}`, retryable: found.retryable };
    }
    if (found.kind === "absent") {
      return done(`failed: no schedule for cal.com user ${userId}`);
    }
    const schedule = found.value;
    if (!schedule.timeZone) {
      return done(`failed: no timezone on cal.com schedule ${schedule.id}`);
    }
    // The dates this absence touches are what gets rewritten; every other date
    // in cal.com is carried across untouched (#2417).
    const dates = datesCoveredBy(startIso, endIso, schedule.timeZone);
    if (dates === null) {
      return done(`failed: unreadable time off window ${startIso} to ${endIso}`);
    }
    // A zero-length window covers no date, so there is nothing to rewrite.
    if (dates.length === 0) return done("ok");

    const own: AbsenceWindow = { startIso, endIso };
    // Adding counts this absence; removing is the same computation without it.
    // Both are built from `otherApproved`, which never contains this request, so
    // running either twice converges rather than compounding.
    const windows = mode === "add" ? [...otherApproved, own] : [...otherApproved];
    const existing = Array.isArray(schedule.overrides)
      ? schedule.overrides
      : [];
    const next = recomputeOverrides({
      existing,
      dates,
      windows,
      scheduleTz: schedule.timeZone,
      availability: schedule.availability,
    });
    if (!next.ok) return done(`failed: ${next.reason}`);

    // What SHOULD be sitting in cal.com right now, with this absence still
    // counted. Only used to tell a real removal from one that matched nothing.
    const expected =
      mode === "remove"
        ? recomputeOverrides({
            existing: [],
            dates,
            windows: [...otherApproved, own],
            scheduleTz: schedule.timeZone,
            availability: schedule.availability,
          })
        : null;

    const patched = await patchOverrides(userId, schedule, next.overrides);
    if (patched.outcome !== "ok") return patched;
    // #2417 / L100: a removal that matched nothing must not report success. The
    // schedule has been rewritten to what Slate says the dates should offer, so
    // cal.com is right either way; what is being reported is that the override
    // this cancellation was supposed to undo was not there to undo.
    if (expected?.ok && expected.overrides.length > 0 && next.replaced === 0) {
      return done(
        `${OUTCOME_NOTHING_TO_REMOVE_PREFIX} ${dates.join(", ")} to remove; ` +
          `the schedule has been rewritten to match Slate`,
      );
    }
    return patched;
  } catch (e) {
    // A thrown fetch is a transport problem (DNS, a dropped connection), which is
    // the same class as a 5xx: worth one more try.
    return { outcome: `failed: ${String(e).slice(0, 200)}`, retryable: true };
  }
}

/**
 * Write this absence into cal.com's date overrides.
 *
 * `otherApproved` is every OTHER approved absence of the same agent that could
 * touch the same dates, and it is required rather than optional on purpose
 * (#2417): a caller that forgot it would silently reopen the day, which is the
 * defect this argument exists to close. `src/lib/ooo/calcom-sync.ts` is the one
 * place that reads it, and it refuses the write rather than passing a set it
 * could not measure.
 */
export const addOooOverrides = (
  agentEmail: string,
  startIso: string,
  endIso: string,
  otherApproved: AbsenceWindow[],
): Promise<string> => applyOoo("add", agentEmail, startIso, endIso, otherApproved);

/** Take this absence out of cal.com's date overrides; see `addOooOverrides`. */
export const removeOooOverrides = (
  agentEmail: string,
  startIso: string,
  endIso: string,
  otherApproved: AbsenceWindow[],
): Promise<string> => applyOoo("remove", agentEmail, startIso, endIso, otherApproved);

/**
 * What one agent's cal.com schedule read came back as (#2627). Every way it can fail
 * to produce a schedule is its own kind, because the activation gate logs each by
 * name and each sends a different person to do a different thing (L11).
 */
export type ScheduleForImportRead =
  | { kind: "schedule"; schedule: unknown }
  /** No key or org in this deployment. cal.com is being wound down, so this is a
   *  deliberate state, the same one the OOO dual write treats as a skip. */
  | { kind: "not-configured" }
  /** Refused under the load test environment (#2335): the roster is synthetic. */
  | { kind: "loadtest" }
  /** cal.com answered and holds nobody at this address. */
  | { kind: "no-account" }
  /** The account exists and owns no schedule. */
  | { kind: "no-schedule" }
  /** A 429 on either call. Never retried here: the daily importer is the retry. */
  | { kind: "rate-limited" }
  /** Any other non-2xx, named. */
  | { kind: "refused"; status: number }
  /** The fetch threw: a timeout, DNS, a dropped socket. */
  | { kind: "unreachable"; detail: string }
  /** A 2xx whose body is not what the contract promises. */
  | { kind: "unreadable"; why: string };

/**
 * Read ONE agent's default cal.com schedule, for the activation gate (#2627).
 *
 * Bounded on purpose, because it runs on the request path of the admin toggle and
 * inside the hourly roster lane's shared invocation: at most TWO calls, each carrying
 * its own deadline, and no retry at all. The daily importer, which paces itself and
 * climbs a retry ladder, is what repairs a read this one could not make, so a retry
 * here would only spend the activation's budget on a chance the importer takes anyway.
 *
 * The lookup is by `emails[]`, the one the OOO dual write has made daily for months,
 * rather than the importer's whole org listing, which is one read of every user to
 * find one. Both were measured live on 2026-09-24 under the importer's API version:
 * a known address answers one user, an unknown one an empty list. The schedule
 * choice is the importer's own `pickDefaultSchedule`.
 *
 * NEVER throws. Every outcome is a value, so the caller can activate regardless.
 */
export async function readScheduleForImport(
  email: string,
  timeoutMs: number,
): Promise<ScheduleForImportRead> {
  if (!calcomConfigured()) return { kind: "not-configured" };
  // Asked before the choke point as well, so a load test is its own settled answer
  // rather than a throw read as an unreachable cal.com.
  if (isLoadtest()) return { kind: "loadtest" };
  const init = (): RequestInit => ({
    headers: { "cal-api-version": CAL_SCHEDULES_API_VERSION },
    signal: AbortSignal.timeout(timeoutMs),
  });
  try {
    const lookup = await calcomFetch(
      `/organizations/${calcomOrgId()}/users?emails[]=${encodeURIComponent(email)}`,
      init(),
    );
    if (lookup.status === 429) return { kind: "rate-limited" };
    if (lookup.status < 200 || lookup.status >= 300) return { kind: "refused", status: lookup.status };
    if (!Array.isArray(lookup.data)) {
      return { kind: "unreadable", why: "the user lookup did not answer a list" };
    }
    if (lookup.data.length === 0) return { kind: "no-account" };
    const user = lookup.data[0] as { id?: unknown; email?: unknown };
    // Identity is CONFIRMED rather than assumed from the filter (L75): a lookup that
    // ignored the filter would otherwise import the first listed person's week.
    if (typeof user?.email !== "string" || user.email.toLowerCase() !== email.trim().toLowerCase()) {
      return { kind: "unreadable", why: "the user lookup answered a different address" };
    }
    if (typeof user.id !== "number") {
      return { kind: "unreadable", why: "the cal.com user carries no numeric id" };
    }

    const scheds = await calcomFetch(`/organizations/${calcomOrgId()}/users/${user.id}/schedules`, init());
    if (scheds.status === 429) return { kind: "rate-limited" };
    if (scheds.status < 200 || scheds.status >= 300) return { kind: "refused", status: scheds.status };
    const picked = pickDefaultSchedule({ data: scheds.data });
    if (picked.kind === "none") return { kind: "no-schedule" };
    if (picked.kind === "unreadable") return { kind: "unreadable", why: picked.why };
    return { kind: "schedule", schedule: picked.schedule };
  } catch (err) {
    return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The pause between routing response pages, measured against cal.com's rate limit
 * for bulk reads (#2240), the same one the measure commands use.
 */
const ROUTING_PACE_MS = 550;

/**
 * Every cal.com routing form response created at or after `fromIso`, across every form
 * in the org, paced against cal.com's limit. Null when cal.com is not configured here,
 * which is the state after cutover. A refused page or a changed payload is a `{ ok:
 * false }` answer, never a shorter list: each caller decides what a partial read means
 * for it, and none may count one. Shared by the daily carried share (#2893) and the
 * busy minute check (#3124), so cal.com's traffic is read one way.
 */
export async function readCalcomRoutingResponses(fromIso: string): Promise<RoutingReadResult | null> {
  if (!calcomConfigured()) return null;
  return readRoutingResponses({
    get: async (path, apiVersion) => {
      const r = await calcomFetch(path, { headers: { "cal-api-version": apiVersion } });
      return { status: r.status, json: { data: r.data } };
    },
    org: calcomOrgId(),
    fromIso,
    paceMs: ROUTING_PACE_MS,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

/**
 * cal.com's bookings per debt tier created in [fromIso, toIso) (#2893), for the daily
 * carried share. Null when cal.com is not configured here, which is the state after
 * cutover, and never on a failed read: a refused page or a changed payload THROWS,
 * because a share from part of cal.com's traffic would lean toward Slate and thin
 * every anchor with it. About ten requests a day, paced.
 */
export async function calcomTierBookingCounts(fromIso: string, toIso: string): Promise<Record<"1" | "2" | "3" | "4" | "5", number> | null> {
  const fromMs = Date.parse(fromIso); // parse-ok: built by the caller from a number with toISOString
  const toMs = Date.parse(toIso); // parse-ok: as above
  const read = await readCalcomRoutingResponses(fromIso);
  if (read === null) return null;
  if (!read.ok) {
    throw new Error(
      `cal.com routing responses could not be read (${read.reason}, status ${read.status}${read.formName ? `, form ${read.formName}` : ""})`,
    );
  }
  return bookedByTier(read.rows, fromMs, toMs);
}

/**
 * What cal.com's routing form would offer a lead with these routing fields over
 * [startIso, endIso) (#2927): `POST /routing-forms/{form}/calculate-slots`. It
 * answers the routed event type and its slots and stores no response (measured
 * 2026-09-30: the form's newest response was unchanged by the call). Returns the
 * raw status and body for `readCalcomRoutedSlots` to judge; throws when cal.com
 * is not configured here, so the sample records why rather than an empty offer.
 *
 * The time zone is REQUIRED (#3002). Asked without one, cal.com answers a
 * truncated list: measured 2026-10-02 for a 112 lead, Friday stopped at 3:30pm ET
 * and Saturday at 3:40pm ET, while with `America/New_York` the answer matched the
 * live booker to the minute (Friday to 7:40pm ET, 42 times in 24 hours). The
 * truncated rows made Slate look like it offered four times as many times.
 */
export async function calcomRoutedSlots(
  formId: string,
  fields: Record<string, number | string>,
  window: { start: string; end: string; timeZone: string },
  // It runs on the monitor lane, awaited ahead of the checks after it, so a cal.com
  // that never answers must give up rather than stall them. Measured 2026-09-30 the
  // call answers in well under a second; ten gives a slow day plenty of room.
  timeoutMs = CALCOM_ROUTED_SLOTS_TIMEOUT_MS,
): Promise<{ status: number; data: unknown }> {
  if (!calcomConfigured()) throw new Error("cal.com is not configured here");
  const timeZone = window.timeZone.trim();
  if (!timeZone) throw new Error("no time zone was given, and cal.com answers a truncated list without one");
  const q = new URLSearchParams({ start: window.start, end: window.end, timeZone });
  return calcomFetch(`/routing-forms/${encodeURIComponent(formId)}/calculate-slots?${q}`, {
    method: "POST",
    headers: { "cal-api-version": "2024-09-04" },
    body: JSON.stringify(fields),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** How long the pilot offer sample waits for cal.com before recording a failure. */
export const CALCOM_ROUTED_SLOTS_TIMEOUT_MS = 10_000;

/** The pause between listing pages, the same order as the routing response reads. */
const BOOKINGS_PACE_MS = 300;

/** The cal.com getter both booking reads use; the reader picks each request's timeout. */
const bookingsGet: CalcomGetter = async (path, apiVersion, timeoutMs) => {
  const r = await calcomFetch(path, {
    headers: { "cal-api-version": apiVersion },
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
  return { status: r.status, json: { data: r.data } };
};

/**
 * Every upcoming cal.com booking in the org (#2933), read only, finished by
 * `deadlineAtMs` or refused as `deadline`. Null when cal.com is not configured here,
 * which is the state after cutover. A refused, unreadable, unreachable or timed out
 * walk comes back as a refusal, never as the rows read before it.
 */
export async function calcomUpcomingBookings(afterStartIso: string, deadlineAtMs: number): Promise<CalcomUpcomingRead | null> {
  if (!calcomConfigured()) return null;
  return readUpcomingCalcomBookings({
    get: bookingsGet,
    org: calcomOrgId(),
    afterStartIso,
    paceMs: BOOKINGS_PACE_MS,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    clock: Date.now,
    deadlineAtMs,
  });
}

/**
 * Every cal.com booking of one status MADE in `[afterCreatedIso, beforeCreatedIso)`
 * (#2946), for the pilot comparison. Null when cal.com is not configured here.
 */
export async function calcomBookingsCreated(
  status: CalcomListingStatus,
  afterCreatedIso: string,
  beforeCreatedIso: string,
  deadlineAtMs: number,
): Promise<CalcomListedRead | null> {
  if (!calcomConfigured()) return null;
  return readCalcomBookingsCreated({
    get: bookingsGet,
    org: calcomOrgId(),
    status,
    afterCreatedIso,
    beforeCreatedIso,
    paceMs: BOOKINGS_PACE_MS,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    clock: Date.now,
    deadlineAtMs,
  });
}

/** One booking by uid in the listed shape (#2946), for a reschedule chain's next link. */
export async function calcomListedBookingByUid(uid: string, deadlineAtMs: number): Promise<CalcomListedByUidRead | null> {
  if (!calcomConfigured()) return null;
  return readCalcomListedBookingByUid({ get: bookingsGet, uid, clock: Date.now, deadlineAtMs });
}

/** One cal.com booking by uid (#2933), for the all clear. Null when cal.com is not configured. */
export async function calcomBookingByUid(uid: string, deadlineAtMs: number): Promise<CalcomBookingRead | null> {
  if (!calcomConfigured()) return null;
  return readCalcomBookingByUid({ get: bookingsGet, uid, clock: Date.now, deadlineAtMs });
}

