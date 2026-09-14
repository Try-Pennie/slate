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
  formatSyncStalenessRecovery,
  runSyncStalenessCheck,
  syncRotationCandidates,
  SYNC_STALENESS_KEY,
} from "../src/lib/monitor/sync-staleness.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Em/en dash detector built from escapes, so this file holds no literal dash. */
const DASHES = new RegExp("[\\u2013\\u2014]");

const NOW = 1_000 * 60 * 60 * 24; // an arbitrary fixed epoch-ms (no Date.now)
const MIN = 60_000;
const THRESH = 15 * MIN;

const agent = (id: string, ageMin: number | null) => ({
  id,
  name: `Agent ${id}`,
  email: `${id}@trypennie.com`,
  lastSyncedMs: ageMin === null ? null : NOW - ageMin * MIN,
  // An ESTABLISHED agent: their calendar row has existed for a day, so the
  // rotation has had every chance at them and the #2299 first-run grace never
  // applies. Every test written before that grace existed meant this agent.
  rotationSinceMs: NOW - 24 * 60 * MIN,
  hasRecordedFailure: false,
});

/** An agent whose calendar row was created `ageMin` ago and has never been synced. */
const joined = (
  id: string,
  ageMin: number,
  opts: { failed?: boolean } = {},
) => ({
  id,
  name: `Agent ${id}`,
  email: `${id}@trypennie.com`,
  lastSyncedMs: null,
  rotationSinceMs: NOW - ageMin * MIN,
  hasRecordedFailure: opts.failed === true,
});

// --- syncRotationCandidates (#1158): the join deciding who is IN the rotation ---
{
  const row = (id: string, lastSyncedAt: string | null) => ({
    id,
    name: `Agent ${id}`,
    email: `${id}@trypennie.com`,
    last_synced_at: lastSyncedAt,
  });
  const iso = new Date(NOW - 5 * MIN).toISOString();
  // One established calendar for agent "a". Since #2299 the join reads the rows
  // themselves rather than a set of user ids, because the first-run grace is judged
  // on when the row appeared and whether it has failed.
  const calFor = (userId: string) => [
    { user_id: userId, created_at: new Date(NOW - 24 * 60 * MIN).toISOString(), consecutive_failures: 0, last_sync_error: null },
  ];

  const out = syncRotationCandidates([row("a", iso), row("b", iso)], calFor("a"));
  eq(out.map((c) => c.id), ["a"], "an agent with no calendar row is not in the rotation");
  eq(out[0]?.lastSyncedMs, NOW - 5 * MIN, "last_synced_at is parsed to epoch ms");

  const never = syncRotationCandidates([row("a", null)], calFor("a"));
  eq(never[0]?.lastSyncedMs, null, "a never-synced agent keeps null (worst case, flagged)");

  // A malformed timestamp must read as never-synced (flagged), not as fresh: a
  // NaN age would compare false against the threshold and silently pass as
  // healthy, the unreadable-scored-as-answer class.
  const garbage = syncRotationCandidates([row("a", "not-a-date")], calFor("a"));
  eq(garbage[0]?.lastSyncedMs, null, "an unparseable last_synced_at degrades to never-synced");
}

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
  const resolved: { key: string; text: string }[] = [];
  const resolve = async (key: string, text: string) => {
    resolved.push({ key, text });
    return true;
  };

  const staleRes = await runSyncStalenessCheck({
    loadAgents: async () => [agent("b", 30)],
    nowMs: NOW,
    thresholdMs: THRESH,
    notify,
    resolve,
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
    resolve,
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
    resolve: async () => false,
    cooldownMs: 60_000,
  });
  eq(res.staleCount, 1, "runner still returns its result when notify throws");
})();

