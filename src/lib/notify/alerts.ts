/**
 * Pure alert helpers (no IO) — throttle decision + message formatting, kept
 * dependency-free so they're unit-testable. The Slack transport lives in
 * `./slack.ts`; the cooldown state is persisted by the caller.
 */
import { shortFailureReason } from "@/lib/notify/error-text";
import { parseStampMs } from "@/lib/date/stamp";

/** Send only if we've never alerted, or the cooldown has elapsed. */
export function shouldSendAlert(
  lastSentAtMs: number | null,
  nowMs: number,
  cooldownMs: number,
): boolean {
  if (lastSentAtMs == null) return true;
  return nowMs - lastSentAtMs >= cooldownMs;
}

/**
 * How long a FAILED Slack send holds the cooldown before a retry is allowed
 * (#1035). Short, so a transient Slack failure doesn't silence the alert for the
 * full 15-60+ min cooldown: the every-minute cron re-attempts within this window.
 */
export const FAILED_SEND_RETRY_MS = 2 * 60 * 1000;

/**
 * The `last_sent_at` to stamp after a send attempt (#1035). Eligibility is
 * `now2 - stamp >= cooldown` (see `shouldSendAlert`), so stamping
 * `now - cooldown + delay` makes the next send eligible at `now + delay`:
 *   - ok:    delay = cooldown  -> stamps `now`, next send waits the full cooldown.
 *   - failed: delay = min(retry, cooldown) -> frees the key after the short retry
 *     window instead of burning the whole cooldown, and never waits LONGER than
 *     the cooldown a successful send would have used.
 * Stamping regardless of result still prevents a hard-failing Slack from being
 * spammed every minute; it just shortens the mute on failure.
 */
export function alertStampMs(ok: boolean, nowMs: number, cooldownMs: number): number {
  const delay = ok ? cooldownMs : Math.min(FAILED_SEND_RETRY_MS, cooldownMs);
  return nowMs - cooldownMs + delay;
}

/** A persistently-failing agent calendar, for the named alert (#273). */
export interface FailingAgent {
  email: string;
  consecutiveFailures: number;
  /** ISO timestamp of the last clean sync/renew, or null if never. */
  lastSuccessAt: string | null;
  /** Last error message, or null. */
  error: string | null;
  /** #916: classification of the worst calendar's last failure, or null when
   *  unclassified (a failure recorded before the classification shipped). */
  failureKind?: "gone" | "transient" | null;
}

/** A joined agent_calendars + users row, as loaded for the failing-agent alert. */
export interface FailingCalendarRow {
  consecutive_failures: number;
  last_success_at: string | null;
  last_sync_error: string | null;
  email: string | null;
  bookable: boolean;
  deactivated_at: string | null;
  /** #916: last failure's classification ('gone' | 'transient'), or null. */
  last_failure_kind?: string | null;
}

/**
 * Consecutive-failure thresholds at which a failing calendar PAGES, by
 * classification (#916). A definitively-GONE account (a 4xx: delegation revoked
 * / account removed) needs a human, so it pages at the same streak as before; a
 * TRANSIENT failure (5xx / timeout / rate limit) usually self-heals, so it must
 * persist LONGER before paging, cutting alert noise. A null kind (a failure
 * recorded before #916, or an odd shape) is treated as gone so no streak that
 * used to page ever goes silent.
 */
export const GONE_PAGE_AT = 2;
export const TRANSIENT_PAGE_AT = 4;

/**
 * How one lane decides to page (#1150). The sync lane (every minute) and the
 * watch lane (every ~5 minutes) ask different questions of different columns at
 * different cadences, so a single set of constants cannot serve both: a streak is
 * a proxy for elapsed time only at the cadence it was calibrated on.
 */
export interface LanePagingPolicy {
  /** Consecutive failures before a gone (or unclassified) row may page. */
  gonePageAt: number;
  /** Consecutive failures before a transient row may page. */
  transientPageAt: number;
  /** Extra consecutive failures required when only ONE agent is affected. */
  loneTransientPasses: number;
  /**
   * Real elapsed time a lone transient must have been failing, or null when the
   * lane's last-success stamp is not a usable freshness signal.
   */
  loneTransientHoldMs: number | null;
  /** How the alert labels that stamp, since the two lanes mean different things. */
  lastSuccessLabel: string;
}

/**
 * Whether a failing calendar has crossed its per-kind paging threshold (#916).
 * Applied per row BEFORE dedup so a genuinely-gone calendar at its threshold is
 * never hidden behind a same-agent transient calendar with a longer streak.
 */
