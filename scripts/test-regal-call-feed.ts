// Is the Regal call feed alive and readable? (#2090). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-regal-call-feed.ts
//
// The detector in regal-calls.ts goes silent in two ways that read exactly like a
// healthy roster: nothing arrives at all (Regal's webhook switched off, pointed
// elsewhere, or sending a key Slate refuses), and things arrive that the edge can
// no longer read (Regal changed the payload, so every event lands in an unreadable
// bucket). Both are conditions with their own alarm and their own ending, and
// both must refuse to judge when the counts cannot be read. This file pins:
//
//   1. which business day counts as "the last whole one", through the org's own
//      week and its exceptions, including a closed Sunday and a holiday;
//   2. the quiet alarm: nothing at all, and plenty but none from a Slate user, as
//      two different sentences; flowing clears it; unreadable measures nothing;
//   3. the unreadable alarm: any unreadable reason pages, zero clears, unreadable
//      counts measure nothing;
//   4. disarmed: measure, send nothing, clear nothing.
import { lastClosedBusinessDay, type BusinessWindow } from "@/lib/booking/business-hours";
import {
  runRegalFeedQuietCheck,
  runRegalFeedUnreadableCheck,
  formatRegalFeedQuietAlert,
  countsFromRows,
  REGAL_CALLS_QUIET_KEY,
  REGAL_CALLS_UNREADABLE_KEY,
  REGAL_UNREADABLE_WINDOW_MS,
  type RegalReasonCounts,
} from "@/lib/monitor/regal-call-feed";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
// Monday to Saturday, 8am to 8pm, Sunday shut: the seeded week.
const RULES: BusinessWindow[] = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1200 }));
const HOURS = { zone: ZONE, rules: RULES, exceptions: [] as { on_date: string; is_open: boolean; start_minute: number | null; end_minute: number | null; note: string | null }[] };

// 2026-09-24 is a Thursday. 14:00Z is 10:00 ET.
const THU_10AM = Date.UTC(2026, 8, 24, 14, 0, 0);
const THU_9PM = Date.UTC(2026, 8, 25, 1, 0, 0);
const MON_10AM = Date.UTC(2026, 8, 28, 14, 0, 0);

// --- 1. the day ----------------------------------------------------------------

{
  const d = lastClosedBusinessDay(HOURS, THU_10AM);
  eq(d?.isoDate, "2026-09-23", "mid Thursday, the last WHOLE business day is Wednesday");
  eq(d?.openMs, Date.UTC(2026, 8, 23, 12, 0, 0), "it opened at 8am ET");
  eq(d?.closeMs, Date.UTC(2026, 8, 24, 0, 0, 0), "and closed at 8pm ET");
}
eq(lastClosedBusinessDay(HOURS, THU_9PM)?.isoDate, "2026-09-24", "after Thursday's close, Thursday is whole");
eq(lastClosedBusinessDay(HOURS, MON_10AM)?.isoDate, "2026-09-26", "Monday morning looks back past the shut Sunday to Saturday");
eq(
  lastClosedBusinessDay({ ...HOURS, exceptions: [{ on_date: "2026-09-26", is_open: false, start_minute: null, end_minute: null, note: "holiday" }] }, MON_10AM)?.isoDate,
  "2026-09-25",
  "a holiday exception is skipped the same way, through windowOnDate",
);
eq(lastClosedBusinessDay({ ...HOURS, rules: [] }, THU_10AM), null, "an org with no open day in the lookback has no day to judge");

// --- 2. the quiet alarm ----------------------------------------------------------

function quietHarness(counts: RegalReasonCounts | Error, armed = true) {
  const pages: { key: string; text: string }[] = [];
  const resolved: { key: string; text: string }[] = [];
  let since = "";
  const run = () =>
    runRegalFeedQuietCheck({
      hours: HOURS,
      loadCounts: async (sinceIso) => {
        since = sinceIso;
        if (counts instanceof Error) throw counts;
        return counts;
      },
      armed,
      notify: async (key, _ms, text) => {
        pages.push({ key, text });
      },
      resolve: async (key, text) => {
        resolved.push({ key, text });
        return true;
      },
      cooldownMs: 24 * 60 * 60_000,
      nowMs: THU_10AM,
    });
  return { run, pages, resolved, since: () => since };
}