// --- the all-clear (#1400) ----------------------------------------------------
// The gauge pages that agents' calendars have gone stale and could never say it
// ended, so a reader had no way to tell a recovered rotation from a cooldown
// still running (#1134). It is a condition, so it owes an ending, and that
// ending has to hang off a MEASURED reading (#1152).
await (async () => {
  const resolved: { key: string; text: string }[] = [];
  const resolve = async (key: string, text: string) => {
    resolved.push({ key, text });
    return true;
  };
  const notify = async () => {};

  await runSyncStalenessCheck({
    loadAgents: async () => [agent("a", 1), agent("b", 2)],
    nowMs: NOW,
    thresholdMs: THRESH,
    notify,
    resolve,
    cooldownMs: 60_000,
  });
  eq(resolved.length, 1, "a measured rotation with nothing stale offers the all-clear");
  eq(resolved[0]?.key, SYNC_STALENESS_KEY, "and clears the key it pages on");
  assert(/no action is needed/i.test(resolved[0]?.text ?? ""), "the all-clear closes the loop");
  assert(!DASHES.test(resolved[0]?.text ?? ""), "the all-clear has no dashes");
  assert(
    !/undefined|NaN|\[object Object\]/.test(resolved[0]?.text ?? ""),
    "the all-clear renders no placeholder leak",
  );

  // A tick that is PAGING must not also clear the page it is sending.
  resolved.length = 0;
  await runSyncStalenessCheck({
    loadAgents: async () => [agent("b", 30)],
    nowMs: NOW,
    thresholdMs: THRESH,
    notify,
    resolve,
    cooldownMs: 60_000,
  });
  eq(resolved.length, 0, "a tick with a stale agent clears nothing");

  // THE failure path. An empty candidate list is not a healthy rotation, it is a
  // rotation with nothing in it to measure, and the two are indistinguishable from
  // staleCount alone (L98). Announcing recovery here would be an all-clear off a
  // reading that never happened.
  resolved.length = 0;
  const empty = await runSyncStalenessCheck({
    loadAgents: async () => [],
    nowMs: NOW,
    thresholdMs: THRESH,
    notify,
    resolve,
    cooldownMs: 60_000,
  });
  eq(empty.staleCount, 0, "an empty rotation reports nothing stale");
  eq(resolved.length, 0, "and clears NOTHING: it measured no agent at all");

  // A roster read that throws takes the check with it, so nothing is claimed in
  // either direction and the step runner reports the tick as degraded.
  resolved.length = 0;
  let threw = false;
  await runSyncStalenessCheck({
    loadAgents: async () => {
      throw new Error("roster read failed");
    },
    nowMs: NOW,
    thresholdMs: THRESH,
    notify,
    resolve,
    cooldownMs: 60_000,
  }).catch(() => {
    threw = true;
  });
  assert(threw, "a roster read that fails is not swallowed into a healthy reading");
  eq(resolved.length, 0, "and clears nothing");

  // A failing resolve must not take down the tick, exactly as a failing notify does not.
  const res = await runSyncStalenessCheck({
    loadAgents: async () => [agent("a", 1)],
    nowMs: NOW,
    thresholdMs: THRESH,
    notify,
    resolve: async () => {
      throw new Error("slack down");
    },
    cooldownMs: 60_000,
  });
  eq(res.staleCount, 0, "runner still returns its result when the all-clear throws");
})();

// --- #2299: the first-run grace ------------------------------------------------
// A null `last_synced_at` used to bypass the threshold entirely, so a calendar row
// created sixty seconds ago was reported as an agent who had "never been synced by
// the cron". Never synced is the ONLY state such a row can be in, and the threshold
// exists precisely to ride out ordinary rotation latency. Measured 2026-09-14: the
// watch lane created four rows at 09:05:39 and the monitor lane paged about all four
// in the same five minute invocation; the rotation reached them by 09:10.
//
// The yardstick is `agent_calendars.created_at`, the only stamp that says when the
// rotation could first have reached them, and it is the SAME threshold every other
// agent is judged against, not a second number.
{
  const res = classifySyncStaleness([joined("new", 5)], NOW, THRESH);
  eq(res.staleCount, 0, "an agent whose calendar row is 5 min old is not yet stale");
  eq(res.gracedCount, 1, "and the tick says it withheld one, rather than reporting a clean rotation");
}

// The grace EXPIRES. Past the threshold the row has had its chance and never synced
// is the worst case again, exactly as before.
{
  const res = classifySyncStaleness([joined("new", 20)], NOW, THRESH);
  eq(res.staleCount, 1, "past the threshold a never-synced agent is stale again");
  eq(res.gracedCount, 0, "and nothing is withheld");
  eq(res.worstNeverSynced, true, "still reported as the never-synced case");
}

// Exactly at the threshold is not yet stale, matching the strictly-greater rule the
// finite-age branch already uses. One rule, not two.
{
  eq(
    classifySyncStaleness([joined("new", 15)], NOW, THRESH).staleCount,
    0,
    "a row exactly at the threshold is not yet stale",
  );
}

// L458: a grace period is for an answer that has NOT arrived. A calendar carrying a
// recorded failure has already answered, and being patient about it hides a condition
// that is known and actionable. Inside the window those two are otherwise identical,
// because neither has a success.
{
  const res = classifySyncStaleness([joined("broken", 2, { failed: true })], NOW, THRESH);
  eq(res.staleCount, 1, "a recorded failure cancels the grace at once");
  eq(res.gracedCount, 0, "and nothing is withheld");
}

// Fail safe on an entry stamp we could not read: no grace. An unreadable stamp must
// never buy silence, which is the NaN-lands-healthy shape this codebase keeps meeting.
{
  const unknown = { ...joined("x", 1), rotationSinceMs: null };
  eq(
    classifySyncStaleness([unknown], NOW, THRESH).staleCount,
    1,
    "an unreadable rotation entry stamp gets no grace",
  );
}

