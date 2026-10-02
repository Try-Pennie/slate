/**
 * The IO half of the availability-truth probe (#1315): the rotation, the reads,
 * and the live Google check. Kept out of availability-truth.ts so that module
 * stays node-testable with no `@/` imports.
 *
 * The Google path reuses verify-on-book's machinery rather than re-implementing
 * it (`calendarsForEmails`, `freeBusyMany`, `freeAgentsFromBusy`), which is the
 * point: a probe asking "is this slot really free" through a SECOND, slightly
 * different implementation of that question would eventually disagree with the
 * real booking path and page about the difference between the two.
 */
import { freeBusyMany } from "@/lib/google/calendar";
import { calendarsForEmails, FREEBUSY_MAX_ITEMS } from "@/lib/booking/service";
import { freeAgentsFromBusy, type CalendarBusy } from "@/lib/booking/core";
import { getBucketSlots, resolveBucketByCode } from "@/lib/availability/service";
import { eligibleAgentIdsCached } from "@/lib/availability/eligible-cache";
import { loadScanOffset, saveScanOffset } from "@/lib/booking/selfheal-cursor";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import {
  classifySlotVerdict,
  AVAILABILITY_TRUTH_ALERT_KEY,
  AVAILABILITY_TRUTH_SEEN_KEY,
  AGGREGATE_DRIFT_CODE,
  type SlotVerdict,
} from "@/lib/monitor/availability-truth";
import { firingKey } from "@/lib/notify/dispatch";
import { chunkIdsByUrlBudget } from "@/lib/db/id-batch";
import { parseStampMs } from "@/lib/date/stamp";

/** The rotation cursor's own row in the shared scan-cursor table. */
const CURSOR_KEY = "availability_truth";

/**
 * Live verdict for one offered slot, across the bucket's whole eligible set.
 *
 * ESCALATION. A slot is offered because SOME eligible agent was believed free,
 * so one genuinely free agent settles it. The first chunk is therefore checked
 * alone, and the healthy case (the common one) costs a single Google call on a
 * subrequest budget four cron lanes share. Only a SUSPECTED disagreement is
 * worth spending the rest of the roster's chunks on.
 *
 * DIRECTION OF FAILURE. Every unknown lands on "unverified", never "drift": a
 * calendar Google refused, an agent whose calendar list could not be read, a
 * throwing call. The unread agent may well be free, and scoring Google's own
 * errors as drift would page about our cache every time Google had a bad minute.
 */
/** How many distinct delegated identities to try before declaring the range
 *  unreadable. Three: enough to get past a couple of accounts that cannot use
 *  Calendar, few enough that a real outage is discovered cheaply. */
const MAX_SUBJECT_ATTEMPTS = 3;

export interface AgentBusyRange {
  agents: { email: string; calendarIds: string[] }[];
  busyByCalendar: Map<string, CalendarBusy>;
  /** Agents that could not be mapped or read at all, so they can only ever hold
   *  back a drift call, never confirm one. */
  unreadable: number;
}

/**
 * ONE live read of the eligible set's calendars over a whole range (#1381).
 *
 * `freeBusy` is a RANGE query: given a window and a set of calendar ids it
 * returns every busy interval inside it. So checking a bucket's whole horizon
 * costs one call per chunk of calendars, not one per offered time. The per slot
 * loop this replaces was a shape we chose, and it made coverage look expensive
 * enough to be worth sampling away.
 *
 * Null when nothing could be read at all: no agent mapped to a calendar, or the
 * call threw. Null is not an empty busy map, which would read as everyone free.
 */
