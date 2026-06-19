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
import { recomputeBucketsForAgent } from "@/lib/availability/slot-cache";
import {
  isBusyEvent,
  partitionBusyWrites,
  staleBlockIds,
} from "@/lib/google/sync-core";
import {
  claimWindow,
  orderCalendarsForSync,
  pastDeadline,
  shouldRerun,
  CALENDAR_CLAIM_TTL_MS,
  MAX_SYNC_PASSES,
} from "@/lib/google/sync-coalesce";
import {
  toSyncAgents,
  type SyncAgent,
  type SyncCandidateRow,
} from "@/lib/google/sync-pace";
import { stampLastSynced, type SyncWritesDb } from "@/lib/google/sync-writes";
import { googlePushUrl } from "@/lib/env";
import type { AgentCalendar } from "@/lib/db/types";

const BOOTSTRAP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Renew well before Google's ~7-day watch TTL so a cron outage can't drop push.
const WATCH_RENEW_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

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

/**
 * Every bookable, ACTIVE agent's pacing facts for one cron tick — DB only, no
 * Google calls. Deactivated (offboarded) users are filtered out (#274) so the
 * sync/watch loop never touches an account nobody can fix (and never fires
 * watch-renewal alerts for it). `hasCalendars` distinguishes brand-new agents
 * (need first-time watch setup) from already-onboarded ones; `lastSyncedMs`
 * drives rotation. Two reads: the bookable users, then which of them have any
 * agent_calendars row.
 */
export async function loadSyncAgents(): Promise<SyncAgent[]> {
  const db = supabaseAdmin();
  const { data: users } = await db
    .from("users")
    .select("id, last_synced_at, deactivated_at")
    .eq("bookable", true)
    .is("deactivated_at", null);
  const rows = (users ?? []) as SyncCandidateRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { data: cals } = await db
    .from("agent_calendars")
    .select("user_id")
    .in("user_id", ids);
  const withCalendars = new Set(
    ((cals ?? []) as { user_id: string }[]).map((c) => c.user_id),
  );

  return toSyncAgents(rows, withCalendars);
}

/**
 * Stamp users.last_synced_at = now for every agent processed this tick, in ONE
 * write (#243), for rotation. Best-effort; never throws. The batching + guards
 * live in the dependency-free sync-writes module so they stay node-testable.
 */
export async function markAgentsSynced(userIds: string[]): Promise<void> {
  await stampLastSynced(
    supabaseAdmin() as unknown as SyncWritesDb,
    userIds,
    new Date().toISOString(),
  );
}

// Cap rows per DB call so even a huge calendar's bootstrap stays well under the
// Worker's per-request subrequest ceiling (the old one-write-per-event loop did
// 1,000+ serial calls and got killed mid-sync; see partitionBusyWrites).
const WRITE_CHUNK = 500;

/** Upsert/delete gcal-sourced busy blocks for a batch of events on one calendar. */
async function applyEvents(
  userId: string,
  calendarId: string,
  events: GoogleEvent[],
): Promise<void> {
  const db = supabaseAdmin();
  const { upserts, deletes } = partitionBusyWrites(userId, calendarId, events);
  // Throw on any failure so syncCalendar never advances the sync token past an
  // event it failed to record - a swallowed error loses the event for good (the
  // delta is consumed) and the cache silently drifts from Google.
  for (let i = 0; i < upserts.length; i += WRITE_CHUNK) {
    const { error } = await db
      .from("busy_blocks")
      .upsert(upserts.slice(i, i + WRITE_CHUNK), {
        onConflict: "user_id,gcal_event_id",
      });
    if (error) throw new Error(`busy_blocks bulk upsert failed: ${error.message}`);
  }
  for (let i = 0; i < deletes.length; i += WRITE_CHUNK) {
    const { error } = await db
      .from("busy_blocks")
      .delete()
      .eq("user_id", userId)
      .in("gcal_event_id", deletes.slice(i, i + WRITE_CHUNK));
    if (error) throw new Error(`busy_blocks bulk delete failed: ${error.message}`);
  }
}

/**
 * After a FULL resync, drop cached gcal blocks for this calendar whose event no
 * longer exists. Incremental syncs carry per-event cancellations, but a full
 * resync (bootstrap or expired token) just returns the current set, so events
 * deleted while the token was stale would otherwise linger and over-block.
 */
async function purgeVanished(
  userId: string,
  calendarId: string,
  events: GoogleEvent[],
): Promise<void> {
  const db = supabaseAdmin();
  const seen = new Set(
    events.filter((e) => e.id && isBusyEvent(e)).map((e) => e.id as string),
  );
  const { data } = await db
    .from("busy_blocks")
    .select("id, gcal_event_id")
    .eq("user_id", userId)
    .eq("calendar_id", calendarId)
    .eq("source", "gcal");
  const stale = staleBlockIds(
    (data ?? []) as { id: string; gcal_event_id: string | null }[],
    seen,
  );
  if (stale.length) {
    await db.from("busy_blocks").delete().in("id", stale);
  }
}

