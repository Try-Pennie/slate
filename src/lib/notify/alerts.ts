/**
 * Pure alert helpers (no IO) — throttle decision + message formatting, kept
 * import-free so they're unit-testable. The Slack transport lives in
 * `./slack.ts`; the cooldown state is persisted by the caller.
 */

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

/** Whether a failing calendar has crossed its per-kind paging threshold (#916).
 *  Applied per row BEFORE dedup so a genuinely-gone calendar at its threshold is
 *  never hidden behind a same-agent transient calendar with a longer streak. */
export function isPageableFailure(
  kind: string | null | undefined,
  consecutiveFailures: number,
): boolean {
  const threshold = kind === "transient" ? TRANSIENT_PAGE_AT : GONE_PAGE_AT;
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

/** Whether a lone transient agent is still inside its hold (#1133). A calendar
 *  that has NEVER synced has no elapsed signal, so the streak alone decides; an
 *  unparseable timestamp is never used to HIDE a failure. */
function isHeldTransient(a: FailingAgent, nowMs: number): boolean {
  if (a.consecutiveFailures < TRANSIENT_HOLD_PASSES) return true;
  if (!a.lastSuccessAt) return false;
  const lastOkMs = Date.parse(a.lastSuccessAt);
  if (Number.isNaN(lastOkMs)) return false;
  return nowMs - lastOkMs < TRANSIENT_HOLD_MS;
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
): FailingAgent[] {
  const transient = failing.filter((a) => a.failureKind === "transient");
  if (transient.length !== 1) return failing;
  const lone = transient[0];
  return isHeldTransient(lone, nowMs) ? failing.filter((a) => a !== lone) : failing;
}

/** Longest reason we'll put in an alert line before truncating. */
const MAX_REASON_CHARS = 80;

/**
 * A SHORT human reason for a sync failure (#1133), never a raw external body.
 *
 * `last_sync_error` is stored as `` `${label} failed: ${status} ${text}` `` (see
 * `src/lib/google/calendar.ts`), where `text` is Google's entire pretty-printed
 * JSON body. Slicing that to a fixed width produced the unreadable 2026-07-28
 * page: eight lines of braces cut off mid-word at `"mess`. So pull out the two
 * facts a human needs (the status, plus Google's machine reason) and leave the
 * body to the logs, which keep it in full.
 *
 * Extraction happens on READ rather than at write time so rows already carrying a
 * full body render readably too, with no migration and no write-path change.
 * Kept generic (status + reason, else a collapsed first line) so #1135's sweep of
 * the other alerts can reuse it.
 */
export function shortFailureReason(raw: string | null): string | null {
  if (!raw) return null;
  const status = /\bfailed: (\d{3})\b/.exec(raw)?.[1];
  if (status) {
    // Google's structured `reason` ("backendError", "rateLimitExceeded") is the
    // useful half; some endpoints answer with a bare string `error` instead.
    const reason =
      /"reason"\s*:\s*"([^"]+)"/.exec(raw)?.[1] ??
      /"error"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
    return reason ? `${status} ${reason}` : status;
  }
  // Not an HTTP failure (an abort, a timeout, a thrown Error): keep its own text,
  // collapsed to one line so a stack or a multi-line message can't flood Slack.
  const oneLine = raw.split("\n")[0].replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_REASON_CHARS) return oneLine;
  // Cut on a word boundary when there is one, so the reader never gets a
  // half-word like `"mess`.
  const cut = oneLine.slice(0, MAX_REASON_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * How long ago a timestamp was, in words (#1133). `last ok` used to render as a
 * bare date, so a failure that started four minutes ago read "last ok 2026-07-28":
 * technically true and completely uninformative. An elapsed duration makes the
 * severity legible at a glance.
 */
export function relativeAge(iso: string | null, nowMs: number): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
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
function failingAgentLines(failing: FailingAgent[], nowMs: number): string {
  const lines = failing.slice(0, MAX_NAMED_AGENTS).map((a) => {
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
    return `• ${a.email}: ${n} consecutive failure${n === 1 ? "" : "s"}, last ok ${lastOk}${kind}${err}`;
  });
  const extra = failing.length - MAX_NAMED_AGENTS;
  return lines.join("\n") + (extra > 0 ? `\n…and ${extra} more` : "");
}

/**
 * Human-readable watch-lapse alert that NAMES the failing agent(s) (#273
 * Phase 1.3) — replacing the old "N of M" body that named nobody and forced a
 * hand DB query. Lists each agent's email, consecutive-failure count, last
 * successful sync, and error, plus the remediation, capped with a summary tail.
 */
export function formatWatchLapseAlert(
  failing: FailingAgent[],
  totalAgents: number,
  nowMs: number,
): string {
  const n = failing.length;
  return (
    // #1133: the noun pluralizes on the TOTAL and the verb agrees with the
    // FAILING count. Keying both off `failing.length` produced "1 of 97 bookable
    // agent have a calendar failing".
    `Slate: ${n} of ${totalAgents} bookable agent${totalAgents === 1 ? "" : "s"} ` +
    `${n === 1 ? "has" : "have"} a calendar failing to sync/renew ` +
    `(Google push degraded; availability is on the backup cron). ` +
    `${instructionFor(failing)}\n${failingAgentLines(failing, nowMs)}`
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
      ? `Slate: calendar sync is failing for 1 of ${totalAgents} ${agents} on ` +
        `consecutive passes (that agent's availability cache may be drifting from Google).`
      : `Slate: calendar sync is failing for ${n} of ${totalAgents} ${agents} on ` +
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
    "Slate: calendar sync has recovered. Every agent calendar that was failing is " +
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
