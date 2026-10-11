/**
 * The ONE sentence that says what a Twilio demotion changed (#3615). The audit trail, the Slack
 * line when a sweep moves calls, and the undo panel all read it, so the same change can never be
 * described two ways (L41). Pure.
 */
import type { DemotionChange } from "@/lib/booking/demotion-plan";
import { BACKEND_LABELS, DEBT_TIER_LABELS } from "@/lib/routing/attribute-vocabulary";

const LABELS: Record<string, string> = { ...DEBT_TIER_LABELS, ...BACKEND_LABELS };

/** "A", "A and B", "A, B and C", or "none". A value the vocabulary does not know is shown as
 *  stored, since dropping it would describe a change that did not happen. */
function listOf(values: string[]): string {
  const words = values.map((v) => LABELS[v] ?? v);
  if (words.length === 0) return "none";
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
}

/**
 * "Debt tiers went from Ultra High and High to High." naming only what changed, or null when the
 * change was not recorded or changed nothing, so the caller decides how to say that.
 */
export function describeDemotionChange(change: DemotionChange | null): string | null {
  if (!change) return null;
  const parts: string[] = [];
  if (!sameSet(change.from.debtTeam, change.to.debtTeam)) {
    parts.push(`debt tiers went from ${listOf(change.from.debtTeam)} to ${listOf(change.to.debtTeam)}`);
  }
  if (!sameSet(change.from.backendService, change.to.backendService)) {
    parts.push(`backend went from ${listOf(change.from.backendService)} to ${listOf(change.to.backendService)}`);
  }
  if (parts.length === 0) return null;
  const sentence = parts.join(", and ");
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
}
