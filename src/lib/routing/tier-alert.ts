/**
 * Pure: choose the Slack alert for a tier-drop. A single-rung drop is a quiet
 * throttled notice; a two-plus-rung drop escalates (distinct key, short
 * cooldown, loud text) because a deep cascade is near-impossible under normal
 * load and signals a capacity or systems problem. Returns null when no drop.
 */
export function tierFallbackAlert(input: {
  requestedCode: string;
  effectiveCode: string;
  rungsDropped: number;
}): { key: string; cooldownMs: number; text: string } | null {
  if (input.rungsDropped <= 0) return null;
  const escalate = input.rungsDropped >= 2;
  if (escalate) {
    return {
      key: `tier_fallback_deep:${input.requestedCode}`,
      cooldownMs: 5 * 60 * 1000,
      text: `Routing alert: a booking for bucket ${input.requestedCode} dropped ${input.rungsDropped} tiers to ${input.effectiveCode} because every higher tier had no availability across the booking window. This should almost never happen. Check for a capacity crunch, mass time off, or a roster or availability problem.`,
    };
  }
  return {
    key: `tier_fallback:${input.requestedCode}`,
    cooldownMs: 60 * 60 * 1000,
    text: `Routing notice: a booking for bucket ${input.requestedCode} dropped one tier to ${input.effectiveCode}; the requested tier had no availability across the booking window.`,
  };
}