{
  const h = quietHarness({});
  const r = await h.run();
  eq(r.status, "quiet", "nothing at all since Wednesday's open is quiet");
  eq(h.since(), new Date(Date.UTC(2026, 8, 23, 12, 0, 0)).toISOString(), "counted from the last whole day's open");
  eq(h.pages.map((p) => p.key), [REGAL_CALLS_QUIET_KEY], "and pages on its own key");
  assert(/nothing|no call event/i.test(h.pages[0].text), "the empty feed says nothing arrived at all");
  assert(/Settings > Integrations/.test(h.pages[0].text), "and where in Regal to look");
  eq(h.resolved.length, 0, "and clears nothing");
}
{
  const h = quietHarness({ ai_agent: 4120, agent_email_null: 1800, no_slate_user: 3 });
  const r = await h.run();
  eq(r.status, "quiet", "thousands of events and none from a Slate user is still quiet");
  const text = h.pages[0].text;
  assert(text.includes("5,923"), "the busy but empty feed says how many arrived");
  assert(text.includes("4,120"), "and breaks them down by reason");
  assert(text !== formatRegalFeedQuietAlert({ isoDate: "2026-09-23", openMs: 0, closeMs: 0 }, {}), "the two quiet shapes read differently");
}
{
  const h = quietHarness({ candidate: 7, ai_agent: 4000 });
  const r = await h.run();
  eq(r.status, "flowing", "one call from a Slate user is enough");
  eq(h.pages.length, 0, "flowing pages nothing");
  eq(h.resolved.map((x) => x.key), [REGAL_CALLS_QUIET_KEY], "flowing is the measured healthy result that clears it");
}
{
  const h = quietHarness(new Error("rpc refused"));
  const r = await h.run();
  eq(r.status, "unmeasured", "an unreadable count measures nothing");
  eq([h.pages.length, h.resolved.length], [0, 0], "and neither pages nor clears");
}
{
  const h = quietHarness({}, false);
  const r = await h.run();
  eq(r.status === "quiet" ? r.paged : null, false, "disarmed: quiet is measured and says it was not sent");
  eq(h.pages.length, 0, "disarmed sends nothing");
  const h2 = quietHarness({ candidate: 1 }, false);
  await h2.run();
  eq(h2.resolved.length, 0, "disarmed clears nothing");
}
{
  const r = await runRegalFeedQuietCheck({
    hours: { ...HOURS, rules: [] },
    loadCounts: async () => {
      throw new Error("must not be asked");
    },
    armed: true,
    notify: async () => {},
    resolve: async () => true,
    cooldownMs: 1,
    nowMs: THU_10AM,
  });
  eq(r.status, "unmeasured", "no business day to judge is unmeasured, and costs no read");
}

// --- 3. the unreadable alarm -----------------------------------------------------

function unreadableHarness(counts: RegalReasonCounts | Error, armed = true) {
  const pages: { key: string; text: string }[] = [];
  const resolved: { key: string; text: string }[] = [];
  let since = "";
  const run = () =>
    runRegalFeedUnreadableCheck({
      loadCounts: async (sinceIso) => {
        since = sinceIso;
        if (counts instanceof Error) throw counts;
        return counts;
      },
      armed,
      notify: async (key, _ms, text) => {
        pages.push({ key, text });
      },
      resolve: async (key, text) => {
        resolved.push({ key, text });
        return true;
      },
      cooldownMs: 6 * 60 * 60_000,
      nowMs: THU_10AM,
    });
  return { run, pages, resolved, since: () => since };
}

{
  const h = unreadableHarness({ candidate: 40, ai_flag_unreadable: 12, timestamp_unreadable: 1 });
  const r = await h.run();
  eq(r.status, "unreadable-events", "any unreadable reason leaving zero pages");
  eq(h.since(), new Date(THU_10AM - REGAL_UNREADABLE_WINDOW_MS).toISOString(), "over the trailing window");
  eq(h.pages.map((p) => p.key), [REGAL_CALLS_UNREADABLE_KEY], "on its own key");
  assert(h.pages[0].text.includes("13"), "naming how many");
  assert(h.pages[0].text.includes("is_ai_agent"), "and which field stopped being readable");
  assert(!/lead@|\+1555/.test(h.pages[0].text), "and never quoting a body");
}
{
  const h = unreadableHarness({ candidate: 40, ai_agent: 900 });
  const r = await h.run();
  eq(r.status, "clean", "no unreadable event is clean");
  eq(h.resolved.map((x) => x.key), [REGAL_CALLS_UNREADABLE_KEY], "and clean clears it");
}
{
  const h = unreadableHarness(new Error("rpc refused"));
  const r = await h.run();
  eq(r.status, "unmeasured", "unreadable counts measure nothing");
  eq([h.pages.length, h.resolved.length], [0, 0], "and neither page nor clear");
}
{
  const h = unreadableHarness({ body_unreadable: 2 }, false);
  const r = await h.run();
  eq(r.status === "unreadable-events" ? r.paged : null, false, "disarmed measures and says it did not send");
  eq(h.pages.length, 0, "disarmed sends nothing");
}

// --- the RPC rows ---------------------------------------------------------------

eq(countsFromRows([{ reason: "candidate", events: "7" }, { reason: "ai_agent", events: 40 }]), { candidate: 7, ai_agent: 40 }, "bigint counts arrive as strings and are read as numbers");
for (const bad of [[{ reason: "made_up", events: 1 }], [{ reason: "ai_agent", events: "many" }]]) {
  let threw = false;
  try {
    countsFromRows(bad);
  } catch {
    threw = true;
  }
  assert(threw, `an unknown reason or unreadable count is refused, never summed around (${JSON.stringify(bad)})`);
}

finish();