export async function readAgentBusyRange(
  emails: string[],
  fromIso: string,
  toIso: string,
): Promise<AgentBusyRange | null> {
  if (emails.length === 0) return null;
  try {
    const { byEmail, readFailed } = await calendarsForEmails(emails);
    const agents = emails
      .filter((e) => !readFailed.has(e))
      .map((e) => ({ email: e, calendarIds: byEmail.get(e) ?? [] }));
    if (agents.length === 0) return null;

    // Read as ONE agent's identity: within the Workspace domain free/busy is
    // cross-visible, which is what makes the batched read possible at all.
    //
    // But the subject is a single point of failure for the WHOLE call. An agent
    // whose own account cannot use Calendar makes Google refuse every chunk with
    // 403 notACalendarUser, not just their own calendar, so one such agent in a
    // bucket's eligible set would report every offered time unverified and leave
    // the probe silent, which is indistinguishable from finding nothing wrong.
    // On 2026-08-11 the alphabetically FIRST agent in the real roster was exactly
    // that, so taking agents[0] picked the one account guaranteed to fail.
    //
    // So try a few distinct subjects before giving up. Bounded, because a genuine
    // Google outage refuses every one of them and walking the whole roster to
    // discover that would spend the lane's budget on it.
    // Chunked by CALENDAR, which is the unit freeBusy's 20-item cap is expressed
    // in. Chunking by AGENT sends 20 times however many calendars each of them
    // has, so a roster where anyone keeps a second calendar silently overflows
    // the cap and Google answers for only part of the set (L81). Today every
    // agent has one calendar, which is exactly why an agent-shaped batch looked
    // correct.
    const allCalIds = [...new Set(agents.flatMap((a) => a.calendarIds))];
    const chunks: string[][] = [];
    for (let i = 0; i < allCalIds.length; i += FREEBUSY_MAX_ITEMS) {
      chunks.push(allCalIds.slice(i, i + FREEBUSY_MAX_ITEMS));
    }
    if (chunks.length === 0) return null;

    const subjects = agents.slice(0, MAX_SUBJECT_ATTEMPTS).map((a) => a.email);
    let lastErr: unknown = null;
    let googleCalls = 0;
    for (const [attempt, subject] of subjects.entries()) {
      try {
        const busyByCalendar: Map<string, CalendarBusy> = new Map();
        // Every chunk is read, with no escalation. Over a range there is no first
        // free agent to stop at: a later offered time may need the very chunk an
        // earlier one would have let us skip.
        for (const calIds of chunks) {
          googleCalls++;
          const read = await freeBusyMany(subject, fromIso, toIso, calIds);
          for (const [id, busy] of read) busyByCalendar.set(id, busy);
        }
        // The cost grows with the eligible set's calendar count, not with anything
        // the tick samples: past 100 calendars it exceeds the shape #1381 replaced
        // (#1397). Said on every read so that growth is visible before it pages.
        log.info("availability-truth", {
          msg: "range read",
          calendars: allCalIds.length,
          google_calls: googleCalls,
          subjects_tried: attempt + 1,
        });
        return { agents, busyByCalendar, unreadable: readFailed.size };
      } catch (err) {
        lastErr = err;
        log.warn("availability-truth", { msg: "range read refused for subject", subject }, err);
      }
    }
    // Every candidate refused. Still fails safe: a range nobody could read says
    // nothing about the cache, in either direction.
    log.warn(
      "availability-truth",
      { msg: "live range read failed", from: fromIso, subjects_tried: subjects.length },
      lastErr,
    );
    return null;
  } catch (err) {
    // A Google outage proves nothing about the cache, in either direction.
    log.warn("availability-truth", { msg: "live range read failed", from: fromIso }, err);
    return null;
  }
}

/**
 * One offered window's verdict, from a range already read.
 *
 * Judged by `freeAgentsFromBusy`, the SAME function the booking path uses, which
 * is the point: a probe answering "is this slot really free" through a second,
 * slightly different implementation would eventually disagree with the real
 * booking path and page about the difference between the two.
 *
 * DIRECTION OF FAILURE. Every unknown lands on `unverified`, never `drift`: a
 * calendar Google refused, an agent whose calendar list could not be read. The
 * unread agent may well be free, and scoring Google's own errors as drift would
 * page about our cache every time Google had a bad minute.
 */
export function verdictFromRange(range: AgentBusyRange, startIso: string, endIso: string): SlotVerdict {
  // An unreadable bound would make every busy interval fail the overlap test, so
  // every agent would read FREE and the probe would quietly report no drift: the
  // guard silently passing, which is the worst outcome available to it (#1169).
  const startMs = parseStampMs(startIso);
  const endMs = parseStampMs(endIso);
  if (startMs === null || endMs === null) return "unverified";
  const res = freeAgentsFromBusy(range.agents, range.busyByCalendar, startMs, endMs);
  return classifySlotVerdict(res.free.size, range.unreadable + res.needsFallback.size);
}

/**
 * Every offered window judged from ONE range read, in the order given (#1381).
 *
 * The probe's verify step. Null when the range could not be read at all, which
 * the caller reports as its own outcome rather than letting a total Google
 * outage read as a sample of unverified slots.
 */