export function isPageableFailure(
  kind: string | null | undefined,
  consecutiveFailures: number,
  policy: LanePagingPolicy = SYNC_PAGING,
): boolean {
  const threshold = kind === "transient" ? policy.transientPageAt : policy.gonePageAt;
  return consecutiveFailures >= threshold;
}

/**
 * Collapse the raw failing-calendar rows to one entry per agent (#273): an
 * agent can have several calendars, so keep the WORST (highest streak) and its
 * error. Drop deactivated/non-bookable agents and rows with no email (no one
 * to alert about). Sorted by streak descending so the worst are named first.
 */
export function dedupeFailingAgents(rows: FailingCalendarRow[]): FailingAgent[] {
  const byEmail = new Map<string, FailingAgent>();
  for (const r of rows) {
    if (!r.email || !r.bookable || r.deactivated_at) continue;
    const cur = byEmail.get(r.email);
    if (!cur || r.consecutive_failures > cur.consecutiveFailures) {
      byEmail.set(r.email, {
        email: r.email,
        consecutiveFailures: r.consecutive_failures,
        lastSuccessAt: r.last_success_at,
        error: r.last_sync_error,
        failureKind:
          r.last_failure_kind === "gone" || r.last_failure_kind === "transient"
            ? r.last_failure_kind
            : null,
      });
    }
  }
  return [...byEmail.values()].sort(
    (a, b) => b.consecutiveFailures - a.consecutiveFailures,
  );
}

/**
 * How long a LONE agent failing transiently must be unavailable before it pages
 * (#1133), and the number of observed failing passes that must agree.
 *
 * The 2026-07-28 page fired after ~4 minutes because one calendar got a Google
 * `503 backendError`, which healed itself with zero bookings affected. A single
 * agent is almost always that one calendar having a moment, so it now has to be
 * down for a while first; several agents at once is systemic and still pages on
 * the fast per-kind threshold above.
 *
 * BOTH signals are required, because either alone is wrong:
 *   - Elapsed time alone over-pages: `last_success_at` is only refreshed when the
 *     sync actually reaches that calendar, and a slow tick (a big resync, a slow
 *     Google) stops STARTING agents at SYNC_TICK_BUDGET_MS. A healthy-but-skipped
 *     agent therefore already looks "down 15 minutes" at its FIRST real failure,
 *     which would page in ~4 minutes again and defeat the hold.
 *   - Streak alone is what #916 already does, and the streak is a proxy for time
 *     only while the cadence holds; expressing the window in real elapsed time
 *     keeps it correct if the 1-minute cadence ever changes or a pass is skipped.
 * PASSES is the streak equivalent of the window at the 1-minute sync cadence.
 */
export const TRANSIENT_HOLD_MS = 10 * 60 * 1000;
export const TRANSIENT_HOLD_PASSES = 10;

/** The 1-minute sync lane, unchanged from #916 + #1133. */
export const SYNC_PAGING: LanePagingPolicy = {
  gonePageAt: GONE_PAGE_AT,
  transientPageAt: TRANSIENT_PAGE_AT,
  loneTransientPasses: TRANSIENT_HOLD_PASSES,
  loneTransientHoldMs: TRANSIENT_HOLD_MS,
  lastSuccessLabel: "last ok",
};

/**
 * How many consecutive failed renewals a LONE transient watch failure must show
 * before it pages (#1150). At the ~5-minute watch cadence this is roughly half an
 * hour, the same "wait out a Google blip" intent as the sync lane's ten minutes,
 * sized for a lane that gets one attempt per five minutes instead of per minute.
 *
 * "Roughly" is doing real work in that sentence: the lane attempts every
 * already-onboarded agent each tick, but a tick that runs out of its budget stops
 * starting agents, so a given calendar can miss a pass. The count is a floor on
 * the number of confirmed failures, not a promise about wall-clock time. That is
 * the safe direction to be wrong in for a degradation with a 3-day fuse.
 */
export const WATCH_TRANSIENT_HOLD_PASSES = 6;

/**
 * The ~5-minute watch-renewal lane (#1150).
 *
 * The per-kind thresholds are deliberately the same numbers as the sync lane's,
 * which at this cadence means roughly 10 minutes for a gone account and 20 for a
 * transient one. Slower is right here: a failed renewal is a DEGRADATION, not an
 * outage. Renewal is attempted from 3 days before a channel expires, so push
 * keeps working throughout, and even once it lapses availability is carried by
 * the 1-minute backup cron.
 *
 * `loneTransientHoldMs` is null because the elapsed-time signal #1133 added
 * cannot work on this lane. A healthy channel is renewed about every four days,
 * so `watch_last_success_at` is ALWAYS far past any ten-minute window: it would
 * release every hold instantly and measure nothing. The pass count is the only
 * honest signal here, so it carries the whole hold.
 */
