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

async function getUserIdByEmail(email: string): Promise<number | null> {
  const { status, data } = await calcomFetch(
    `/organizations/${calcomOrgId()}/users?emails[]=${encodeURIComponent(email)}`,
  );
  if (status < 200 || status >= 300 || !Array.isArray(data)) return null;
  const user = data[0] as { id?: number } | undefined;
  return user?.id ?? null;
}

/** Prefer the default schedule, falling back to the first; hydrate if thin. */
async function getDefaultSchedule(
  userId: number,
): Promise<CalcomSchedule | null> {
  const base = `/organizations/${calcomOrgId()}/users/${userId}/schedules`;
  const { status, data } = await calcomFetch(base);
  if (status < 200 || status >= 300 || !Array.isArray(data)) return null;
  const list = data as CalcomSchedule[];
  let schedule = list.find((s) => s.isDefault) ?? list[0];
  if (!schedule) return null;
  if (!schedule.availability || !schedule.timeZone) {
    const one = await calcomFetch(`${base}/${schedule.id}`);
    if (one.status >= 200 && one.status < 300 && one.data) {
      schedule = one.data as CalcomSchedule;
    }
  }
  return schedule;
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
    if (!calcomConfigured()) return "failed: calcom not configured";
    const userId = await getUserIdByEmail(agentEmail);
    if (!userId) return `failed: no cal.com user for ${agentEmail}`;
    const schedule = await getDefaultSchedule(userId);
    if (!schedule?.timeZone) {
      return `failed: no schedule for cal.com user ${userId}`;
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