/** Sync one calendar's changes into busy_blocks; advances its stored sync token. */
async function syncCalendar(email: string, cal: AgentCalendar): Promise<number> {
  const bootstrapMin = new Date(
    Date.now() - BOOTSTRAP_LOOKBACK_MS,
  ).toISOString();

  let result;
  let full = !cal.sync_token; // bootstrap (no token) is a full sync
  try {
    result = await syncEvents(email, cal.calendar_id, cal.sync_token, bootstrapMin);
  } catch (err: unknown) {
    if (err instanceof SyncTokenExpired) {
      full = true;
      result = await syncEvents(email, cal.calendar_id, null, bootstrapMin);
    } else {
      throw err;
    }
  }

  await applyEvents(cal.user_id, cal.calendar_id, result.events);
  if (full) await purgeVanished(cal.user_id, cal.calendar_id, result.events);

  if (result.nextSyncToken) {
    await supabaseAdmin()
      .from("agent_calendars")
      .update({ sync_token: result.nextSyncToken })
      .eq("id", cal.id);
  }
  return result.events.length;
}

/**
 * Pulls calendar changes into busy_blocks across an agent's calendars.
 * `deadlineMs` (#44) stops STARTING new calendars once the tick budget is
 * spent - incrementals run first, bootstraps last - and reports truncation;
 * sync tokens make the next invocation resume where this one stopped.
 */
export async function runIncrementalSync(
  userId: string,
  deadlineMs: number | null = null,
): Promise<{ events: number; truncated: boolean }> {
  const email = await loadAgentEmail(userId);
  if (!email) return { events: 0, truncated: false };
  const cals = orderCalendarsForSync(await loadAgentCalendars(userId));
  let events = 0;
  for (let i = 0; i < cals.length; i++) {
    if (pastDeadline(Date.now(), deadlineMs)) {
      return { events, truncated: true };
    }
    events += await syncCalendar(email, cals[i]);
  }
  return { events, truncated: false };
}

/**
 * Sync the calendar whose push channel pinged us (the webhook hot path),
 * coalescing concurrent pings (#30): every ping sets sync_pending, but only
 * the request that wins the sync_claimed_at claim actually syncs - it keeps
 * re-running while new pings land mid-pass (bounded; the 1-minute cron
 * backstop owns anything past the bound), then releases its claim. Losers
 * return immediately knowing the holder will pick their changes up.
 */
export async function syncByChannel(
  channelId: string,
): Promise<"synced" | "coalesced" | "unknown-channel"> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("agent_calendars")
    .select("*")
    .eq("watch_channel_id", channelId)
    .maybeSingle();
  const cal = data as AgentCalendar | null;
  if (!cal) return "unknown-channel";

  // Flag the new changes BEFORE trying to claim, so a holder mid-pass is
  // guaranteed to either see the flag or lose nothing (the cron backstops).
  await db.from("agent_calendars").update({ sync_pending: true }).eq("id", cal.id);

  const { claimIso, staleBeforeIso } = claimWindow(Date.now(), CALENDAR_CLAIM_TTL_MS);
  const { data: claimed } = await db
    .from("agent_calendars")
    .update({ sync_claimed_at: claimIso })
    .eq("id", cal.id)
    .or(`sync_claimed_at.is.null,sync_claimed_at.lt.${staleBeforeIso}`)
    .select("id");
  if (!claimed?.length) return "coalesced";

  const email = await loadAgentEmail(cal.user_id);
  try {
    if (!email) return "synced";
    for (let pass = 1; pass <= MAX_SYNC_PASSES; pass++) {
      await db.from("agent_calendars").update({ sync_pending: false }).eq("id", cal.id);
      const { data: fresh } = await db
        .from("agent_calendars")
        .select("*")
        .eq("id", cal.id)
        .maybeSingle();
      if (!fresh) break;
      await syncCalendar(email, fresh as AgentCalendar);
      const { data: after } = await db
        .from("agent_calendars")
        .select("sync_pending")
        .eq("id", cal.id)
        .maybeSingle();
      const pendingAgain = Boolean(
        (after as { sync_pending?: boolean } | null)?.sync_pending,
      );
      if (!shouldRerun(pendingAgain, pass)) break;
    }
  } finally {
    // Release only OUR claim - after the TTL another request may hold a newer one.
    await db
      .from("agent_calendars")
      .update({ sync_claimed_at: null })
      .eq("id", cal.id)
      .eq("sync_claimed_at", claimIso);
  }
  // The agent's calendar changed: refresh the precomputed slot rows for every
  // bucket they affect so it shows up in <5s. Best-effort (debounced per bucket;
  // the 1-min cron backstop guarantees it regardless).
  void recomputeBucketsForAgent(cal.user_id).catch(() => {});
  return "synced";
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
    // calendarList.list needs the calendar.readonly scope; if the domain-wide
    // delegation doesn't grant it yet (403), fall back to just the primary
    // calendar (works with calendar.events) so sync keeps running. Full
    // multi-calendar activates automatically once the scope is granted.
    let wanted: string[];
    try {
      wanted = selectableCalendarIds(await listCalendars(email));
    } catch {
      wanted = ["primary"];
    }
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
      // Drop cached busy blocks for a calendar the agent no longer has, so a
      // removed calendar can't keep over-blocking their availability.
      await db
        .from("busy_blocks")
        .delete()
        .eq("user_id", userId)
        .eq("calendar_id", c.calendar_id);
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