export async function verifyWindowsLive(
  emails: string[],
  windows: { startIso: string; endIso: string }[],
): Promise<SlotVerdict[] | null> {
  if (windows.length === 0) return [];
  // The range spans the first window's start to the last one's end. The caller
  // hands them in time order, but taking the min and max rather than the ends
  // means a caller that stops doing so cannot silently shrink the read.
  const starts = windows.map((w) => parseStampMs(w.startIso)).filter((m): m is number => m !== null);
  const ends = windows.map((w) => parseStampMs(w.endIso)).filter((m): m is number => m !== null);
  if (starts.length === 0 || ends.length === 0) return null;
  const range = await readAgentBusyRange(
    emails,
    new Date(Math.min(...starts)).toISOString(),
    new Date(Math.max(...ends)).toISOString(),
  );
  if (range === null) return null;
  return windows.map((w) => verdictFromRange(range, w.startIso, w.endIso));
}

/**
 * Live verdict for ONE window, reading the range it needs.
 *
 * Kept as the single-window entry point for `pnpm verify:availability-truth`
 * (#1377), and deliberately built ON the same two pieces the probe uses rather
 * than beside them, so the control cannot vouch for a code path the probe does
 * not take.
 */
export async function verifySlotLive(
  emails: string[],
  startIso: string,
  endIso: string,
): Promise<SlotVerdict> {
  const verdicts = await verifyWindowsLive(emails, [{ startIso, endIso }]);
  return verdicts?.[0] ?? "unverified";
}

/**
 * The next bucket on the rotation, or null when there are none.
 *
 * One bucket per tick keeps the probe inside the shared budget; the cursor walks
 * the ladder so every bucket is covered in turn. Test buckets are excluded: they
 * route to the isolated SMOKE agents and their availability is not a customer's.
 */
export async function rotationCodes(): Promise<string[]> {
  // cap-safe: buckets is roster-bounded (~60 rows) and ordered for a stable
  // rotation, so a single page always holds the whole ladder.
  const rows = unwrap(
    await supabaseAdmin()
      .from("buckets")
      .select("code, is_test")
      .eq("is_test", false)
      .order("code", { ascending: true }),
    "buckets for availability-truth rotation",
  ) as { code: string }[] | null;
  return (rows ?? []).map((r) => r.code);
}

export async function nextTruthBucket(): Promise<{ code: string } | null> {
  const codes = await rotationCodes();
  if (codes.length === 0) return null;

  const offset = await loadScanOffset(CURSOR_KEY);
  const index = offset % codes.length;
  // Advance BEFORE the probe runs, which is the opposite of what
  // rotateSelfhealScan does on purpose. That one holds its cursor on a failed
  // sweep so the page it could not read is retried next tick; here, holding would
  // WEDGE the whole rotation on one bucket whose slots or calendars cannot be
  // read, and every other bucket would then go unchecked for as long as that
  // lasted. Deferring one bucket for a rotation is the smaller loss than blinding
  // the probe on all sixty, and a bucket that persistently fails to probe shows up
  // as a run of `status=unverified` for its code in the lane's log line.
  await saveScanOffset(CURSOR_KEY, (index + 1) % codes.length);
  return { code: codes[index] };
}

/**
 * What the bucket is currently OFFERING, plus how long a booking runs.
 *
 * Read through the same `getBucketSlots` the embed reads, so the probe checks
 * exactly the times a customer is being shown, including the read-time business
 * hours filter (#1296). Returns null when it could not be read, which the caller
 * turns into a skipped tick rather than an empty (and so falsely clean) sample.
 */
export async function offeredSlots(
  code: string,
  fromIso: string,
  toIso: string,
): Promise<{ starts: string[]; durationMin: number; bufferBeforeMin: number; bufferAfterMin: number } | null> {
  try {
    const res = await getBucketSlots(code, fromIso, toIso);
    if (!res) return null;
    return {
      starts: res.slots,
      durationMin: res.eventType.duration_min,
      bufferBeforeMin: res.eventType.buffer_before_min,
      bufferAfterMin: res.eventType.buffer_after_min,
    };
  } catch (err) {
    log.warn("availability-truth", { msg: "offered slots unreadable", bucket: code }, err);
    return null;
  }
}

/** Emails of the bucket's eligible agents, or null when the set could not be
 *  read. Null and empty are deliberately different: empty is an unstaffed
 *  bucket (the empty-bucket condition owns that), null is a failed read. */