export const WATCH_PAGING: LanePagingPolicy = {
  gonePageAt: GONE_PAGE_AT,
  transientPageAt: TRANSIENT_PAGE_AT,
  loneTransientPasses: WATCH_TRANSIENT_HOLD_PASSES,
  loneTransientHoldMs: null,
  lastSuccessLabel: "last renewed",
};

/** Whether a lone transient agent is still inside its hold (#1133). A calendar
 *  that has NEVER succeeded has no elapsed signal, so the streak alone decides;
 *  an unparseable timestamp is never used to HIDE a failure. A lane with no
 *  usable elapsed signal (#1150) is decided by the pass count alone. */
function isHeldTransient(a: FailingAgent, nowMs: number, policy: LanePagingPolicy): boolean {
  if (a.consecutiveFailures < policy.loneTransientPasses) return true;
  if (policy.loneTransientHoldMs === null) return false;
  const lastOkMs = parseStampMs(a.lastSuccessAt);
  if (lastOkMs === null) return false;
  return nowMs - lastOkMs < policy.loneTransientHoldMs;
}

/**
 * Blast-radius paging policy (#1133), applied AFTER dedup because it depends on
 * how many agents are affected, which a per-row filter cannot see.
 *
 * One transient agent waits out TRANSIENT_HOLD_MS; two or more page immediately
 * on the existing fast threshold, because "one calendar is flaky" and "something
 * is systemically broken" are different events. A `gone` (or unclassified, which
 * #916 treats as gone) calendar is NEVER held: a revoked account is a real human
 * task from its first confirmation, and one gone calendar must not drag a quiet
 * transient blip into a fast page alongside it.
 */
export function applyBlastRadiusHold(
  failing: FailingAgent[],
  nowMs: number,
  policy: LanePagingPolicy = SYNC_PAGING,
): FailingAgent[] {
  const transient = failing.filter((a) => a.failureKind === "transient");
  if (transient.length !== 1) return failing;
  const lone = transient[0];
  return isHeldTransient(lone, nowMs, policy) ? failing.filter((a) => a !== lone) : failing;
}

// #1135: `shortFailureReason` moved to notify/error-text.ts so every alert that
// carries an error can reach it, not just this file's sync pages. Re-exported
// because the sync-alert callers and their suite already import it from here.
export { shortFailureReason, MAX_REASON_CHARS } from "@/lib/notify/error-text";

/**
 * How long ago a timestamp was, in words (#1133). `last ok` used to render as a
 * bare date, so a failure that started four minutes ago read "last ok 2026-07-28":
 * technically true and completely uninformative. An elapsed duration makes the
 * severity legible at a glance.
 */
