import { nanoid } from "nanoid";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  listCalendars,
  syncEvents,
  watchCalendar,
  stopChannel,
  SyncTokenExpired,
  type GoogleEvent,
} from "@/lib/google/calendar";
import { selectableCalendarIds } from "@/lib/google/calendar-select";
import { googlePushUrl } from "@/lib/env";
import type { AgentCalendar } from "@/lib/db/types";

const BOOTSTRAP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const WATCH_RENEW_THRESHOLD_MS = 12 * 60 * 60 * 1000;

async function loadAgentEmail(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  return (data as { email: string | null } | null)?.email ?? null;
}

async function loadAgentCalendars(userId: string): Promise<AgentCalendar[]> {
  const { data } = await supabaseAdmin()
    .from("agent_calendars")
    .select("*")
    .eq("user_id", userId);
  return (data ?? []) as AgentCalendar[];
}

function eventWindow(
  ev: GoogleEvent,
): { start: string; end: string } | null {
  const start = ev.start?.dateTime ?? ev.start?.date;
  const end = ev.end?.dateTime ?? ev.end?.date;
  if (!start || !end) return null;
  return {
    start: ev.start?.dateTime ? start : `${start}T00:00:00.000Z`,
    end: ev.end?.dateTime ? end : `${end}T00:00:00.000Z`,
  };
}

/** Upsert/delete gcal-sourced busy blocks for a batch of events on one calendar. */
async function applyEvents(
  userId: string,
  calendarId: string,
  events: GoogleEvent[],
): Promise<void> {
  const db = supabaseAdmin();
  for (const ev of events) {
    if (!ev.id) continue;
    const win = eventWindow(ev);
    const isBusy =
      ev.status !== "cancelled" &&
      ev.transparency !== "transparent" &&
      win !== null;

    if (!isBusy) {
      await db
        .from("busy_blocks")
        .delete()
        .eq("user_id", userId)
        .eq("gcal_event_id", ev.id);
      continue;
    }
    await db.from("busy_blocks").upsert(
      {
        user_id: userId,
        gcal_event_id: ev.id,
        calendar_id: calendarId,
        source: "gcal",
        starts_at: win!.start,
        ends_at: win!.end,
      },
      { onConflict: "user_id,gcal_event_id" },
    );
  }
}

/** Sync one calendar's changes into busy_blocks; advances its stored sync token. */
async function syncCalendar(email: string, cal: AgentCalendar): Promise<number> {
  const bootstrapMin = new Date(
    Date.now() - BOOTSTRAP_LOOKBACK_MS,
  ).toISOString();

  let result;
  try {
    result = await syncEvents(email, cal.calendar_id, cal.sync_token, bootstrapMin);
  } catch (err: unknown) {
    if (err instanceof SyncTokenExpired) {
      result = await syncEvents(email, cal.calendar_id, null, bootstrapMin);
    } else {
      throw err;
    }
  }

  await applyEvents(cal.user_id, cal.calendar_id, result.events);

  if (result.nextSyncToken) {
    await supabaseAdmin()
      .from("agent_calendars")
      .update({ sync_token: result.nextSyncToken })
      .eq("id", cal.id);
  }
  return result.events.length;
}

/** Pulls calendar changes into busy_blocks across ALL of an agent's calendars. */
export async function runIncrementalSync(userId: string): Promise<number> {
  const email = await loadAgentEmail(userId);
  if (!email) return 0;
  const cals = await loadAgentCalendars(userId);
  let n = 0;
  for (const cal of cals) n += await syncCalendar(email, cal);
  return n;
}

/** Sync just the calendar whose push channel pinged us (the webhook hot path). */
export async function syncByChannel(channelId: string): Promise<void> {
  const { data } = await supabaseAdmin()
    .from("agent_calendars")
    .select("*")
    .eq("watch_channel_id", channelId)
    .maybeSingle();
  const cal = data as AgentCalendar | null;
  if (!cal) return;
  const email = await loadAgentEmail(cal.user_id);
  if (!email) return;
  await syncCalendar(email, cal);
}

/** The calendar ids whose busy time blocks an agent (their stored watched set). */
export async function watchedCalendarIds(userId: string): Promise<string[]> {
  const cals = await loadAgentCalendars(userId);
  return cals.map((c) => c.calendar_id);
}

/** Outcome of an ensureWatches attempt — never throws, so callers can surface it. */
export type WatchResult =
  | { status: "skipped"; reason: string }
  | { status: "current" }
  | { status: "renewed" }
  | { status: "error"; error: string };

/**
 * Reconciles the agent's watched calendar set and registers/renews a push
 * channel per calendar. Cheap on the common path: it only hits the Google
 * calendarList API when a renewal is actually due (or on first run), so the
 * 1-min cron just does a DB read + expiry check most of the time.
 */
export async function ensureWatches(userId: string): Promise<WatchResult> {
  const pushUrl = googlePushUrl();
  if (!pushUrl.startsWith("https://") || pushUrl.includes("localhost")) {
    return { status: "skipped", reason: "non-public-https-app-url" };
  }
  const email = await loadAgentEmail(userId);
  if (!email) return { status: "skipped", reason: "no-agent-email" };

  const existing = await loadAgentCalendars(userId);
  const dueForRenewal = (c: AgentCalendar) =>
    !c.watch_expiration ||
    Date.parse(c.watch_expiration) - Date.now() < WATCH_RENEW_THRESHOLD_MS;
  if (existing.length > 0 && !existing.some(dueForRenewal)) {
    return { status: "current" };
  }

  try {
    const db = supabaseAdmin();
    // Reconcile the stored calendar set with what the agent actually has.
    const wanted = selectableCalendarIds(await listCalendars(email));
    const wantedSet = new Set(wanted);
    const haveSet = new Set(existing.map((c) => c.calendar_id));

    const toInsert = wanted.filter((id) => !haveSet.has(id));
    if (toInsert.length) {
      await db
        .from("agent_calendars")
        .insert(toInsert.map((calendar_id) => ({ user_id: userId, calendar_id })));
    }
    for (const c of existing) {
      if (wantedSet.has(c.calendar_id)) continue;
      if (c.watch_channel_id && c.watch_resource_id) {
        await stopChannel(email, c.watch_channel_id, c.watch_resource_id).catch(() => {});
      }
      await db.from("agent_calendars").delete().eq("id", c.id);
    }

    // Register/renew watches for the current set.
    const cals = await loadAgentCalendars(userId);
    let renewed = false;
    for (const cal of cals) {
      if (!dueForRenewal(cal)) continue;
      if (cal.watch_channel_id && cal.watch_resource_id) {
        await stopChannel(email, cal.watch_channel_id, cal.watch_resource_id).catch(() => {});
      }
      const channelId = nanoid();
      const { resourceId, expiration } = await watchCalendar(
        email,
        cal.calendar_id,
        channelId,
      );
      await db
        .from("agent_calendars")
        .update({
          watch_channel_id: channelId,
          watch_resource_id: resourceId,
          watch_expiration: expiration,
        })
        .eq("id", cal.id);
      renewed = true;
    }
    return renewed ? { status: "renewed" } : { status: "current" };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
