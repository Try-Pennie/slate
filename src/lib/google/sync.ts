import { nanoid } from "nanoid";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  syncEvents,
  watchCalendar,
  stopChannel,
  SyncTokenExpired,
  type GoogleEvent,
} from "@/lib/google/calendar";
import { googlePushUrl } from "@/lib/env";

const BOOTSTRAP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const WATCH_RENEW_THRESHOLD_MS = 12 * 60 * 60 * 1000;

interface AgentSync {
  id: string;
  email: string;
  sync_token: string | null;
  watch_channel_id: string | null;
  watch_resource_id: string | null;
  watch_expiration: string | null;
}

async function loadAgent(userId: string): Promise<AgentSync | null> {
  const { data } = await supabaseAdmin()
    .from("users")
    .select(
      "id, email, sync_token, watch_channel_id, watch_resource_id, watch_expiration",
    )
    .eq("id", userId)
    .maybeSingle();
  return (data as AgentSync | null) ?? null;
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

/** Upsert/delete gcal-sourced busy blocks for a batch of synced events. */
async function applyEvents(userId: string, events: GoogleEvent[]): Promise<void> {
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
        source: "gcal",
        starts_at: win!.start,
        ends_at: win!.end,
      },
      { onConflict: "user_id,gcal_event_id" },
    );
  }
}

/** Pulls calendar changes into busy_blocks for one agent (via delegation). */
export async function runIncrementalSync(userId: string): Promise<number> {
  const agent = await loadAgent(userId);
  if (!agent?.email) return 0;

  const bootstrapMin = new Date(
    Date.now() - BOOTSTRAP_LOOKBACK_MS,
  ).toISOString();

  let result;
  try {
    result = await syncEvents(agent.email, agent.sync_token, bootstrapMin);
  } catch (err: unknown) {
    if (err instanceof SyncTokenExpired) {
      result = await syncEvents(agent.email, null, bootstrapMin);
    } else {
      throw err;
    }
  }

  await applyEvents(userId, result.events);

  if (result.nextSyncToken) {
    await supabaseAdmin()
      .from("users")
      .update({ sync_token: result.nextSyncToken })
      .eq("id", userId);
  }
  return result.events.length;
}

/** Outcome of an ensureWatch attempt — never throws, so callers can surface it. */
export type WatchResult =
  | { status: "skipped"; reason: string }
  | { status: "current"; expiration: string | null }
  | { status: "renewed"; expiration: string | null }
  | { status: "error"; error: string };

/**
 * Registers/renews a push watch channel (skips on non-public-HTTPS app URLs).
 * Returns a status instead of throwing so the cron/admin can report whether
 * push is actually live rather than failing silently.
 */
export async function ensureWatch(userId: string): Promise<WatchResult> {
  const pushUrl = googlePushUrl();
  if (!pushUrl.startsWith("https://") || pushUrl.includes("localhost")) {
    return { status: "skipped", reason: "non-public-https-app-url" };
  }

  const agent = await loadAgent(userId);
  if (!agent?.email) return { status: "skipped", reason: "no-agent-email" };

  const expiresSoon =
    !agent.watch_expiration ||
    Date.parse(agent.watch_expiration) - Date.now() < WATCH_RENEW_THRESHOLD_MS;
  if (!expiresSoon) {
    return { status: "current", expiration: agent.watch_expiration };
  }

  try {
    if (agent.watch_channel_id && agent.watch_resource_id) {
      try {
        await stopChannel(agent.email, agent.watch_channel_id, agent.watch_resource_id);
      } catch {
        // already gone
      }
    }

    const channelId = nanoid();
    const { resourceId, expiration } = await watchCalendar(agent.email, channelId);
    await supabaseAdmin()
      .from("users")
      .update({
        watch_channel_id: channelId,
        watch_resource_id: resourceId,
        watch_expiration: expiration,
      })
      .eq("id", userId);
    return { status: "renewed", expiration };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Resolves a Google push channelId back to the owning user. */
export async function userIdForChannel(
  channelId: string,
): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from("users")
    .select("id")
    .eq("watch_channel_id", channelId)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
