// Relative value import so this module runs under `node --experimental-strip-types`
// in tests (type-only "@/" imports are erased anyway).
import { shortFailureReason } from "../notify/error-text.ts";
import { EFFECTS } from "./orchestration.ts";

/**
 * How a time off request's recorded side effects are described to a person
 * (#1476, #1477).
 *
 * Approving a time off fires five best effort steps and records each outcome in
 * `side_effects`. Two admin surfaces read that record and both were failing the
 * person in front of them: the red "calendar updates incomplete" marker carried
 * WHICH step failed only in a title attribute, unreachable on a phone and to a
 * screen reader, and the Retry control set no banner at all, so a retry that
 * fixed everything, one that fixed some steps, and one that fixed nothing looked
 * identical.
 *
 * Both are built from here, from the request's FINISHED state (L78), so the panel
 * and the banner can never disagree about which steps are in place. Pure, and
 * node tested by scripts/test-ooo-effect-copy.ts.
 */

/**
 * The human name of each step, keyed by the value stored in `side_effects`.
 *
 * The test enumerates `EFFECTS` rather than this table, in both directions: a
 * lookup keyed by a vocabulary silently takes its default branch for the entry
 * somebody forgot to add, and a default is indistinguishable from a deliberate
 * choice (L113). Names say what the step DOES, because the reader is deciding
 * whether the consequence matters, not reading a field list.
 */
export const EFFECT_LABELS: Record<string, string> = {
  [EFFECTS.managerEvent]: "the manager's OOO calendar entry",
  [EFFECTS.agentEvent]: "the event on the agent's own calendar",
  [EFFECTS.busyBlock]: "the block that stops the booker offering those hours",
  [EFFECTS.calcom]: "the cal.com block, while cal.com is still taking bookings",
  [EFFECTS.agentDm]: "the Slack message telling the agent it was approved",
};

/** One step, as a person reads it. */
export interface EffectState {
  key: string;
  label: string;
  /** Short, human, never the raw stored body. Null when there is nothing to say. */
  reason: string | null;
}

/** What the record says about each step, split by outcome. */
export interface EffectSummary {
  /** Steps that did not land, worst news first in the order they are recorded. */
  failed: EffectState[];
  /** Steps that are in place (including the deliberate fallbacks). */
  done: EffectState[];
  /**
   * Steps that had nothing to do, kept apart from `done` because claiming a skip
   * as completed work is how "the agent is blocked in cal.com" gets said about an
   * agent who has no cal.com account at all (#1249).
   */
  skipped: EffectState[];
}

/** A readable name for a step, including one this table has never heard of: an
 *  unlabelled step is still shown, because dropping it would hide exactly the
 *  failure the reader needs. */
function labelFor(key: string): string {
  return EFFECT_LABELS[key] ?? key.replace(/_/g, " ");
}

function state(key: string, raw: string): EffectState {
  // Strip the machine prefix before showing it: "failed: " is how the row is
  // stored, not something to put in front of a person.
  const detail = raw.replace(/^(failed|skipped):\s*/, "");
  return { key, label: labelFor(key), reason: shortFailureReason(detail) };
}

/** Split a stored `side_effects` record into what landed, what did not, and what
 *  had nothing to do. */
export function describeEffects(
  sideEffects: Record<string, string> | null | undefined,
): EffectSummary {
  const summary: EffectSummary = { failed: [], done: [], skipped: [] };
  for (const [key, raw] of Object.entries(sideEffects ?? {})) {
    if (typeof raw !== "string") continue;
    if (raw.startsWith("failed")) summary.failed.push(state(key, raw));
    else if (raw.startsWith("skipped")) summary.skipped.push(state(key, raw));
    else if (raw.startsWith("ok")) summary.done.push(state(key, raw));
  }
  return summary;
}

const list = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * What to tell the person who just pressed Retry.
 *
 * Read from the request as it stands AFTER the run, never from the fact that the
 * action returned without throwing: a retry reports what is true now, which is
 * the only thing the reader can act on. Exactly one of the two is set, so the
 * banner never says "done" and "still broken" in the same breath.
 */
export function retryOutcome(
  sideEffects: Record<string, string> | null | undefined,
): { ok: string | null; msg: string | null } {
  const { failed } = describeEffects(sideEffects);
  if (failed.length === 0) {
    return {
      ok: "Retried, and every calendar update is now in place.",
      msg: null,
    };
  }
  const named = list(failed.map((f) => f.label));
  const reasons = failed
    .map((f) => f.reason)
    .filter((r): r is string => r !== null && r.length > 0);
  const why = reasons.length ? ` (${list([...new Set(reasons)])})` : "";
  return {
    ok: null,
    msg:
      `Retried. ${failed.length === 1 ? "One step is" : `${failed.length} steps are`} ` +
      `still not in place: ${named}${why}. Everything else has been applied.`,
  };
}
