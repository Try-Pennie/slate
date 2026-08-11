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
import { classifySlotVerdict, type SlotVerdict } from "@/lib/monitor/availability-truth";
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
export async function verifySlotLive(
  emails: string[],
  startIso: string,
  endIso: string,
): Promise<SlotVerdict> {
  if (emails.length === 0) return "unverified";
  // An unreadable bound would make every busy interval fail the overlap test, so
  // every agent would read FREE and the probe would quietly report no drift: the
  // guard silently passing, which is the worst outcome available to it. Both
  // bounds are parsed ONCE here and the slot is refused outright if either is
  // unreadable (#1169's rule, on the side that cannot hide a finding).
  const startMs = parseStampMs(startIso);
  const endMs = parseStampMs(endIso);
  if (startMs === null || endMs === null) return "unverified";

  try {
    const { byEmail, readFailed } = await calendarsForEmails(emails);
    // An agent we could not map to calendars is one we cannot judge. Counted as
    // unverified from the start, so it can only ever hold back a drift call.
    let unverified = readFailed.size;

    const agents = emails
      .filter((e) => !readFailed.has(e))
      .map((e) => ({ email: e, calendarIds: byEmail.get(e) ?? [] }));
    if (agents.length === 0) return classifySlotVerdict(0, unverified || 1);

    // Read as one agent's identity: within the Workspace domain free/busy is
    // cross-visible, which is what makes the batched read possible at all.
    const subject = agents[0].email;
    const chunks: { email: string; calendarIds: string[] }[][] = [];
    for (let i = 0; i < agents.length; i += FREEBUSY_MAX_ITEMS) {
      chunks.push(agents.slice(i, i + FREEBUSY_MAX_ITEMS));
    }

    for (const chunk of chunks) {
      const calIds = [...new Set(chunk.flatMap((a) => a.calendarIds))];
      const busyByCalendar: Map<string, CalendarBusy> = calIds.length
        ? await freeBusyMany(subject, startIso, endIso, calIds)
        : new Map();
      const res = freeAgentsFromBusy(chunk, busyByCalendar, startMs, endMs);
      // One free agent vindicates the slot; stop here rather than paying for
      // chunks whose answer cannot change the verdict.
      if (res.free.size > 0) return "free";
      unverified += res.needsFallback.size;
    }
    return classifySlotVerdict(0, unverified);
  } catch (err) {
    // A Google outage proves nothing about the cache, in either direction.
    log.warn("availability-truth", { msg: "live slot check failed", start: startIso }, err);
    return "unverified";
  }
}

/**
 * The next bucket on the rotation, or null when there are none.
 *
 * One bucket per tick keeps the probe inside the shared budget; the cursor walks
 * the ladder so every bucket is covered in turn. Test buckets are excluded: they
 * route to the isolated SMOKE agents and their availability is not a customer's.
 */
export async function nextTruthBucket(): Promise<{ code: string } | null> {
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
  const codes = (rows ?? []).map((r) => r.code);
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
): Promise<{ starts: string[]; durationMin: number } | null> {
  try {
    const res = await getBucketSlots(code, fromIso, toIso);
    if (!res) return null;
    return { starts: res.slots, durationMin: res.eventType.duration_min };
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
