import { calcomApiKey, calcomBaseUrl, calcomOrgId } from "@/lib/env";
import {
  buildDateOverrides,
  filterOutOverrides,
  mergeOverrides,
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
  | { kind: "error"; detail: string };

/** Non-2xx, or a 2xx whose body is not the array the API contract promises. */
function httpProblem(what: string, status: number, data: unknown): string | null {
  if (status < 200 || status >= 300) return `cal.com ${what} returned ${status}`;
  if (!Array.isArray(data)) return `cal.com ${what} returned an unexpected shape`;
  return null;
}

async function getUserIdByEmail(email: string): Promise<Lookup<number>> {
  const { status, data } = await calcomFetch(
    `/organizations/${calcomOrgId()}/users?emails[]=${encodeURIComponent(email)}`,
  );
  const problem = httpProblem("user lookup", status, data);
  if (problem) return { kind: "error", detail: problem };
  const user = (data as unknown[])[0] as { id?: number } | undefined;
  // cal.com answered and matched nobody: genuinely absent, not a failure.
  return user?.id ? { kind: "found", value: user.id } : { kind: "absent" };
}

/** Prefer the default schedule, falling back to the first; hydrate if thin. */
async function getDefaultSchedule(userId: number): Promise<Lookup<CalcomSchedule>> {
  const base = `/organizations/${calcomOrgId()}/users/${userId}/schedules`;
  const { status, data } = await calcomFetch(base);
  const problem = httpProblem("schedule lookup", status, data);
  if (problem) return { kind: "error", detail: problem };
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
): Promise<string> {
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
  return status >= 200 && status < 300
    ? "ok"
    : `failed: schedule patch returned ${status}`;
}

type OverrideMode = "add" | "remove";

async function applyOoo(
  mode: OverrideMode,
  agentEmail: string,
  startIso: string,
  endIso: string,
): Promise<string> {
  try {
    // Not a failure: cal.com is being wound down, so an unconfigured integration
    // is a deliberate state with nothing for anyone to do. Alerting on it would
    // page on every single approval.
    if (!calcomConfigured()) return "skipped: cal.com not configured";
    const user = await getUserIdByEmail(agentEmail);
    if (user.kind === "error") return `failed: ${user.detail}`;
    // Nobody can book an agent who does not exist in cal.com, so there is no
    // availability to block and no action for a human: a skip, not a failure
    // (#1249). Expected to become more common as new hires land in Slate only.
    if (user.kind === "absent") return `skipped: not in cal.com (${agentEmail})`;
    const userId = user.value;
    const found = await getDefaultSchedule(userId);
    if (found.kind === "error") return `failed: ${found.detail}`;
    if (found.kind === "absent") return `failed: no schedule for cal.com user ${userId}`;
    const schedule = found.value;
    if (!schedule.timeZone) {
      return `failed: no timezone on cal.com schedule ${schedule.id}`;
    }
    const built = buildDateOverrides(
      startIso,
      endIso,
      schedule.timeZone,
      schedule.availability,
    );
    const existing = Array.isArray(schedule.overrides)
      ? schedule.overrides
      : [];
    const next =
      mode === "add"
        ? mergeOverrides(existing, built)
        : filterOutOverrides(existing, built);
    return await patchOverrides(userId, schedule, next);
  } catch (e) {
    return `failed: ${String(e).slice(0, 200)}`;
  }
}

export const addOooOverrides = (
  agentEmail: string,
  startIso: string,
  endIso: string,
): Promise<string> => applyOoo("add", agentEmail, startIso, endIso);

export const removeOooOverrides = (
  agentEmail: string,
  startIso: string,
  endIso: string,
): Promise<string> => applyOoo("remove", agentEmail, startIso, endIso);
