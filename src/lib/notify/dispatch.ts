import { reportWriteFailure } from "@/lib/db/result";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { chunkIdsByUrlBudget, inIdChunks } from "@/lib/db/id-batch";
import { selectAllPages } from "@/lib/supabase/paginate";
import { postSlack, slackConfigured } from "@/lib/notify/slack";
import { shouldSendAlert, alertStampMs, pageCarriesNews } from "@/lib/notify/alerts";
import { parseStampMs } from "@/lib/date/stamp";
import { defaultInfoChannel } from "@/lib/notify/channels";
import { log } from "@/lib/log";
import { noteAlertKey } from "@/lib/notify/alert-recording";
import { isWorkersRuntime, workersRuntimeMarker } from "@/lib/platform/runtime";
import { isLoadtest } from "@/lib/loadtest-guard";
import type { AlertResolve, ThrottledNotify } from "@/lib/monitor/alert-deps";
import {
  changeBatchMs,
  formatReminder,
  freshSubjects,
  heldForBatch,
  isRepeatRuled,
  reminderIntervalMs,
  repeatChange,
  subjectsFor,
  type AlertRepeat,
  type RepeatChange,
} from "@/lib/notify/repeat-policy";
import {
  clearNeedsSubjects,
  foldFor,
  foldMarkKey,
  judgeFold,
  marksOnClear,
  type FoldRead,
} from "@/lib/notify/alert-folds";
import { readAllHeartbeatMs } from "@/lib/monitor/heartbeat";
import { findStaleLanes, LANE_STALE_BOUNDS_MS, type LaneName } from "@/lib/monitor/health";
import { isChangeOnly } from "@/lib/notify/alert-catalog";
import { withSeverityLead, type AlertVoice } from "@/lib/notify/severity-lead";

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
 *
 * A delivered send stamps it and the cooldown row with ONE value (#3303): when the
 * page went out, or, for a page that carries `PageNews`, when its content was
 * measured. That shared stamp is how a cooldown a delivered page wrote is told
 * apart from a retry or claim hold, which only news may cut short.
 */
export const firingKey = (key: string) => `alert_firing:${key}`;

/**
 * What a page knows about how new its content is (#3303), so a page whose content
 * holds something the last delivered page could not have carried goes out at once,
 * inside the cooldown, while one with nothing new still waits it out.
 *
 * On 2026-10-05 the coverage give up page said 1 appointment and the rest of the
 * count landed inside its cooldown, so the reader acted on a number that was
 * already wrong and was never told.
 */
export interface PageNews {
  /** The newest moment anything the page reports became true; null when none is known. */
  newestMs: number | null;
  /**
   * When the page's content was measured: every read behind it began at or after
   * this. A delivered page is stamped with it rather than with when it was posted,
   * because a fact that became true between the read and the post is not in this
   * page and has to read as news to the next one.
   */
  asOfMs: number;
}

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
  | {
      kind: "present";
      raw: string;
      ms: number | null;
      /**
       * What the last post of a condition named and how bad it was (#3801), or null
       * when the row predates that rule or belongs to an alert without it.
       */
      subjects: string[] | null;
      band: number | null;
      /** When the condition was first posted (#3801), or null when not recorded. */
      openedMs: number | null;
    }
  | { kind: "unreadable" };

/** The `alert_state` row as read, columns from 0184 included (#3801). */
interface AlertStateRow {
  last_sent_at: string;
  subjects?: string[] | null;
  band?: number | null;
  opened_at?: string | null;
}

/**
 * Whether 0184's columns are missing from `alert_state` (#3801): a read naming them
 * answered Postgres's undefined column (42703). Remembered for the isolate, so the
 * fallback costs one wasted read rather than one per send.
 */
let repeatColumnsMissing = false;

/** Whether this isolate has found `alert_state` without 0184's columns. */
export function repeatColumnsAbsent(): boolean {
  return repeatColumnsMissing;
}

/** For tests: forget a previous finding. */
export function resetRepeatColumnsProbe(): void {
  repeatColumnsMissing = false;
}

async function readStamp(rowKey: string): Promise<StampRead> {
  const db = supabaseAdmin();
  const read = (columns: string) => db.from("alert_state").select(columns).eq("key", rowKey).maybeSingle();
  let { data, error } = repeatColumnsMissing
    ? await read("last_sent_at")
    : await read("last_sent_at, subjects, band, opened_at");
  // Code deployed ahead of migration 0184 (the deploy gate refuses that, so this is a
  // second line): read the stamp alone and run the old rule, rather than reading every
  // row as unreadable and posting every condition on every tick.
  if (error && (error as { code?: string }).code === "42703" && !repeatColumnsMissing) {
    repeatColumnsMissing = true;
    log.warn("slack-alert", { msg: "alert_state has no repeat columns (0184 not applied); repeats follow the cooldown alone" });
    ({ data, error } = await read("last_sent_at"));
  }
  if (error) return { kind: "unreadable" };
  if (!data) return { kind: "absent" };
  const row = data as unknown as AlertStateRow;
  return {
    kind: "present",
    raw: row.last_sent_at,
    ms: parseStampMs(row.last_sent_at),
    subjects: Array.isArray(row.subjects) ? row.subjects : null,
    band: typeof row.band === "number" && Number.isFinite(row.band) ? row.band : null,
    openedMs: parseStampMs(row.opened_at ?? null),
  };
}

/**
 * Whether `key`'s cooldown has elapsed at `nowMs`, so a send now would go out.
 * The one cooldown read, used by `sendThrottledAlert` itself and by a caller that
 * must not spend reads building a message the throttle would drop (PR #2883, the
 * race whisper's fortnight of bookings), so the two can never disagree.
 *
 * Fails toward DUE on a read error or an unreadable stamp, the side the send has
 * always taken: a lost cooldown costs a duplicate message, a swallowed one mutes it.
 *
 * For a condition it answers on the same reminder interval the send uses (#3801),
 * and it cannot see a CHANGE, which needs the message's subjects. So a caller that
 * skips building a message on "not due" forgoes the post a change would have made
 * inside the interval; use it only where the key itself is the whole subject (one
 * key per pool, per lane), so no other change can arrive on it.
 */
export async function isAlertDue(key: string, cooldownMs: number, nowMs: number): Promise<boolean> {
  const seen = await readStamp(key);
  return stampIsDue(seen, repeatColumnsMissing ? cooldownMs : reminderIntervalMs(key, cooldownMs), nowMs);
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
 * Whether `news` may cut `key`'s cooldown short (#3303); the rule is
 * `pageCarriesNews`. Asked only once the cooldown has held a page back, so a page
 * the ordinary rule already lets through costs no extra read.
 *
 * A marker that cannot be read is no news, which leaves the ordinary cooldown to
 * decide: the page still repeats on it, so this can delay an update by one cooldown
 * and never mutes the alert. Said out loud rather than skipped in silence.
 */
async function carriesNews(key: string, seen: StampRead, news: PageNews): Promise<boolean> {
  if (news.newestMs === null || seen.kind !== "present" || seen.ms === null) return false;
  const delivered = await readStamp(firingKey(key));
  if (delivered.kind === "unreadable") {
    log.warn("slack-alert", {
      msg: "the last delivered page could not be read, so news waits for the cooldown",
      key,
    });
    return false;
  }
  return pageCarriesNews(seen.ms, delivered.kind === "present" ? delivered.ms : null, news.newestMs);
}

/**
 * The stamp a DELIVERED page leaves on both rows: when its content was measured if
 * it says (#3303), otherwise now. Never later than now, since an anchor in the
 * future would hide every fact up to it; earlier only costs a re-page.
 */
function deliveredStampMs(news: PageNews | undefined, nowMs: number): number {
  if (!news || !Number.isFinite(news.asOfMs)) return nowMs;
  return Math.min(news.asOfMs, nowMs);
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
  opts: { reclaimIfDeleted: boolean; fields?: RepeatFields },
): Promise<Claim> {
  if (seen.kind === "unreadable") return "unclaimed";
  const db = supabaseAdmin();
  // #3801: a condition's claim also records what this post will say, so a second
  // sender that reads the row while this one is mid post sees these subjects as
  // already told and does not treat them as a change of its own. If the post then
  // fails, the claim's short retry stamp makes the page due again within minutes
  // whatever the subjects say, so recording them early can never mute it.
  const extra = opts.fields ?? {};
  if (seen.kind === "absent") {
    const { error } = await db.from("alert_state").insert({ key: rowKey, last_sent_at: stampIso, ...extra });
    if (!error) return "won";
    // 23505 is the primary key refusing: somebody wrote this row after the read.
    if ((error as { code?: string }).code === "23505") return "lost";
    return claimFailed(rowKey, error.message);
  }
  const { data, error } = await db
    .from("alert_state")
    .update({ last_sent_at: stampIso, ...extra })
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

/**
 * `news` (#3303) lets a page whose content holds something the last delivered page
 * could not have carried go out inside the cooldown; see `PageNews`. Without it the
 * cooldown is the only rule, exactly as before.
 */
export async function sendThrottledAlert(
  key: string,
  cooldownMs: number,
  text: string,
  opts: SendOptions = {},
): Promise<void> {
  await sendThrottled(key, cooldownMs, text, opts, "page");
}

/**
 * The one throttled send behind both senders. `voice` is which of them was called,
 * which decides only the lead line the post opens with (#1825): a whisper reads as
 * needing nothing even when the info channel falls back to the alerts channel.
 */
async function sendThrottled(
  key: string,
  cooldownMs: number,
  text: string,
  opts: SendOptions,
  voice: AlertVoice,
): Promise<void> {
  const outcome = await sendThrottledAlertUnrecorded(key, cooldownMs, text, opts, voice);
  // Noted only once the send RETURNED (#3133 follow-up, see alert-recording.ts): a
  // page sent, held back by its cooldown or dropped by an unconfigured Slack is the
  // owner's word on the matter; a send that threw is nobody's.
  noteAlertKey(key);
  opts.onOutcome?.(outcome);
}

/**
 * Everything a send may say beyond its key, interval and text.
 *
 * `subjects` and `band` (#3801) are what makes a CONDITION repeat once a day rather
 * than every cooldown while posting a change at once; see `AlertRepeat`. `channel`
 * picks a quieter channel for info signals. `news` is #3303's page news.
 */
export interface SendOptions extends AlertRepeat {
  channel?: string;
  news?: PageNews;
  /**
   * The message to post when this send is a CHANGE (a subject the last post did not name),
   * built from just those new subjects, so a post about new calls does not list again the
   * ones already said. The dispatcher works out what is new, so the message and the rule
   * that decided to post can never disagree about it (L342). Every other post (the first
   * of an episode, a retry after a failed send) carries `text`, which names everything.
   */
  textForFresh?: (fresh: readonly string[]) => string;
  /**
   * Told what the send did (#3801), for the one kind of caller that must act on it:
   * the canary's workflow hands its failure to the Worker and posts directly itself
   * unless the Worker sent or held it. A callback rather than a return value, so the
   * function keeps resolving to nothing and every injected seam stays as it is.
   */
  onOutcome?: (outcome: SendOutcome) => void;
}

/**
 * What one send did, for the rare caller that has to act on it (#3801: the canary's
 * workflow posts directly when the Worker could not), through `onOutcome`. `held` covers every throttled
 * outcome, including another sender having just posted the same page.
 */
export type SendOutcome = "sent" | "held" | "failed" | "skipped";

/** The columns a condition's post records about itself (#3801, migration 0184). */
interface RepeatFields {
  subjects?: string[];
  band?: number | null;
  opened_at?: string | null;
}

/**
 * Why a send went out, which decides what it SAYS. Only `reminder` changes the
 * text: an unchanged condition whose interval ran out, while the reader is known to
 * have been told (#3801). Everything else posts the message as it stands.
 */
type SendReason = "first" | "reminder" | "due" | RepeatChange | "news";

/**
 * The episode a due condition belongs to (#3801): whether this post is a reminder of
 * one the reader was told about, and when that condition was first posted.
 *
 * A reminder needs the cooldown row to have been written by a DELIVERED post, the
 * same shared stamp test as #3303's news: the firing marker and the cooldown row
 * carry one value only after a delivery, so a row holding a failed send's retry hold
 * or a claim is a retry, not a reminder. One extra read, and only on a tick that is
 * about to post, so the held tick (almost every tick) pays nothing for it.
 *
 * A marker that cannot be read gives a plain post rather than a reminder: a reader
 * told twice is the safe direction, and the post still goes out (fail loud).
 */
interface Episode {
  /** Nobody was told about this condition before (no firing marker), so it opens now. */
  fresh: boolean;
  /** The reader was told, and this post repeats that, so it carries the reminder line. */
  reminder: { sinceMs: number; atLeast: boolean } | null;
}

async function episodeOf(key: string, seen: StampRead & { kind: "present" }): Promise<Episode> {
  const marker = await readStamp(firingKey(key));
  if (marker.kind === "unreadable") {
    log.warn("slack-alert", { msg: "firing marker unreadable, so this repeat posts without the reminder line", key });
    return { fresh: false, reminder: null };
  }
  // No marker: nobody was told about this condition (a new episode, or every earlier
  // post failed), so it opens now.
  if (marker.kind === "absent") return { fresh: true, reminder: null };
  const delivered = marker.ms !== null && seen.ms !== null && marker.ms === seen.ms;
  if (!delivered || seen.ms === null) return { fresh: false, reminder: null };
  // A row from before 0184 has no opening moment, so the age is a floor measured from
  // the last delivered post, and the reminder says "at least".
  return {
    fresh: false,
    reminder:
      seen.openedMs !== null ? { sinceMs: seen.openedMs, atLeast: false } : { sinceMs: seen.ms, atLeast: true },
  };
}

/**
 * The stamps of a few named `alert_state` rows in ONE read, or null when the read
 * failed (#3802). A row that is not there is absent from the map; one whose stamp
 * cannot be parsed is present with a null stamp. A throw is a failed read too, never
 * a reason for the send to throw: the caller's safe side is to post.
 */
async function readStampsOf(keys: string[]): Promise<Map<string, number | null> | null> {
  try {
    // Bounded by `keys`: a membership read on alert_state's primary key returns at most
    // one row per key asked about, and the caller asks about three.
    const { data, error } = await supabaseAdmin().from("alert_state").select("key, last_sent_at").in("key", keys);
    if (error) return null;
    const out = new Map<string, number | null>();
    for (const row of (data ?? []) as { key: string; last_sent_at: string | null }[]) {
      out.set(row.key, parseStampMs(row.last_sent_at ?? null));
    }
    return out;
  } catch (err) {
    log.warn("slack-alert", { msg: "alert_state stamp read threw", keys: keys.length }, err);
    return null;
  }
}

/**
 * Whether `lane` is past its bound now, by the lane watchdog's own read and predicate,
 * so a fold and the page explaining it can never disagree about it. null when the read
 * fails or throws, which holds nothing.
 */
async function laneIsStopped(lane: LaneName, nowMs: number): Promise<boolean | null> {
  try {
    const heartbeats = await readAllHeartbeatMs();
    return findStaleLanes(heartbeats, nowMs, { [lane]: LANE_STALE_BOUNDS_MS[lane] }).length > 0;
  } catch (err) {
    log.warn("slack-alert", { msg: "lane heartbeat unreadable for a fold, so it posts as usual", lane }, err);
    return null;
  }
}

/**
 * Whether `key` waits because the alert that explains it is firing (#3802). The rule
 * is `judgeFold` (`src/lib/notify/alert-folds.ts`); this is its one read and its two
 * writes. Every key the fold table does not name answers false without a read.
 *
 * The three rows it needs (the explainer's firing marker, this key's own, and the
 * record of this key's hold) come back from one read, because a stale canary lane
 * reaches here on every minute tick of a CI stop, on a budget four cron lanes share.
 *
 * Fails toward POSTING: a read that fails or throws holds nothing, and a hold record
 * that cannot be written is logged and costs only the grace after the explainer
 * clears, which then posts at once.
 */
async function heldByFold(key: string, nowMs: number): Promise<boolean> {
  const fold = foldFor(key);
  if (!fold) return false;
  const explainerMark = firingKey(fold.explainer);
  const ownMark = firingKey(key);
  const holdMark = foldMarkKey(key);
  const stamps = await readStampsOf([explainerMark, ownMark, holdMark]);
  // A lane bound fold reads the lane only while its explainer is firing: otherwise it
  // can hold nothing, and the heartbeat read is spent only during an incident.
  const lane = fold.folded.onlyWhileLaneStopped;
  const laneStopped =
    lane !== undefined && stamps?.has(explainerMark) ? await laneIsStopped(lane, nowMs) : undefined;
  const read: FoldRead | null =
    stamps === null
      ? null
      : {
          explainerFiringMs: stamps.get(explainerMark) ?? null,
          ownFiring: stamps.has(ownMark),
          markMs: stamps.get(holdMark) ?? null,
          ...(laneStopped === undefined ? {} : { laneStopped }),
        };
  const decision = judgeFold(read, nowMs, fold.folded.graceMs, lane !== undefined);
  const db = supabaseAdmin();
  if (decision.act === "hold") {
    log.info("slack-alert", {
      msg:
        decision.why === "explained"
          ? "held: the alert that explains it is firing"
          : "held: waiting out its own bound after the alert that explained it cleared",
      key,
      explainer: fold.explainer,
      ...(decision.why === "grace" ? { until: new Date(decision.untilMs).toISOString() } : {}),
    });
    if (decision.why === "explained" && decision.refreshMark) {
      // REPORTED, not raised: without this record the grace after the explainer clears
      // is lost and the key posts at once, which is the loud direction.
      reportWriteFailure(
        await db
          .from("alert_state")
          .upsert({ key: holdMark, last_sent_at: new Date(nowMs).toISOString() }, { onConflict: "key" }),
        "alert fold mark",
      );
    }
    return true;
  }
  if (decision.why === "unreadable") {
    log.warn("slack-alert", { msg: "fold state unreadable, so this posts as usual", key, explainer: fold.explainer });
  }
  // The hold is over, so its record goes. One is also left behind when a held lane
  // comes back on its own (the all-clear path never reaches here), and that is inert:
  // the lane was stale at the record's moment, so it can only be stale again a full
  // bound after a LATER stamp, by when at most FOLD_MARK_REFRESH_MS of the record's
  // grace can remain. So a refused delete is only logged.
  if (stamps?.has(holdMark)) {
    reportWriteFailure(await db.from("alert_state").delete().eq("key", holdMark), "alert fold mark clear");
  }
  return false;
}

/**
 * Once an explainer's all-clear is delivered, stamp each key it explains as held now
 * (`marksOnClear`), so one coming true in the catch up waits its own grace rather than
 * posting fresh. Read before the clear deletes the explainer's row, for its subjects.
 * Every key outside the fold table pays nothing. A failed read marks no lane bound key
 * and a refused write is reported: both only let a key post sooner, the loud side.
 */
async function markExplainedOnClear(explainer: string): Promise<void> {
  let subjects: string[] | null = null;
  if (clearNeedsSubjects(explainer)) {
    const seen = await readStamp(explainer).catch(() => ({ kind: "unreadable" }) as const);
    subjects = seen.kind === "present" ? seen.subjects : null;
  }
  const keys = marksOnClear(explainer, subjects);
  if (keys.length === 0) return;
  const at = new Date().toISOString();
  reportWriteFailure(
    await supabaseAdmin()
      .from("alert_state")
      .upsert(
        keys.map((k) => ({ key: foldMarkKey(k), last_sent_at: at })),
        { onConflict: "key" },
      ),
    "alert fold mark on clear",
  );
}

async function sendThrottledAlertUnrecorded(
  key: string,
  cooldownMs: number,
  text: string,
  opts: SendOptions,
  voice: AlertVoice,
): Promise<SendOutcome> {
  const { channel, news } = opts;
  // Refused BEFORE anything is posted (2026-09-24). A missing cooldown compares
  // as "due", so the page went out and only then did the stamp throw on
  // `new Date(NaN)`, leaving no record and re-sending on every tick. Throwing
  // here lands in the caller's failure boundary, which pages once, on its own
  // cooldown, with this sentence as the reason.
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    throw new Error(`${key} has no usable cooldown (${String(cooldownMs)}), so it was not sent`);
  }
  if (!mayWriteAlerts(key, "page")) return "skipped";
  // #3104: a load run never posts (Slack refuses it, #2335), but its fault pass is
  // judged on whether the page WOULD have gone out, once, on its cooldown. So under
  // SLATE_LOADTEST the throttle runs exactly as it does in production and the page
  // is recorded in `alert_state` instead of sent, which is the only trace the load
  // run's judge can read. Production never reaches the branch: the flag is set on
  // `env.loadtest` alone.
  const loadtest = isLoadtest();
  if (!slackConfigured() && !loadtest) return "skipped";
  const db = supabaseAdmin();
  const nowMs = Date.now();
  // #3801: for a CONDITION the interval is when an unchanged fact may be said again
  // (a day, an hour when urgent, or a stored setting), and a change posts at once. For
  // anything else both of these are exactly what they were before.
  const seen = await readStamp(key);
  // Without 0184's columns there is nowhere to remember what was said, so the old rule
  // (the cooldown as handed over) runs and nothing is written to columns that are not there.
  const ruled = isRepeatRuled(key) && !repeatColumnsMissing;
  const intervalMs = ruled ? reminderIntervalMs(key, cooldownMs) : cooldownMs;
  const subjects = ruled ? subjectsFor(opts, text) : [];
  const band = ruled && typeof opts.band === "number" && Number.isFinite(opts.band) ? opts.band : null;
  const due = stampIsDue(seen, intervalMs, nowMs);
  // A change is judged whether or not the interval has run out, so a due post that
  // ALSO names something new is said as a new problem rather than as a reminder.
  const change: RepeatChange | null =
    ruled && seen.kind === "present" ? repeatChange({ subjects: seen.subjects, band: seen.band }, subjects, band) : null;
  let reason: SendReason;
  if (seen.kind !== "present") reason = "first";
  else if (change !== null) reason = change;
  else if (due) reason = "due";
  else if (news && (await carriesNews(key, seen, news))) reason = "news";
  else return "held";

  // A change only key with a batch window collects new subjects rather than posting each
  // as it appears (Dan, 2026-10-26), unless one is urgent. The last post's stamp is its
  // delivery moment; a failed send leaves a stamp a year back, so a retry is never held.
  const fresh = reason === "new-subject" && seen.kind === "present" ? freshSubjects(seen.subjects, subjects) : [];
  const batchMs = reason === "new-subject" ? changeBatchMs(key) : null;
  if (
    batchMs !== null &&
    seen.kind === "present" &&
    heldForBatch({ batchMs, lastPostMs: seen.ms, nowMs, fresh, urgent: opts.urgentSubjects ?? [] })
  ) {
    log.info("slack-alert", { msg: "held: new subjects wait for the batch", key, fresh: fresh.length });
    return "held";
  }

  // #3802: a key another alert explains waits while that one fires, and for its own
  // grace after. Asked only once this send would otherwise post, so a tick the throttle
  // already holds pays nothing for it, and only for a key the fold table names.
  if (await heldByFold(key, nowMs)) return "held";

  let posted = reason === "new-subject" && opts.textForFresh && fresh.length > 0 ? opts.textForFresh(fresh) : text;
  let fields: RepeatFields | undefined;
  if (ruled) {
    // Asked only once the interval has run out: inside it the last post was recent, so
    // the episode is the same one, and a held tick never pays for the read.
    const episode = due && seen.kind === "present" ? await episodeOf(key, seen) : null;
    if (reason === "due" && episode?.reminder) {
      reason = "reminder";
      posted = formatReminder(text, episode.reminder, nowMs);
    }
    // When the condition opened: kept from the row while the episode is the same one,
    // now when nobody was told before. An unreadable row leaves the column alone (the
    // upsert below merges), rather than restarting the age of a condition it cannot see.
    // A row from before 0184 has no opening moment, so its last post is recorded as one:
    // the earliest fact known, written once, so later reminders' ages grow from it
    // instead of each measuring from the post before and saying a day for ever.
    const openedMs = seen.kind !== "present" || episode?.fresh ? nowMs : (seen.openedMs ?? seen.ms);
    fields = {
      subjects,
      band,
      ...(seen.kind === "unreadable" ? {} : { opened_at: openedMs === null ? null : new Date(openedMs).toISOString() }),
    };
    log.info("slack-alert", { msg: "condition posting", key, reason, subjects: subjects.length, band });
  }

  // #3170: claim the send BEFORE posting, so two overlapping runs of one lane post
  // one page between them rather than one each. The claim is written as the SHORT
  // retry stamp a failed send leaves, and lengthened to the full cooldown only once
  // Slack confirms delivery below. So whatever goes wrong after the claim (the post
  // fails, throws, or the invocation dies mid post) the page is held off for
  // minutes, never for the whole cooldown (L368).
  const claim = await claimRow(key, seen, claimStampIso(alertStampMs(false, nowMs, intervalMs), seen), {
    reclaimIfDeleted: true,
    fields,
  });
  if (claim === "lost") return "held";

  if (loadtest) {
    log.warn("slack-alert", { msg: "load test page recorded, not sent", key });
    // write-ok: a refused stamp leaves no cooldown, so the page is recorded again next
    // tick, and the load run's judge reads a second send as an unthrottled alert,
    // which is the loud direction. No firing marker: nobody was told, so no all
    // clear is owed (#1133).
    await db
      .from("alert_state")
      .upsert(
        { key, last_sent_at: new Date(alertStampMs(true, nowMs, intervalMs)).toISOString(), ...fields },
        { onConflict: "key" },
      );
    return "sent";
  }

  // #1825: the severity lead goes on here, at the transport, after the subjects and
  // the reminder line were worked out from the text alone, so the lead never reads
  // to the repeat rule as part of what the condition says.
  const result = await postSlack({ text: withSeverityLead(posted, key, voice), ...(channel ? { channel } : {}) });
  // Fail loud (#1035): a not-ok send used to be invisible AND burned the full
  // cooldown, silently muting this alert for 15-60+ min. Surface it in the logs
  // (the paging channel can't page about itself) and stamp only a short retry
  // window so the every-minute cron re-attempts soon. A stamp still goes down on
  // failure so a hard-down Slack can't be spammed; it's just a shorter mute.
  if (!result.ok) {
    log.warn("slack-alert", { msg: "send failed", key, error: result.error ?? null });
  }
  // A delivered page leaves ONE stamp on both rows (#3303): `alertStampMs(true, ...)`
  // is now, and a page carrying news is stamped with when it was measured instead.
  // That shared stamp is how `carriesNews` tells a delivered page's cooldown, which
  // news may cut short, from the retry hold a failed send leaves here, which it may not.
  // It is also how a later post knows it is a REMINDER (#3801, `episodeOf`).
  const deliveredMs = deliveredStampMs(news, nowMs);
  // write-ok: a refused stamp leaves the claim's short retry window (or no cooldown at all, unclaimed), so the alert re-sends within minutes. Repeating a page is the safe direction; a stamp that landed wrongly would mute one.
  await db
    .from("alert_state")
    .upsert(
      {
        key,
        last_sent_at: new Date(result.ok ? deliveredMs : alertStampMs(false, nowMs, intervalMs)).toISOString(),
        // #3801: written again here because an UNCLAIMED send (the claim could not be
        // made) recorded nothing yet, and the next tick has to know what was said.
        ...fields,
      },
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
        { key: firingKey(key), last_sent_at: new Date(deliveredMs).toISOString() },
        { onConflict: "key" },
      ),
      "alert firing marker",
    );
  }
  return result.ok ? "sent" : "failed";
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

  const result = await postSlack({ text: withSeverityLead(text, key, "recovery"), ...(channel ? { channel } : {}) });
  if (!result.ok) {
    log.warn("slack-alert", {
      msg: "recovery notice send failed",
      key,
      error: result.error ?? null,
    });
    return false;
  }
  await markExplainedOnClear(key);
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
  // Deletes the firing markers and (for every key but a change only one, below) the cooldown
  // rows, so a laptop running this would leave a real page able to re-fire immediately and
  // its recovery notice never sent.
  if (!mayWriteAlerts(keys[0] ?? "(none)", `silent settle of ${keys.length} key(s)`)) return;
  const db = supabaseAdmin();
  // Both rows per key: the firing marker (so no recovery notice fires later) and
  // the cooldown row (so a genuinely new page is not muted by the old cooldown),
  // matching what resolveAlert deletes after a delivered notice. Except a change only
  // key (`CHANGE_ONLY_KEYS`) keeps its cooldown row: that row is the hold that makes it
  // post once, so deleting it would let the same subject going wrong again post a
  // second time (Dan, 2026-10-26: "a single ping about this per booking"). Retention
  // prunes it once its booking has passed (alert-state-retention.ts).
  const rows = [...keys.map(firingKey), ...keys.filter((k) => !isChangeOnly(k))];
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
  repeat?: AlertRepeat,
): Promise<void> {
  const channel = await defaultInfoChannel();
  // Noted on return by the same rule as a page (see alert-recording.ts), including
  // the return with no info channel set, which drops the message exactly as an
  // unconfigured Slack does. A throw (the channel read, or the send) notes nothing.
  // `repeat` (#3801) only matters for a CONDITION that whispers on the info channel;
  // an info key keeps its own throttle whatever it is given.
  if (channel) await sendThrottled(key, cooldownMs, text, { ...repeat, channel }, "info");
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
