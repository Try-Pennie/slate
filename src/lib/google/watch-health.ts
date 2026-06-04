/**
 * Pure helper for push-watch health reporting.
 *
 * Counts agents whose Google Calendar push watch channel is still live at
 * `nowMs`. A channel is live when it has an expiration in the future; a missing
 * or past expiration means push isn't active for that agent (the 1-min cron is
 * the only thing keeping their cache fresh). Kept side-effect-free and clock-
 * injected so it's deterministic to test and safe to call from a Server
 * Component (callers pass `Date.now()` from module scope to satisfy the
 * `react-hooks/purity` rule).
 */
export function liveWatchCount(
  agents: { watch_expiration: string | null }[],
  nowMs: number,
): number {
  return agents.filter(
    (a) => a.watch_expiration !== null && Date.parse(a.watch_expiration) > nowMs,
  ).length;
}
