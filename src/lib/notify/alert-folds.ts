/**
 * Alerts another alert EXPLAINS, so they wait while it is firing (#3802).
 *
 * Overnight on 2026-10-15 GitHub refused to start any Actions job (a billing stop).
 * One cause posted as four alerts, each repeating: `ci_runs_refused`, and then the
 * smoke canary's three heartbeats going stale, because the canary is an Actions run
 * too. Each canary page told the reader to re run it from the Actions tab, which
 * cannot work while GitHub is refusing jobs, and made one billing problem read as four
 * broken checks.
 *
 * So this is ONE table of "this key explains those keys", consulted by the throttle
 * (`sendThrottledAlert` in `dispatch.ts`) before any post, rather than a condition
 * hand rolled into each check (L621). The next cause and consequence pair is one
 * entry here. `scripts/test-alert-folds.ts` holds every key in it to the catalog.
 *
 * The rule, all of it decided by `judgeFold` below (Dan's decisions on #3802):
 *
 *   - While the explaining alert is FIRING (a page was delivered and not cleared),
 *     an explained alert does not post. It is still evaluated, and the hold is
 *     recorded in `alert_state` under `foldMarkKey`, so it is never skipped.
 *   - Once the explaining alert clears, each explained alert gets its own grace (one
 *     full bound of its lane) before it may post: the run that would clear it needs a
 *     cadence to happen. Still true after that, it posts as its own problem.
 *   - Only an alert nobody was told about is folded. One that already posted (it went
 *     stale before the cause, or ran out its grace and posted) keeps its own course,
 *     reminders and all-clear included.
 *   - A failed read never suppresses: when the explaining alert's state cannot be
 *     read, the explained alert posts as usual (fail loud).
 *   - An explaining page with no delivered post for longer than
 *     `EXPLAINER_FRESH_MS` explains nothing: a firing condition repeats daily, so a
 *     marker that old is no longer being measured, and a hold resting on it would be
 *     a suppression nobody can see the end of (L523).
 *
 * The all-clear needs nothing here: an explained alert that never posted has no
 * firing marker, so `resolveAlert` sends nothing for it, and the explaining alert's
 * own all-clear speaks for the group.
 */
