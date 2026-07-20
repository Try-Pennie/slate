// #241: a per-agent sync-staleness gauge. After #238 the backstop sync rotates
// through agents least-recently-synced first (not everyone every minute), so
// coverage is time-distributed and nothing surfaced an agent silently dropping
// out of the rotation (roster larger than a tick can cover, or a stalled lane).
// classifySyncStaleness flags bookable agents whose last_synced_at is older than
// a threshold (or who were never synced), worst-first, and the runner fires ONE
// throttled alert naming them. markAgentsSynced stamps even errored agents, so
// this specifically catches "not picked up at all", the residual gap the shipped
// health probe / heartbeat / anomaly checks don't cover.
// Run: node --experimental-strip-types scripts/test-sync-staleness.ts
import {
  classifySyncStaleness,
  formatSyncStalenessAlert,
  runSyncStalenessCheck,
  SYNC_STALENESS_KEY,
} from "../src/lib/monitor/sync-staleness.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = 1_000 * 60 * 60 * 24; // an arbitrary fixed epoch-ms (no Date.now)
const MIN = 60_000;
const THRESH = 15 * MIN;

const agent = (id: string, ageMin: number | null) => ({
  id,
  name: `Agent ${id}`,
  email: `${id}@trypennie.com`,
  lastSyncedMs: ageMin === null ? null : NOW - ageMin * MIN,
});

// Fresh roster (all within threshold): nothing stale.
{
  const res = classifySyncStaleness([agent("a", 1), agent("b", 10)], NOW, THRESH);
  eq(res.staleCount, 0, "all fresh = 0 stale");
  eq(res.worstAgeMs, null, "no worst age when none stale");
  eq(res.worstNeverSynced, false, "no never-synced when none stale");
}

// Mixed: b is 20 min stale, c never synced, a is fresh. Never-synced sorts first,
// then oldest age.
{
  const res = classifySyncStaleness([agent("a", 2), agent("b", 20), agent("c", null)], NOW, THRESH);
  eq(res.staleCount, 2, "two stale (b + never-synced c)");
  eq(res.stale.map((s) => s.id), ["c", "b"], "never-synced first, then oldest");
  eq(res.worstNeverSynced, true, "a never-synced agent is present");
  eq(res.worstAgeMs, 20 * MIN, "worst finite age is b's 20 min");
  eq(res.stale[1].ageMs, 20 * MIN, "stale entry carries its ageMs");
  eq(res.stale[0].ageMs, null, "never-synced ageMs is null");
}

// Exactly at threshold is NOT stale (strictly greater than).
{
  const res = classifySyncStaleness([agent("a", 15)], NOW, THRESH);
  eq(res.staleCount, 0, "exactly at threshold is not stale");
}

// Alert copy names agents and states never-synced vs minutes unsynced; empty when
// nothing is stale.
{
  const res = classifySyncStaleness([agent("b", 20), agent("c", null)], NOW, THRESH);
  const text = formatSyncStalenessAlert(res, THRESH);
  assert(text.includes("c@trypennie.com"), "alert names the never-synced agent");
  assert(text.includes("never synced"), "alert calls out never-synced");
  assert(text.includes("20 min"), "alert states the stale age in minutes");
  assert(text.includes("15 min"), "alert states the threshold");
  eq(formatSyncStalenessAlert(classifySyncStaleness([agent("a", 1)], NOW, THRESH), THRESH), "", "no alert copy when nothing stale");
}

// Runner: fires exactly one throttled alert (right key) when stale, none when clean.
await (async () => {
  const calls: { key: string; text: string }[] = [];
  const notify = async (key: string, _cd: number, text: string) => {
    calls.push({ key, text });
  };

  const staleRes = await runSyncStalenessCheck({
    loadAgents: async () => [agent("b", 30)],
    nowMs: NOW,
    thresholdMs: THRESH,
    notify,
    cooldownMs: 60_000,
  });
  eq(staleRes.staleCount, 1, "runner reports one stale agent");
  eq(calls.length, 1, "runner fired one alert");
  eq(calls[0].key, SYNC_STALENESS_KEY, "alert used the sync_staleness key");

  calls.length = 0;
  const cleanRes = await runSyncStalenessCheck({
    loadAgents: async () => [agent("a", 1)],
    nowMs: NOW,
    thresholdMs: THRESH,
    notify,
    cooldownMs: 60_000,
  });
  eq(cleanRes.staleCount, 0, "runner reports zero stale when fresh");
  eq(calls.length, 0, "runner fired no alert when fresh");
})();

// Failure path: a throwing notify must not throw out of the runner (a flaky Slack
// can't fail the monitor tick).
await (async () => {
  const res = await runSyncStalenessCheck({
    loadAgents: async () => [agent("b", 40)],
    nowMs: NOW,
    thresholdMs: THRESH,
    notify: async () => {
      throw new Error("slack down");
    },
    cooldownMs: 60_000,
  });
  eq(res.staleCount, 1, "runner still returns its result when notify throws");
})();

finish();
