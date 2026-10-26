// An in-memory stand-in for the shared `rate_limit_hit` counter behind the monitor
// lane's step failure streaks (`judgeMonitorSteps`).
//
// The real store is an atomic upsert in Postgres. What the decision depends on is
// only its CONTRACT: a bump answers whether the streak has reached its threshold
// (and keeps answering true after), a clear forgets it, and a tracking failure
// answers false so a streak is never invented. `readable: false` reproduces that
// last one, which is the state the all-clear must not be built on.

import type { MonitorStepStreaks } from "../../src/lib/monitor/step-failure.ts";

export function memoryStreaks(opts: { readable?: boolean } = {}): MonitorStepStreaks & {
  counts: Map<string, number>;
} {
  const counts = new Map<string, number>();
  const readable = opts.readable !== false;
  return {
    counts,
    async bump(key, _windowSeconds, alertAt) {
      if (!readable) return false;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next >= alertAt;
    },
    async clear(key) {
      if (!readable) return;
      counts.delete(key);
    },
  };
}