export async function eligibleEmailsForBucket(code: string): Promise<string[] | null> {
  try {
    const resolved = await resolveBucketByCode(code);
    if (!resolved) return null;
    const { ids } = await eligibleAgentIdsCached(resolved.bucket);
    if (ids.length === 0) return [];
    // cap-safe: a primary-key lookup over the roster-bounded users table.
    const rows = unwrap(
      await supabaseAdmin().from("users").select("email").in("id", ids),
      "eligible agent emails",
    ) as { email: string }[] | null;
    return (rows ?? []).map((r) => r.email).filter(Boolean);
  } catch (err) {
    log.warn("availability-truth", { msg: "eligible set unreadable", bucket: code }, err);
    return null;
  }
}

/** The durable "this bucket was last measured drifting" marker (#1373). Not an
 *  alert: namespaced away from the cooldown keys so the two can never collide. */
const seenKey = (code: string) => `${AVAILABILITY_TRUTH_SEEN_KEY}:${code}`;

/**
 * Who else is drifting, and what is already firing, in three reads (#1373).
 *
 * Returns null when ANY of them fails, and null is deliberately not an empty
 * set: an empty set is the claim "nothing else is drifting", which would let one
 * unreadable tick both suppress the aggregate and post a recovery notice for a
 * condition still true. The caller treats null as "cannot judge how widespread
 * this is", pages per bucket, and all-clears nothing.
 */
export async function driftAlertContext(): Promise<{
  seenDrifting: string[];
  perBucketFiring: string[];
  aggregateFiring: boolean;
  totalBuckets: number;
} | null> {
  try {
    const codes = await rotationCodes();
    if (codes.length === 0) return null;
    // Read STRICTLY, not through existingAlertStateKeys / firingAlertKeys.
    // Those two degrade a failed read to an EMPTY set on purpose, which is right
    // for their callers (an empty set defers work one tick and can never invent a
    // recovery) and exactly wrong here: an empty set is the positive claim
    // "nothing else is drifting", which would suppress the aggregate and, on a
    // healthy verdict, all-clear a condition still true off a read that never
    // happened (L10/L11). `unwrap` throws instead, and the catch below turns that
    // into null, which is the caller's "cannot judge how widespread this is".
    //
    // Scoped to the codes on the CURRENT ladder, so a marker left by a bucket
    // that has since been removed cannot keep the aggregate alive forever.
    const aggregateKey = `${AVAILABILITY_TRUTH_ALERT_KEY}:${AGGREGATE_DRIFT_CODE}`;
    const pageKey = (c: string) => `${AVAILABILITY_TRUTH_ALERT_KEY}:${c}`;
    const wanted = [
      ...codes.map(seenKey),
      ...codes.map((c) => firingKey(pageKey(c))),
      firingKey(aggregateKey),
    ];
    const present = new Set<string>();
    // Chunked by measured BYTES, not by a row count (#1321). The keys ride in the
    // request URL and an oversized `in` filter is REFUSED at the transport. These
    // keys are composed rather than fixed-width, so their length follows the
    // bucket code and the prefix, which is exactly the case a count gets wrong.
    for (const batch of chunkIdsByUrlBudget(wanted)) {
      // Bounded by the chunk: a membership read on alert_state's primary key, and
      // `wanted` is derived from the roster-bounded bucket ladder.
      const rows = unwrap(
        await supabaseAdmin().from("alert_state").select("key").in("key", batch),
        "availability-truth drift alert state",
      ) as { key: string }[] | null;
      for (const r of rows ?? []) present.add(r.key);
    }
    return {
      seenDrifting: codes.filter((c) => present.has(seenKey(c))),
      perBucketFiring: codes.filter((c) => present.has(firingKey(pageKey(c)))),
      aggregateFiring: present.has(firingKey(aggregateKey)),
      totalBuckets: codes.length,
    };
  } catch (err) {
    log.warn("availability-truth", { msg: "drift alert context unreadable" }, err);
    return null;
  }
}

/**
 * Record or drop one bucket's drift marker.
 *
 * THROWS on failure rather than swallowing, because both directions of a lost
 * write are wrong in a way nothing downstream can notice: a missed set leaves a
 * drifting bucket out of the aggregate's count, and a missed clear keeps the
 * aggregate alive after everything recovered. The caller logs it through
 * `onError` and the next rotation re-measures the bucket either way.
 */
export async function markBucketDrifting(code: string, drifting: boolean): Promise<void> {
  const db = supabaseAdmin();
  if (drifting) {
    const { error } = await db
      .from("alert_state")
      .upsert({ key: seenKey(code), last_sent_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw new Error(`drift marker write failed for ${code}: ${error.message}`);
    return;
  }
  const { error } = await db.from("alert_state").delete().eq("key", seenKey(code));
  if (error) throw new Error(`drift marker clear failed for ${code}: ${error.message}`);
}
