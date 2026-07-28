import { supabaseAdmin } from "@/lib/supabase/admin";
import { postSlack, slackConfigured } from "@/lib/notify/slack";
import { shouldSendAlert, alertStampMs } from "@/lib/notify/alerts";
import { defaultInfoChannel } from "@/lib/notify/channels";
import { log } from "@/lib/log";

/**
 * Post a Slack message at most once per cooldown for a given key, using the
 * `alert_state` table as the persistent cooldown (the cron runs every minute,
 * so a persistent fault must not spam). No-op when Slack is unconfigured.
 * `channel` defaults to the alerts channel; pass a quieter one for info signals.
 */
/**
 * The "this alert is currently firing" marker for `key` (#1133).
 *
 * Stored in `alert_state`, already a generic key-to-timestamp table with deny-all
 * RLS, so this needs no migration (same trick as the #1102 lane watchdog). The
 * prefix namespaces it away from the cooldown keys so the two can never collide.
 *
 * It is written only after a page is CONFIRMED delivered, which is the whole
 * point: a recovery notice may only claim something cleared if the reader was
 * actually told it broke.
 */
export const firingKey = (key: string) => `alert_firing:${key}`;

export async function sendThrottledAlert(
  key: string,
  cooldownMs: number,
  text: string,
  channel?: string,
): Promise<void> {
  if (!slackConfigured()) return;
  const db = supabaseAdmin();
  const { data } = await db
    .from("alert_state")
    .select("last_sent_at")
    .eq("key", key)
    .maybeSingle();
  const lastSentAtMs = data
    ? Date.parse((data as { last_sent_at: string }).last_sent_at)
    : null;
  const nowMs = Date.now();
  if (!shouldSendAlert(lastSentAtMs, nowMs, cooldownMs)) return;

  const result = await postSlack({ text, ...(channel ? { channel } : {}) });
  // Fail loud (#1035): a not-ok send used to be invisible AND burned the full
  // cooldown, silently muting this alert for 15-60+ min. Surface it in the logs
  // (the paging channel can't page about itself) and stamp only a short retry
  // window so the every-minute cron re-attempts soon. A stamp still goes down on
  // failure so a hard-down Slack can't be spammed; it's just a shorter mute.
  if (!result.ok) {
    log.warn("slack-alert", { msg: "send failed", key, error: result.error ?? null });
  }
  await db
    .from("alert_state")
    .upsert(
      { key, last_sent_at: new Date(alertStampMs(result.ok, nowMs, cooldownMs)).toISOString() },
      { onConflict: "key" },
    );
  // #1133: remember that this alert is firing, so `resolveAlert` can say when it
  // clears. Only on a delivered send: a page nobody received must never produce a
  // "recovered" message out of nowhere.
  if (result.ok) {
    await db
      .from("alert_state")
      .upsert(
        { key: firingKey(key), last_sent_at: new Date(nowMs).toISOString() },
        { onConflict: "key" },
      );
  }
}

/**
 * Whether a page for `key` was delivered and has not been cleared (#1134).
 *
 * Lets a caller skip the work of PROVING health when there is no outstanding alert
 * to clear: establishing health can cost real reads, and on the overwhelmingly
 * common healthy tick there is nothing to say. One cheap indexed read.
 *
 * Fails CLOSED (returns false on a read error): the cost of a wrong `false` is a
 * recovery notice deferred one tick, while a wrong `true` would send callers off to
 * do work whose result they cannot trust.
 */
export async function isAlertFiring(key: string): Promise<boolean> {
  const db = supabaseAdmin();
  // error-ok: a read error defers the recovery notice one tick; it can never invent
  // a recovery, and the marker survives for the next attempt.
  const { data } = await db
    .from("alert_state")
    .select("last_sent_at")
    .eq("key", firingKey(key))
    .maybeSingle();
  return data != null;
}

