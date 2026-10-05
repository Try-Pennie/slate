import { reportWriteFailure } from "@/lib/db/result";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { chunkIdsByUrlBudget, inIdChunks } from "@/lib/db/id-batch";
import { selectAllPages } from "@/lib/supabase/paginate";
import { postSlack, slackConfigured } from "@/lib/notify/slack";
import { shouldSendAlert, alertStampMs } from "@/lib/notify/alerts";
import { parseStampMs } from "@/lib/date/stamp";
import { defaultInfoChannel } from "@/lib/notify/channels";
import { log } from "@/lib/log";
import { noteAlertKey } from "@/lib/notify/alert-recording";
import { isWorkersRuntime, workersRuntimeMarker } from "@/lib/platform/runtime";
import { isLoadtest } from "@/lib/loadtest-guard";
import type { AlertResolve, ThrottledNotify } from "@/lib/monitor/alert-deps";

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
export function mayWriteAlerts(key: string, what: string): boolean {
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

/**
 * What a single-row read of `alert_state` saw, kept whole so a later conditional
 * write can name the exact stamp it is replacing (#3170). `unreadable` is a read
 * that errored, which is not the same as a row that is not there.
 */
type StampRead =
  | { kind: "absent" }
  | { kind: "present"; raw: string; ms: number | null }
  | { kind: "unreadable" };

async function readStamp(rowKey: string): Promise<StampRead> {
  const { data, error } = await supabaseAdmin()
    .from("alert_state")
    .select("last_sent_at")
    .eq("key", rowKey)
    .maybeSingle();
  if (error) return { kind: "unreadable" };
  if (!data) return { kind: "absent" };
  const raw = (data as { last_sent_at: string }).last_sent_at;
  return { kind: "present", raw, ms: parseStampMs(raw) };
}

/**
 * Whether `key`'s cooldown has elapsed at `nowMs`, so a send now would go out.
 * The one cooldown read, used by `sendThrottledAlert` itself and by a caller that
 * must not spend reads building a message the throttle would drop (PR #2883, the
 * race whisper's fortnight of bookings), so the two can never disagree.
 *
 * Fails toward DUE on a read error or an unreadable stamp, the side the send has
 * always taken: a lost cooldown costs a duplicate message, a swallowed one mutes it.
 */
export async function isAlertDue(key: string, cooldownMs: number, nowMs: number): Promise<boolean> {
  return stampIsDue(await readStamp(key), cooldownMs, nowMs);
}

// #1169: fail closed. A corrupt last_sent_at used to parse to NaN, which
// shouldSendAlert compared false against forever, permanently muting this alert.
// Unreadable reads as "never sent" (null -> send), and the send then overwrites the
// corrupt stamp with a fresh one. A refused read (#2542) also reads as never sent:
// a lost cooldown costs a duplicate page, a swallowed one would mute the alert.
function stampIsDue(seen: StampRead, cooldownMs: number, nowMs: number): boolean {
  return shouldSendAlert(seen.kind === "present" ? seen.ms : null, nowMs, cooldownMs);
}

/**
 * The outcome of claiming a send before posting it (#3170).
 *
 * `won`: this sender, and no other, may post. `lost`: another sender moved the row
 * after this one read it, so posting would repeat its message. `unclaimed`: the
 * claim could not be MADE (the read or the write errored, or the condition failed
 * with the stamp unmoved), which is not a lost race, so the send goes ahead as it
 * did before claims existed. That keeps the old failure direction: a broken
 * `alert_state` costs a duplicate message, never a muted one.
 */
type Claim = "won" | "lost" | "unclaimed";

/**
 * Replace the row `seen` describes with `stampIso`, but only if it is still what
 * `seen` saw: an insert the primary key refuses when somebody else wrote the row
 * first, or an update filtered on the exact stamp that was read. Of two concurrent
 * callers that read the same row, exactly one can win.
 *
 * Postgres decides the race, never this process, which is the point: two Worker
 * invocations share nothing else.
 */
async function claimRow(
  rowKey: string,
  seen: StampRead,
  stampIso: string,
  opts: { reclaimIfDeleted: boolean },
): Promise<Claim> {
  if (seen.kind === "unreadable") return "unclaimed";
  const db = supabaseAdmin();
  if (seen.kind === "absent") {
    const { error } = await db.from("alert_state").insert({ key: rowKey, last_sent_at: stampIso });
    if (!error) return "won";
    // 23505 is the primary key refusing: somebody wrote this row after the read.
    if ((error as { code?: string }).code === "23505") return "lost";
    return claimFailed(rowKey, error.message);
  }
  const { data, error } = await db
    .from("alert_state")
    .update({ last_sent_at: stampIso })
    .eq("key", rowKey)
    .eq("last_sent_at", seen.raw)
    .select("key");
  if (error) return claimFailed(rowKey, error.message);
  if ((data ?? []).length > 0) return "won";
  // Nothing matched. A lost race moved the stamp (or removed the row); a filter that
  // cannot match the stamp it was handed leaves it exactly where the read found it.
  // Only the first is a reason to stay quiet, so look before deciding (L93).
  const after = await readStamp(rowKey);
  // Unable to look is not evidence of a lost race either, so the send goes ahead.
  if (after.kind === "unreadable") return claimFailed(rowKey, "re-read after an unmatched claim failed");
  if (after.kind === "present" && (after.raw === seen.raw || (after.ms !== null && after.ms === seen.ms))) {
    log.warn("slack-alert", {
      msg: "send claim matched nothing with the stamp unmoved; sending unclaimed",
      key: rowKey,
    });
    return "unclaimed";
  }
  // The row is GONE: an all-clear deleted the cooldown between this read and the
  // claim. For a page that is not a lost race, since nobody posted this page, so the
  // claim is retried as an insert, whose primary key still arbitrates between
  // concurrent senders. For an all-clear a missing marker means another resolver
  // already cleared it, and re-creating it would announce the recovery twice.
  if (after.kind === "absent" && opts.reclaimIfDeleted) return claimRow(rowKey, after, stampIso, opts);
  return "lost";
}

/** A claim write that errored: not a lost race, so the send goes ahead, and says so. */
function claimFailed(rowKey: string, error: string): Claim {
  log.warn("slack-alert", { msg: "send claim failed; sending unclaimed", key: rowKey, error });
  return "unclaimed";
}

/** `ms` as a stamp, nudged off `seen` so a claim never writes the value it replaces. */
function claimStampIso(ms: number, seen: StampRead): string {
  const clash = seen.kind === "present" && seen.ms === ms;
  return new Date(clash ? ms - 1 : ms).toISOString();
}

export async function sendThrottledAlert(
  key: string,
  cooldownMs: number,
  text: string,
  channel?: string,
): Promise<void> {
  await sendThrottledAlertUnrecorded(key, cooldownMs, text, channel);
  // Noted only once the send RETURNED (#3133 follow-up, see alert-recording.ts): a
  // page sent, held back by its cooldown or dropped by an unconfigured Slack is the
  // owner's word on the matter; a send that threw is nobody's.
  noteAlertKey(key);
}

async function sendThrottledAlertUnrecorded(
  key: string,
  cooldownMs: number,
  text: string,
  channel?: string,
): Promise<void> {
  // Refused BEFORE anything is posted (2026-09-24). A missing cooldown compares
  // as "due", so the page went out and only then did the stamp throw on
  // `new Date(NaN)`, leaving no record and re-sending on every tick. Throwing
  // here lands in the caller's failure boundary, which pages once, on its own
  // cooldown, with this sentence as the reason.
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    throw new Error(`${key} has no usable cooldown (${String(cooldownMs)}), so it was not sent`);
  }
  if (!mayWriteAlerts(key, "page")) return;
  // #3104: a load run never posts (Slack refuses it, #2335), but its fault pass is
  // judged on whether the page WOULD have gone out, once, on its cooldown. So under
  // SLATE_LOADTEST the throttle runs exactly as it does in production and the page
  // is recorded in `alert_state` instead of sent, which is the only trace the load
  // run's judge can read. Production never reaches the branch: the flag is set on
  // `env.loadtest` alone.
  const loadtest = isLoadtest();
  if (!slackConfigured() && !loadtest) return;
  const db = supabaseAdmin();
  const nowMs = Date.now();
  const seen = await readStamp(key);
  if (!stampIsDue(seen, cooldownMs, nowMs)) return;

  // #3170: claim the send BEFORE posting, so two overlapping runs of one lane post
  // one page between them rather than one each. The claim is written as the SHORT
  // retry stamp a failed send leaves, and lengthened to the full cooldown only once
  // Slack confirms delivery below. So whatever goes wrong after the claim (the post
  // fails, throws, or the invocation dies mid post) the page is held off for
  // minutes, never for the whole cooldown (L368).
  const claim = await claimRow(key, seen, claimStampIso(alertStampMs(false, nowMs, cooldownMs), seen), {
    reclaimIfDeleted: true,
  });
  if (claim === "lost") return;

  if (loadtest) {
    log.warn("slack-alert", { msg: "load test page recorded, not sent", key });
    // write-ok: a refused stamp leaves no cooldown, so the page is recorded again next
    // tick, and the load run's judge reads a second send as an unthrottled alert,
    // which is the loud direction. No firing marker: nobody was told, so no all
    // clear is owed (#1133).
    await db
      .from("alert_state")
      .upsert(
        { key, last_sent_at: new Date(alertStampMs(true, nowMs, cooldownMs)).toISOString() },
        { onConflict: "key" },
      );
    return;
  }

  const result = await postSlack({ text, ...(channel ? { channel } : {}) });
  // Fail loud (#1035): a not-ok send used to be invisible AND burned the full
  // cooldown, silently muting this alert for 15-60+ min. Surface it in the logs
  // (the paging channel can't page about itself) and stamp only a short retry
  // window so the every-minute cron re-attempts soon. A stamp still goes down on
  // failure so a hard-down Slack can't be spammed; it's just a shorter mute.
  if (!result.ok) {
    log.warn("slack-alert", { msg: "send failed", key, error: result.error ?? null });
  }
  // write-ok: a refused stamp leaves the claim's short retry window (or no cooldown at all, unclaimed), so the alert re-sends within minutes. Repeating a page is the safe direction; a stamp that landed wrongly would mute one.
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
    // write-ok, and REPORTED (#2482): a refused upsert leaves no firing marker, so
    // when this condition ends `resolveAlert` has nothing to clear and the all clear
    // is never sent. The page still repeats on its cooldown, so the reader is not left
    // believing it is over; they are left without the sentence saying so, which is why
    // it is logged rather than swallowed.
    reportWriteFailure(
      await db
      .from("alert_state")
      .upsert(
        { key: firingKey(key), last_sent_at: new Date(nowMs).toISOString() },
        { onConflict: "key" },
      ),
      "alert firing marker",
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
  // The raw read below throws on a refused request (#2756); this wrapper keeps its
  // documented fail closed answer, and says so in the log rather than in silence.
  const present = await existingAlertStateKeys(keys.map(firingKey)).catch((err) => {
    log.warn("slack-alert", { msg: "alert-state key read failed", keys: keys.length }, err);
    return new Set<string>();
  });
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
 * THROWS on a read error (#2756), and every caller decides its own safe side:
 * `firingAlertKeys`, `resolveRecovered` and the lane watchdog catch it and do
 * nothing this tick, and the off site origin check reports its dedupe read as
 * unreadable. It used to answer an empty set, which reads exactly like "none of
 * these exist" (L215), and now that one call can be several requests that would
 * also let a merge of the chunks that worked pass for the whole answer.
 *
 * Split by URL size, not by a count (#2756). The keys ride in the query string,
 * and the off site origin check asks about one key per recent booking, so the list
 * grows with booking volume; one unchunked filter past PostgREST's URL ceiling is
 * refused outright. Alert keys are strings of every length (a lane name, a family
 * prefix plus a booking uuid), which is why `inIdChunks` measures each key's
 * encoded length rather than assuming one. A failure in any chunk throws, naming
 * how many chunks had finished, so no partial set is ever returned.
 */
export async function existingAlertStateKeys(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const chunks = await inIdChunks("alert_state key read", keys, async (chunk) => {
    // Bounded by `chunk`: a membership read on alert_state's primary key returns at
    // most one row per key asked about, however large the table grows (#2726).
    const { data, error } = await supabaseAdmin()
      .from("alert_state")
      .select("key")
      .in("key", chunk);
    if (error) throw new Error(`alert_state key read failed: ${error.message}`);
    return ((data ?? []) as { key: string }[]).map((r) => r.key);
  });
  return new Set(chunks.flat());
}

/**
 * The members of a `family:*` alert that have an outstanding page, in one read
 * (#2593). Answers the part after `family:`, never a marker key.
 *
 * For a family keyed by something that can VANISH, a booking that is cancelled
 * or whose time passes: once it drops out of the read that found it, nothing else
 * can name it, so its page would never clear. The markers themselves are the only
 * record of who was paged.
 *
 * THROWS on a read error, unlike its siblings above. Its one caller treats a
 * throw as "clear nothing this tick", which is the same safe outcome, and an
 * exception cannot be mistaken for a family with nobody firing.
 */
export async function firingFamilyMembers(family: string): Promise<string[]> {
  const prefix = firingKey(`${family}:`);
  // `_` is a LIKE wildcard, and alert keys are full of them, so it is escaped;
  // the startsWith below is the real filter either way.
  const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // Paged, never one capped read (#2726). A family keyed by booking grows with
  // booking volume, not with the roster, so a single read would return the first
  // 1,000 markers and stop: every member past them would never be cleared and the
  // family would read as smaller than it is. Ordered by key so the pages are
  // stable. selectAllPages throws on a failed page, which keeps the contract below.
  const rows = await selectAllPages<{ key: string }>(`alert_state family ${family}`, "key", () =>
    supabaseAdmin().from("alert_state").select("key").like("key", pattern),
  );
  return rows
    .map((r) => r.key)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
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
    (err) => {
      // The read throws rather than answering empty (#2756), so the failure is
      // logged here, where the decision to resolve nothing this tick is made.
      log.warn("slack-alert", { msg: "alert-state key read failed; recovery deferred", keys: recovered.length }, err);
      return new Set<string>();
    },
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
  // A read error defers the recovery notice to the next tick, which is safe (the
  // marker survives); it can never invent a recovery that didn't happen.
  const seen = await readStamp(firingKey(key));
  if (seen.kind !== "present") return false;

  // #3170: claim the all-clear before posting it, by re-stamping the marker on the
  // condition that it still holds the stamp just read. Two overlapping resolvers post
  // one notice between them, and an older run cannot clear a page that a newer run
  // delivered after it looked (a delivered page re-stamps the marker, so the
  // condition fails). The marker stays until the notice is delivered, so a post that
  // fails, throws or never finishes leaves it for the next tick to retry (L368).
  const claimIso = claimStampIso(Date.now(), seen);
  const claim = await claimRow(firingKey(key), seen, claimIso, { reclaimIfDeleted: false });
  if (claim === "lost") return false;

  const result = await postSlack({ text, ...(channel ? { channel } : {}) });
  if (!result.ok) {
    log.warn("slack-alert", {
      msg: "recovery notice send failed",
      key,
      error: result.error ?? null,
    });
    return false;
  }
  // Cleared only while it still carries THIS claim: a page delivered while the notice
  // was in flight re-stamped it, and that page is still open, so its marker and its
  // cooldown both stay. An unclaimed notice clears unconditionally, as every notice
  // did before claims existed.
  const clear = db.from("alert_state").delete().eq("key", firingKey(key));
  const cleared = await (claim === "won" ? clear.eq("last_sent_at", claimIso) : clear).select("key");
  // write-ok, and REPORTED (#2482): a refused delete leaves the firing marker, so
  // this condition reads as still firing and a later resolve clears it. It cannot
  // produce a recovery notice for something that never fired.
  reportWriteFailure(cleared, "alert firing marker clear");
  // The notice went out, but a newer page owns the marker now; its cooldown stays too.
  if (!cleared.error && (cleared.data ?? []).length === 0) return true;
  // write-ok, and REPORTED (#2482): a refused delete leaves the cooldown stamp, so
  // the NEXT page on this key is muted for the rest of its window. That is a real
  // cost and it expires on its own, so it is tolerated and logged rather than raised.
  reportWriteFailure(
    await db.from("alert_state").delete().eq("key", key),
    "alert cooldown clear",
  );
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
  // Noted on return by the same rule as a page (see alert-recording.ts), including
  // the return with no info channel set, which drops the message exactly as an
  // unconfigured Slack does. A throw (the channel read, or the send) notes nothing.
  if (channel) await sendThrottledAlert(key, cooldownMs, text, channel);
  noteAlertKey(key);
}

/**
 * The seam every check declares (`src/lib/monitor/alert-deps.ts`, #2572) must fit the
 * functions above, or the first wiring site that hands one over by reference would be
 * the only place to say so, and only about itself. Type only: `Fits` collapses to
 * `never` when a function stops fitting, and `true` is not assignable to `never`.
 * It lives here rather than beside the seam because naming `typeof sendThrottledAlert`
 * anywhere else reads to the alert recovery coverage guard as a wiring site.
 */
type Fits<Fn, Seam> = Fn extends Seam ? true : never;
export const dispatcherFitsSeams: Fits<typeof sendThrottledAlert, ThrottledNotify> &
  Fits<typeof sendThrottledInfo, ThrottledNotify> &
  Fits<typeof resolveAlert, AlertResolve> = true;