import { CANARY_STALE_BOUNDS_MS, POOL_GROUPING_STALE_BOUNDS_MS, VERDICT_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import { CONDITION_REPEAT_MS } from "@/lib/notify/repeat-policy";

/** One alert held while its explainer fires. */
export interface FoldedAlert {
  /** The key as SENT, a family member included (`cron_lane_stale:smoke-canary`). */
  key: string;
  /**
   * How the explaining page and its all-clear name it: a lower case noun phrase,
   * joined in table order into the subject of a sentence ("the booking smoke canary,
   * its full end to end booking pass and ..."), so a label may lean on the one before
   * it, as "its" does, and the first in a fold must stand on its own.
   */
  label: string;
  /** How long it waits after the explainer clears before it may post: its own bound. */
  graceMs: number;
}

export interface AlertFold {
  /** The explaining condition's key, exactly as the catalog holds it. */
  explainer: string;
  /** Why the explainer's being true is enough to account for each of these. */
  why: string;
  explains: readonly FoldedAlert[];
}

/** The lane watchdog's key for a stale lane (`staleLaneAlertKey` in lane-watchdog.ts). */
const staleLaneKey = (lane: string) => `cron_lane_stale:${lane}`;

export const ALERT_FOLDS: readonly AlertFold[] = [
  {
    explainer: "ci_runs_refused",
    why:
      "The smoke canary is a GitHub Actions workflow, and these are the heartbeats only " +
      "its runs stamp, so while GitHub refuses to start jobs they go stale by construction " +
      "and re running them from the Actions tab cannot work.",
    explains: [
      {
        key: staleLaneKey("smoke-canary"),
        label: "the booking smoke canary",
        graceMs: CANARY_STALE_BOUNDS_MS["smoke-canary"],
      },
      {
        key: staleLaneKey("smoke-canary-full"),
        label: "its full end to end booking pass",
        graceMs: CANARY_STALE_BOUNDS_MS["smoke-canary-full"],
      },
      {
        key: staleLaneKey("verdict:availability-latency"),
        label: "its availability latency reading",
        graceMs: VERDICT_STALE_BOUNDS_MS["verdict:availability-latency"],
      },
    ],
  },
  {
    // The lane watchdog's one page for quiet Worker cron lanes (`CORE_LANES_ALERT_KEY`).
    explainer: "cron_lanes_stale",
    why:
      "The pool grouping is published only by the recompute lane, so once recompute is quiet it " +
      "stops by construction, and the core lanes' page names it. On 2026-10-26 it posted as a " +
      "sixth page for one Cloudflare cron incident. Held too when some other core lane is quiet " +
      "and the publish failed on its own: that page names it as stopped, and it posts on its own " +
      "one bound after the lanes recover.",
    explains: [
      {
        key: staleLaneKey("pool-grouping"),
        label: "the pool grouping",
        graceMs: POOL_GROUPING_STALE_BOUNDS_MS["pool-grouping"],
      },
    ],
  },
];

/** The fold an explained key belongs to, or null for every key nothing explains. */
export function foldFor(key: string): { explainer: string; folded: FoldedAlert } | null {
  for (const fold of ALERT_FOLDS) {
    const folded = fold.explains.find((f) => f.key === key);
    if (folded) return { explainer: fold.explainer, folded };
  }
  return null;
}

/** What an explaining page names as having stopped with it, in table order. */
export function explainedLabels(explainer: string): string[] {
  return ALERT_FOLDS.filter((f) => f.explainer === explainer).flatMap((f) => f.explains.map((e) => e.label));
}

/**
 * Where a hold is recorded: the last moment the explained key was held under a firing
 * explainer. `alert_state` already holds markers of this kind (`alert_firing:`,
 * `lane_never_seen:`), so this needs no migration, and the prefix keeps it apart from
 * every cooldown and firing key.
 */
export const foldMarkKey = (key: string) => `alert_folded:${key}`;

/**
 * How stale the hold record may get before it is written again. The explainer is
 * measured every five minutes on the monitor lane, so a mark refreshed more often
 * than that records nothing new and spends a write per lane per minute on a budget
 * four cron lanes share. The grace adds it back, so the wait after a clear is never
 * shorter than the lane's full bound.
 */
export const FOLD_MARK_REFRESH_MS = 5 * 60_000;

/**
 * How recent the explainer's last delivered post must be for it to explain anything.
 * A firing condition posts a reminder once a day, so a day and an hour clears the
 * reminder plus a monitor tick that ran late.
 */
export const EXPLAINER_FRESH_MS = CONDITION_REPEAT_MS + 60 * 60_000;

/**
 * What one read of `alert_state` said about a fold, or null when it could not be read.
 * Stamps that are absent or cannot be parsed are null: neither can hold anything.
 */
export interface FoldRead {
  /** The explainer's firing marker: when its last page was delivered. */
  explainerFiringMs: number | null;
  /** Whether the explained key has a firing marker of its own. */
  ownFiring: boolean;
  /** When the explained key was last held under a firing explainer. */
  markMs: number | null;
}

export type FoldDecision =
  | { act: "post"; why: "not-folded" | "unreadable" | "grace-over" | "told-already" }
  | { act: "hold"; why: "explained"; refreshMark: boolean }
  | { act: "hold"; why: "grace"; untilMs: number };

/** The whole rule, pure, so every edge is drivable without a database or a clock. */
export function judgeFold(read: FoldRead | null, nowMs: number, graceMs: number): FoldDecision {
  if (read === null) return { act: "post", why: "unreadable" };
  if (read.ownFiring) return { act: "post", why: "told-already" };
  const explaining =
    read.explainerFiringMs !== null && nowMs - read.explainerFiringMs <= EXPLAINER_FRESH_MS;
  if (explaining) {
    return {
      act: "hold",
      why: "explained",
      refreshMark: read.markMs === null || nowMs - read.markMs >= FOLD_MARK_REFRESH_MS,
    };
  }
  if (read.markMs === null) return { act: "post", why: "not-folded" };
  const untilMs = read.markMs + graceMs + FOLD_MARK_REFRESH_MS;
  if (nowMs < untilMs) return { act: "hold", why: "grace", untilMs };
  return { act: "post", why: "grace-over" };
}

/**
 * Every problem with a fold table, for the guard. `kindOf` answers a SENT key's kind
 * from the catalog (a family member included), `exact` whether the catalog holds the
 * key itself. Kept here so the guard tests the same table the throttle reads.
 */
export function foldTableProblems(
  folds: readonly AlertFold[],
  kindOf: (key: string) => string | undefined,
  exact: (key: string) => boolean,
): string[] {
  const problems: string[] = [];
  const explainers = new Set(folds.map((f) => f.explainer));
  const seen = new Map<string, string>();
  for (const fold of folds) {
    // A family is never SENT under its own key, so its firing marker never exists and a
    // fold under it would hold nothing while reading as configured.
    if (fold.explainer.endsWith(":*")) problems.push(`explainer ${fold.explainer} is a family, which no page is ever sent as`);
    else if (!exact(fold.explainer)) problems.push(`explainer ${fold.explainer} is not a key in the alert catalog`);
    else if (kindOf(fold.explainer) !== "condition") problems.push(`explainer ${fold.explainer} is not a condition`);
    if (fold.why.trim().split(/\s+/).length < 8) problems.push(`the fold under ${fold.explainer} carries no reason`);
    if (fold.explains.length === 0) problems.push(`the fold under ${fold.explainer} explains nothing`);
    for (const e of fold.explains) {
      const kind = kindOf(e.key);
      if (kind === undefined) problems.push(`${e.key} is not in the alert catalog`);
      else if (kind !== "condition") problems.push(`${e.key} is not a condition, so it has no hold to speak of`);
      if (e.key === fold.explainer) problems.push(`${e.key} explains itself`);
      if (explainers.has(e.key)) problems.push(`${e.key} is an explainer and is also explained, a chain nothing resolves`);
      const other = seen.get(e.key);
      if (other !== undefined) problems.push(`${e.key} is explained by both ${other} and ${fold.explainer}`);
      seen.set(e.key, fold.explainer);
      if (!Number.isFinite(e.graceMs) || e.graceMs <= 0) problems.push(`${e.key} has no usable grace (${String(e.graceMs)})`);
      if (e.label.trim() === "") problems.push(`${e.key} has no label for the explaining page`);
    }
  }
  return problems;
}