/**
 * `isAlertFiring` for a SET of keys, in one read (#1134).
 *
 * The lane watchdog watches roughly fifteen lanes, each with its own alert key,
 * and it runs on the every-minute sync lane. Asking per key would add fifteen
 * queries a minute to the tightest budget in the system: the four minute-lanes
 * share a single Worker invocation and its subrequest ceiling. This answers for
 * the whole set at once, so the overwhelmingly common healthy tick costs ONE read
 * and resolves nothing.
 *
 * Answers in the CALLER's key space, not the internal `alert_firing:` marker
 * space, so a caller cannot accidentally hand a prefixed key back to
 * `resolveAlert` and clear the wrong row.
 *
 * Fails CLOSED like `isAlertFiring`: an empty set on a read error. A wrong "not
 * firing" only defers a recovery notice by a tick and the markers survive, while a
 * wrong "firing" would send callers off to prove a health they cannot establish.
 */
export async function firingAlertKeys(keys: string[]): Promise<Set<string>> {
  const present = await existingAlertStateKeys(keys.map(firingKey));
  const firing = new Set<string>();
  for (const k of keys) if (present.has(firingKey(k))) firing.add(k);
  return firing;
}

/**
 * Which of these RAW `alert_state` keys exist, in one read (#1134).
 *
 * The generic form under `firingAlertKeys`, exported because `alert_state` holds
 * more than firing markers: the lane watchdog also keeps a "first noticed missing"
 * marker per never-stamped lane. Sharing one read lets a caller settle every
 * question it has about that table per tick instead of one query per key, which
 * matters because the watchdog runs on the every-minute lane.
 *
 * Fails CLOSED (an empty set on a read error). Every caller treats "not present"
 * as "do nothing", so a failed read defers work by a tick rather than inventing it.
 */
export async function existingAlertStateKeys(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  // cap-safe: bounded by `keys`, a caller-supplied list (the lane roster), never a
  // growth table.
  // error-ok: an empty set on error defers the work one tick; it can never invent a
  // recovery, and the rows survive for the next attempt.
  const { data, error } = await supabaseAdmin()
    .from("alert_state")
    .select("key")
    .in("key", keys);
  if (error) {
    log.warn("slack-alert", { msg: "alert-state key read failed", keys: keys.length });
    return new Set();
  }
  return new Set(((data ?? []) as { key: string }[]).map((r) => r.key));
}

/**
 * Announce that a previously-paged condition has CLEARED (#1133), then reset it.
 *
 * A no-op unless a page for `key` was actually delivered, so this can be called
 * unconditionally from the every-minute lane that watches the condition. On a
 * delivered notice it clears the firing marker AND the cooldown row: the incident
 * is over, so a genuinely new one should page immediately rather than being muted
 * for the remainder of the old cooldown.
 *
 * Fails loud and RETRIES rather than losing the notice: a failed Slack send keeps
 * the marker and logs, so the next tick tries again. Returns whether the notice
 * went out, so callers can log it.
 */
export async function resolveAlert(
  key: string,
  text: string,
  channel?: string,
): Promise<boolean> {
  if (!slackConfigured()) return false;
  const db = supabaseAdmin();
  // error-ok: a read error defers the recovery notice to the next tick, which is
  // safe (the marker survives); it can never invent a recovery that didn't happen.
  const { data } = await db
    .from("alert_state")
    .select("last_sent_at")
    .eq("key", firingKey(key))
    .maybeSingle();
  if (!data) return false;

  const result = await postSlack({ text, ...(channel ? { channel } : {}) });
  if (!result.ok) {
    log.warn("slack-alert", {
      msg: "recovery notice send failed",
      key,
      error: result.error ?? null,
    });
    return false;
  }
  await db.from("alert_state").delete().eq("key", firingKey(key));
  await db.from("alert_state").delete().eq("key", key);
  return true;
}

/**
 * Low-priority, visibility-only variant (#567): same throttle, but posts to the
 * info channel so it never pages the alerts channel. The info channel is now
 * UI-tunable (#571): store > env, falling back to the resolved alerts channel so
 * the signal is never silently lost. Still no-ops when nothing is configured.
 */
export async function sendThrottledInfo(
  key: string,
  cooldownMs: number,
  text: string,
): Promise<void> {
  const channel = await defaultInfoChannel();
  if (!channel) return;
  await sendThrottledAlert(key, cooldownMs, text, channel);
}