export function relativeAge(iso: string | null, nowMs: number): string {
  if (!iso) return "never";
  const t = parseStampMs(iso);
  if (t === null) return "unknown";
  const minutes = Math.floor(Math.max(0, nowMs - t) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** How many agents to name inline before summarizing the rest. */
const MAX_NAMED_AGENTS = 5;

/**
 * The instruction the alert should give (#1133), derived from the failure kinds
 * actually present instead of hardcoded. The old copy told the reader to "Re-auth
 * or deactivate" an account it had itself labelled "transient: likely
 * self-healing", so the page contradicted its own diagnosis. An unclassified kind
 * counts as an account problem, matching #916's conservative default.
 */
function instructionFor(failing: FailingAgent[]): string {
  // Only the accounts tagged gone need the re-auth, so say which ones: on a mixed
  // list a bare "Re-auth or deactivate" points at the transient agents too.
  if (failing.some((a) => a.failureKind !== "transient")) {
    return "Re-auth or deactivate the accounts marked gone:";
  }
  // All transient, but breadth changes what to do. One flaky calendar is nothing
  // to act on; several at once is Google, a credential path, or a bad deploy, and
  // telling the reader "no action needed" about that would be the same defect
  // this instruction exists to fix, just pointing the other way.
  return failing.length === 1
    ? "No action needed unless it persists:"
    : "Check whether Google is having an incident; no per agent action:";
}

/** The bulleted, capped per-agent lines shared by the named alerts (#293). */
function failingAgentLines(
  failing: FailingAgent[],
  nowMs: number,
  policy: LanePagingPolicy = SYNC_PAGING,
): string {
  const lines = failing.slice(0, MAX_NAMED_AGENTS).map((a) => {
    // #1150: the label is per-lane. "last ok 4 days ago" reads as a four-day
    // outage, but on the watch lane a four-day-old renewal is exactly healthy.
    const lastOk = relativeAge(a.lastSuccessAt, nowMs);
    const reason = shortFailureReason(a.error);
    const err = reason ? ` (${reason})` : "";
    const n = a.consecutiveFailures;
    // #916: name the classification so ops knows which need a human now vs which
    // are likely self-healing.
    const kind =
      a.failureKind === "gone"
        ? " [account gone: re-auth or deactivate]"
        : a.failureKind === "transient"
          ? " [transient: likely self-healing]"
          : "";
    return (
      `• ${a.email}: ${n} consecutive failure${n === 1 ? "" : "s"}, ` +
      `${policy.lastSuccessLabel} ${lastOk}${kind}${err}`
    );
  });
  const extra = failing.length - MAX_NAMED_AGENTS;
  return lines.join("\n") + (extra > 0 ? `\n…and ${extra} more` : "");
}

/**
 * Human-readable watch-lapse alert that NAMES the failing agent(s) (#273
 * Phase 1.3) — replacing the old "N of M" body that named nobody and forced a
 * hand DB query. Lists each agent's email, consecutive-failure count, last
 * successful renewal, and error, plus the remediation, capped with a summary tail.
 *
 * #1150: this now describes ONLY the renewal lane, because it now has its own
 * counter. It used to say the calendar was "failing to sync/renew", which was
 * both vaguer than the data and usually wrong: the case this alert exists for is
 * a calendar that syncs fine and cannot renew its push channel. It also has to
 * convey that this is a degradation with a long fuse, or a reader will treat a
 * flaky renewal as an availability outage.
 */
export function formatWatchLapseAlert(
  failing: FailingAgent[],
  totalAgents: number,
  nowMs: number,
  policy: LanePagingPolicy = WATCH_PAGING,
): string {
  const n = failing.length;
  return (
    // #1133: the noun pluralizes on the TOTAL and the verb agrees with the
    // FAILING count. Keying both off `failing.length` produced "1 of 97 bookable
    // agent have a calendar failing".
    `${n} of ${totalAgents} bookable agent${totalAgents === 1 ? "" : "s"} ` +
    `${n === 1 ? "has" : "have"} a calendar that cannot renew its Google push channel. ` +
    `Those calendars are still syncing. Renewal keeps retrying until the existing ` +
    `channel expires (within 3 days), after which their external changes reach the ` +
    `availability cache only through the 1 minute backup cron, a minute or so later. ` +
    `${instructionFor(failing)}\n${failingAgentLines(failing, nowMs, policy)}`
  );
}

/**
 * Named sync-failure alert (#293): the backstop sync errored on consecutive
 * passes — name the failing agent(s) (same shape as the watch alert) instead
 * of an anonymous count, so the cache-drift can be acted on without a DB query.
 */
export function formatSyncFailureAlert(
  failing: FailingAgent[],
  totalAgents: number,
  nowMs: number,
): string {
  const n = failing.length;
  const agents = `bookable agent${totalAgents === 1 ? "" : "s"}`;
  // #1133: one agent and many agents are different events and must not read the
  // same. One is almost always a single flaky calendar; several at once points at
  // Google, a credential path, or a bad deploy.
  const scope =
    n === 1
      ? `Calendar sync is failing for 1 of ${totalAgents} ${agents} on ` +
        `consecutive passes (that agent's availability cache may be drifting from Google).`
      : `Calendar sync is failing for ${n} of ${totalAgents} ${agents} on ` +
        `consecutive passes, which points at a systemic problem rather than one bad ` +
        `calendar (the availability cache may be drifting from Google).`;
  return `${scope} ${instructionFor(failing)}\n${failingAgentLines(failing, nowMs)}`;
}

/**
 * The "it cleared" message for the sync-failure page (#1133). Nothing in Slate
 * used to say a page had resolved, so the only signal was silence, which is
 * indistinguishable from the 30-minute cooldown still running: during the
 * 2026-07-28 incident the recipient had to query the database by hand to find out
 * it had healed. An actionable alert must say when it clears.
 */
export function formatSyncRecoveryNotice(): string {
  return (
    "Calendar sync has recovered. Every agent calendar that was failing is " +
    "syncing again and the availability cache is back in step with Google, so the " +
    "earlier page about failing calendars is cleared. No action is needed."
  );
}

/**
 * Alert only on a CONSECUTIVE failure (#43): the caller bumps a counter per
 * failing pass (cleared on success); the first failure stays quiet so a
 * transient Google blip never pages anyone.
 */
export function isConsecutiveFailure(failuresInWindow: number): boolean {
  return failuresInWindow >= 2;
}
