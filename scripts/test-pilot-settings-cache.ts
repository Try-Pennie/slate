// Reading the pilot settings for the per page alarm and the admin page. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pilot-settings-cache.ts
//
// The monitor lane asks every 5 minutes in business hours and the admin page on every
// load, so a reading is kept for PILOT_SETTINGS_TTL_MS. A failed read serves the last
// good reading while it is younger than PILOT_SETTINGS_STALE_MS, so one Salesforce blip
// does not stand the alarm down, and THROWS once it is older, so a long outage is said
// out loud rather than an old split being believed for ever. A failure is never kept.
import {
  createPilotSettingsCache,
  PILOT_SETTINGS_STALE_MS,
  PILOT_SETTINGS_TTL_MS,
  type PilotSettings,
} from "../src/lib/salesforce/pilot-settings.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const settings = (percent: number): PilotSettings => ({ active: true, percent, tiers: "1;2;3;4;5", lastModified: null });

function fake() {
  const state = { reads: 0, answer: settings(50) as PilotSettings | "throws" };
  const read = async () => {
    state.reads++;
    if (state.answer === "throws") throw new Error("salesforce down");
    return state.answer;
  };
  return { state, cache: createPilotSettingsCache(read) };
}

{
  const { state, cache } = fake();
  eq(await cache.read(0), settings(50), "the first ask reads Salesforce");
  eq(await cache.read(PILOT_SETTINGS_TTL_MS - 1), settings(50), "inside the window it is the kept reading");
  eq(state.reads, 1, "with no second read");
  state.answer = settings(100);
  eq(await cache.read(PILOT_SETTINGS_TTL_MS), settings(100), "at the window's end it reads again, and sees the change");
  eq(state.reads, 2, "with one more read");
}
{
  // A blip serves the last good reading, and is not kept: the next ask tries again.
  const { state, cache } = fake();
  await cache.read(0);
  state.answer = "throws";
  eq(await cache.read(PILOT_SETTINGS_TTL_MS), settings(50), "a failed read serves the last good reading while it is fresh enough");
  eq(await cache.read(PILOT_SETTINGS_TTL_MS + 1), settings(50), "and the next ask tries Salesforce again");
  eq(state.reads, 3, "because a failure is never kept");
  state.answer = settings(100);
  eq(await cache.read(PILOT_SETTINGS_TTL_MS + 2), settings(100), "and a recovered read is believed at once");
}
{
  // Past the stale bound the failure is the answer.
  const { state, cache } = fake();
  await cache.read(0);
  state.answer = "throws";
  let threw = false;
  await cache.read(PILOT_SETTINGS_STALE_MS).catch(() => (threw = true));
  assert(threw, "a reading as old as the stale bound is not served: the read fails");
  assert(PILOT_SETTINGS_STALE_MS > PILOT_SETTINGS_TTL_MS, "the stale bound is longer than the window");
}
{
  // Nothing ever read: a failure throws, never a guessed split.
  const { state, cache } = fake();
  state.answer = "throws";
  let threw = false;
  await cache.read(0).catch(() => (threw = true));
  assert(threw, "with no reading at all a failed read throws");
}

finish();
