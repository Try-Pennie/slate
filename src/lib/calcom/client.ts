import { calcomApiKey, calcomBaseUrl, calcomOrgId } from "@/lib/env";
import { isLoadtest, loadtestRefusal, refuseUnderLoadtest } from "@/lib/loadtest-guard";
import { OUTCOME_NOT_CONFIGURED, notInCalcomOutcome } from "./outcomes.ts";
import {
  datesCoveredBy,
  recomputeOverrides,
  type AbsenceWindow,
  type CalcomAvailabilityRule,
  type DateOverride,
} from "@/lib/calcom/overrides";

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
        `failed: no cal.com override was on ${dates.join(", ")} to remove; ` +
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
