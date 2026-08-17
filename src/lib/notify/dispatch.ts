import { supabaseAdmin } from "@/lib/supabase/admin";
import { chunkIdsByUrlBudget } from "@/lib/db/id-batch";
import { postSlack, slackConfigured } from "@/lib/notify/slack";
import { shouldSendAlert, alertStampMs } from "@/lib/notify/alerts";
import { parseStampMs } from "@/lib/date/stamp";
import { defaultInfoChannel } from "@/lib/notify/channels";
import { log } from "@/lib/log";
import { isWorkersRuntime, workersRuntimeMarker } from "@/lib/platform/runtime";

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

/**
 * Deliberate opt-in for sending alerts from OFF the Workers runtime (#1537).
 *
 * Off by default, and the default is the safe one on purpose: forgetting to set this
 * produces silence from a laptop, while forgetting to UNSET it produces the state this whole
 * guard exists to prevent (L72). It is here so somebody testing alert wiring locally has a
 * deliberate way to do it, rather than reaching for a code change they might forget to undo.
 */
const OFFPLATFORM_OPT_IN = "SLATE_ALLOW_OFFPLATFORM_ALERTS";

/**
 * May this process WRITE an alert? (#1537)
 *
 * `.env.local` points a dev server at the LIVE Supabase project and the LIVE Slack channel,
 * so anything a laptop raises reaches whoever is on call. On 2026-08-17 that cost an
 * afternoon: `rate_limit_broken:availability` paged claiming the only abuse control on the
 * public availability endpoint was off, and production's limiter had been enforcing
 * correctly the whole time. #1530 gated that one alert; this is the class (L30).
 *
 * TWO harms, and the second is the quieter one. A dev server also writes `alert_state`, so it
 * burns the cooldown and a genuine production occurrence inside that window is silently
 * suppressed. And a dev server calling `resolveAlert` can CLEAR a live page, which is worse
 * than raising a false one: the page goes away and the condition does not.
 *
 * Scoped to WRITES. Reads stay open, because reading alert state from a laptop is useful and
 * harms nothing.
 *
 * It does NOT silence the canary or the deploy-failure notifier, which legitimately alert
 * from GitHub Actions: those post through `postSlack` directly and never reach this module.
 * That was checked rather than assumed before this gate was added.
 */
function mayWriteAlerts(key: string, what: string): boolean {
  if (isWorkersRuntime()) return true;
  if ((process.env[OFFPLATFORM_OPT_IN] ?? "") !== "") return true;
  // Never silent, and it names the key so a developer can see WHICH alert their local run
  // would have sent, rather than wondering why nothing happened.
  log.warn("alert-dispatch", {
    msg: "not running on the Cloudflare runtime, so this alert was not sent",
    key,
    withheld: what,
    runtime: workersRuntimeMarker(),
    opt_in: OFFPLATFORM_OPT_IN,
  });
  return false;
}

export async function sendThrottledAlert(
  key: string,
  cooldownMs: number,
  text: string,
  channel?: string,
): Promise<void> {
  if (!mayWriteAlerts(key, "page")) return;
  if (!slackConfigured()) return;
  const db = supabaseAdmin();
  const { data } = await db
    .from("alert_state")
    .select("last_sent_at")
    .eq("key", key)
    .maybeSingle();
  // #1169: fail closed. A corrupt last_sent_at used to parse to NaN, which
  // shouldSendAlert compared false against forever, permanently muting this
  // alert. Unreadable reads as "never sent" (null -> send), and the send then
  // overwrites the corrupt stamp with a fresh one.
  const lastSentAtMs = data
    ? parseStampMs((data as { last_sent_at: string }).last_sent_at)
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
 * Clear several conditions at once, at the cost of ONE read on the healthy tick
 * (#1151).
 *
 * `resolveAlert` reads `alert_state` per key to find out whether that key was
 * actually paging. Called for three or four keys from an every-minute lane, that
 * is three or four queries a minute spent almost always learning that nothing is
 * firing, on a subrequest budget four cron lanes share. This asks once, then
 * resolves only the keys that really have an outstanding page.
 *
 * Pass ONLY conditions the caller has MEASURED to be healthy this tick. A key
 * that could not be measured must not be in the list: clearing a page because a
 * check failed to run is the same defect as posting an all-clear off a query that
 * errored (#1134, #1152).
 *
 * Best-effort and never throws: a monitoring problem must not fail the lane it
 * rides on. A failed read resolves nothing and the next tick retries, because the
 * firing markers survive.
 */
export async function resolveRecovered(
  recovered: { key: string; text: string }[],
): Promise<string[]> {
  if (recovered.length === 0) return [];
  const firing = await existingAlertStateKeys(recovered.map((r) => firingKey(r.key))).catch(
    () => new Set<string>(),
  );
  const cleared: string[] = [];
  for (const r of recovered) {
    if (!firing.has(firingKey(r.key))) continue;
    const sent = await resolveAlert(r.key, r.text).catch((err) => {
      // One key's failed notice must not skip the rest; the marker survives, so
      // the next tick retries.
      log.error("slack-alert", { msg: "recovery notice failed", key: r.key }, err);
      return false;
    });
    if (sent) cleared.push(r.key);
  }
  return cleared;
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
  // The worst of the three to let a laptop do: clearing a live page leaves the condition
  // true and the page gone.
  if (!mayWriteAlerts(key, "all-clear")) return false;
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
 * Drop the state behind several pages WITHOUT posting an all-clear for each one.
 *
 * For the ONE case where the notice a reader needs has already been sent by
 * something else: a set of narrow pages superseded by a single broader page that
 * covers them (the empty-bucket sweep folding sixty per-bucket pages into one).
 * Resolving them the normal way would post sixty all-clears to announce that
 * sixty pages became one, which is the flood it is trying to stop.
 *
 * This is NOT a way to make an unwanted page go away. A condition still true, with
 * its marker deleted, pages again on the next tick and its eventual recovery
 * notice is lost, so the reader is told it broke twice and never that it ended.
 * Use it only when the replacement notice is going out in the same breath.
 *
 * Best-effort and never throws, but a failure is LOGGED rather than swallowed: a
 * marker left behind is exactly the flood this prevents, one tick later.
 */
export async function settleAlertsSilently(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  // Deletes the firing markers and the cooldown rows, so a laptop running this would leave a
  // real page able to re-fire immediately and its recovery notice never sent.
  if (!mayWriteAlerts(keys[0] ?? "(none)", `silent settle of ${keys.length} key(s)`)) return;
  const db = supabaseAdmin();
  // Both rows per key: the firing marker (so no recovery notice fires later) and
  // the cooldown row (so a genuinely new page is not muted by the old cooldown),
  // matching what resolveAlert deletes after a delivered notice.
  const rows = [...keys.map(firingKey), ...keys];
  // Chunked by measured BYTES, not by a row count (#1321). The keys ride in the
  // request URL and an oversized `in` filter is REFUSED at the transport rather
  // than merely slow. A count would be the more dangerous choice here than most:
  // these are not fixed-width uuids but composed keys whose length depends on the
  // feature that raised them (`alert_firing:availability_drift:411`), so any count
  // is calibrated against whichever caller was in mind when it was written.
  for (const batch of chunkIdsByUrlBudget(rows)) {
    const { error } = await db.from("alert_state").delete().in("key", batch);
    if (error) {
      log.warn("slack-alert", {
        msg: "silent settle failed",
        keys: batch.length,
        error: error.message,
      });
    }
  }
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