// L324: the stand down is no broader than its reason. It answers "has the rotation
// had a chance at this row", never "is this agent new", so an agent who HAS been
// synced is judged on their own age even with a brand new calendar row, and a
// reactivated agent (old row, #1879) is untouched by any of this.
{
  const syncedButStale = { ...agent("b", 30), rotationSinceMs: NOW - 1 * MIN };
  eq(
    classifySyncStaleness([syncedButStale], NOW, THRESH).staleCount,
    1,
    "a synced agent past the threshold is stale however new their calendar row is",
  );
}

// The graced agent is withheld from the PAGE as well as the count, so the copy can
// never name somebody the check deliberately declined to judge.
{
  const res = classifySyncStaleness([joined("new", 3), agent("b", 30)], NOW, THRESH);
  eq(res.stale.map((s) => s.id), ["b"], "only the genuinely stale agent reaches the alert");
  const text = formatSyncStalenessAlert(res, THRESH);
  assert(!text.includes("new@trypennie.com"), "the page does not name the graced agent");
}

// --- #2299: the join carries what the grace is judged on -----------------------
{
  const row = (
    userId: string,
    createdAt: string | null,
    extra: { consecutive_failures?: number; last_sync_error?: string | null } = {},
  ) => ({
    user_id: userId,
    created_at: createdAt,
    consecutive_failures: extra.consecutive_failures ?? 0,
    last_sync_error: extra.last_sync_error ?? null,
  });
  const user = (id: string) => ({
    id,
    name: `Agent ${id}`,
    email: `${id}@trypennie.com`,
    last_synced_at: null,
  });
  const at = (minsAgo: number) => new Date(NOW - minsAgo * MIN).toISOString();

  // An agent enters the rotation when their FIRST calendar row appears, so a second
  // calendar added later must not restart the grace.
  const two = syncRotationCandidates([user("a")], [row("a", at(90)), row("a", at(2))]);
  eq(two[0]?.rotationSinceMs, NOW - 90 * MIN, "the EARLIEST calendar row is when the rotation could first reach them");

  const unreadable = syncRotationCandidates([user("a")], [row("a", "not-a-date")]);
  eq(unreadable[0]?.rotationSinceMs, null, "an unreadable created_at degrades to unknown, which buys no grace");

  const failedCount = syncRotationCandidates([user("a")], [row("a", at(1), { consecutive_failures: 1 })]);
  eq(failedCount[0]?.hasRecordedFailure, true, "a consecutive failure count is a recorded failure");

  const failedText = syncRotationCandidates([user("a")], [row("a", at(1), { last_sync_error: "403" })]);
  eq(failedText[0]?.hasRecordedFailure, true, "a stored error is a recorded failure");

  // ANY of the agent's calendars having failed cancels the grace: the rotation
  // processes the agent, not one calendar, so a single broken one is an answer.
  const mixed = syncRotationCandidates(
    [user("a")],
    [row("a", at(1)), row("a", at(1), { consecutive_failures: 2 })],
  );
  eq(mixed[0]?.hasRecordedFailure, true, "one failing calendar among several cancels the grace");

  const healthy = syncRotationCandidates([user("a")], [row("a", at(1))]);
  eq(healthy[0]?.hasRecordedFailure, false, "a calendar with no recorded failure keeps the grace");
}

// --- #2299: the all-clear may not claim what the grace declined to measure -----
// Withholding a graced agent makes staleCount zero, which reaches the recovery
// branch. The old sentence said "all 94 bookable agents in it were synced inside the
// expected window", which would be false about the very agents the grace withheld
// (L440: a softened message must then state what the check DID measure).
{
  const clean = formatSyncStalenessRecovery(94, 0);
  assert(/all 94/.test(clean), "with nothing withheld it still says every agent was synced");
  assert(!/too recently|joined/i.test(clean), "and says nothing about a grace that did not apply");

  const graced = formatSyncStalenessRecovery(94, 4);
  assert(!/all 94/.test(graced), "it must not claim all 94 when 4 were never measured");
  assert(/90/.test(graced), "it states how many it actually measured");
  assert(/4/.test(graced), "and how many it withheld");
  assert(!DASHES.test(graced), "the all-clear has no dashes");
  assert(
    !/undefined|NaN|\[object Object\]/.test(graced),
    "the all-clear renders no placeholder leak",
  );

  const one = formatSyncStalenessRecovery(94, 1);
  assert(!/1 agents/.test(one), "one withheld agent reads as singular");
}

await (async () => {
  const resolved: { key: string; text: string }[] = [];
  const resolve = async (key: string, text: string) => {
    resolved.push({ key, text });
    return true;
  };
  await runSyncStalenessCheck({
    loadAgents: async () => [agent("a", 1), joined("new", 2)],
    nowMs: NOW,
    thresholdMs: THRESH,
    notify: async () => {},
    resolve,
    cooldownMs: 60_000,
  });
  eq(resolved.length, 1, "a tick whose only unmeasured agents are graced still clears the page");
  assert(
    !/all 2/.test(resolved[0]?.text ?? ""),
    "and the wording does not claim it measured the graced agent",
  );
})();


finish();
