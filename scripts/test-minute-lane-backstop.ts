/**
 * The every minute lanes' backstop (2026-10-29): when Cloudflare stops delivering the
 * `* * * * *` trigger, the five minute tick starts each every minute lane whose last
 * claim on a tick is more than three minutes old.
 *
 * On 2026-10-29 Cloudflare delivered no every minute tick from 08:52:03 to 09:06:33 UTC
 * (4:52 to 5:06 AM ET) while every other schedule fired, and the four lanes on it
 * (sync, recompute, outbox, selfheal, with the reroute hold sweep inside selfheal)
 * stood still for 14 minutes. The five minute ticks at 4:55, 5:00 and 5:05 all ran.
 *
 * Three parts are pinned here, each through fakes:
 *   1. The judgement (src/lib/monitor/minute-lane-claims.ts): which lanes are overdue,
 *      and whether Cloudflare has delivered an every minute tick, read off lane_runs.
 *   2. The dispatch (worker/lane-backstop.ts): the check is asked, only the lanes it
 *      names are started, each through its own route (so its own lock and claim), and
 *      a check that fails or answers nonsense starts NOTHING and says so loudly.
 *   3. The wiring: the entry runs the backstop on the five minute trigger only.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-minute-lane-backstop.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BACKSTOP_CHECK_WINDOW_MS,
  MINUTE_LANE_OVERDUE_MS,
  MINUTE_LANE_PATHS,
  MINUTE_TRIGGER_HEARTBEAT_LANES,
  minuteTriggerReading,
  overdueMinuteLanes,
  parseBackstopAnswer,
  type LaneClaimRow,
} from "../src/lib/monitor/minute-lane-claims.ts";
import { BACKSTOP_CRON, MINUTE_CRON, routesForCron } from "../worker/cron-routes.ts";
import { MINUTE_BACKSTOP_PATH, runMinuteBackstop } from "../worker/lane-backstop.ts";
import { TICK_ID_HEADER, type LaneRunDeps, type LaneTick } from "../worker/lane-run.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);
const row = (tick: string, lane: string, iso: string): LaneClaimRow => ({ tick_id: tick, lane, claimed_at: iso });
const minuteTick = (tick: string, iso: string) =>
  ["sync", "recompute", "outbox", "selfheal"].map((lane) => row(tick, lane, iso));

// ------------------------------------------------------------------ 1. the judgement

eq(MINUTE_CRON, "* * * * *", "the every minute trigger is the one expression it watches");
eq(BACKSTOP_CRON, "*/5 * * * *", "the backstop rides the five minute trigger");
eq([...MINUTE_LANE_PATHS], routesForCron(MINUTE_CRON), "its lanes are DERIVED from the schedule, never listed beside it");
eq(MINUTE_LANE_OVERDUE_MS, 3 * MIN, "a lane is overdue once its last claim is more than three minutes old");
eq([...MINUTE_TRIGGER_HEARTBEAT_LANES].sort(), ["outbox", "recompute", "reroute-hold-sweep", "selfheal", "sync"], "the heartbeat lanes that stop with the trigger, the hold sweep inside selfheal included");
assert(BACKSTOP_CHECK_WINDOW_MS > MINUTE_LANE_OVERDUE_MS, "the check reads further back than the overdue line, so absent means overdue");

const now = at("2026-10-29T09:05:53Z");
{
  // Today's 5:05 AM ET five minute tick: the last every minute tick claimed at 4:51:57.
  const rows = [...minuteTick("aaaa000000000001", "2026-10-29T08:51:57Z"), row("bbbb000000000001", "complete", "2026-10-29T09:05:52Z")];
  eq(overdueMinuteLanes(rows, now).overdue, [...MINUTE_LANE_PATHS], "today at 5:05 AM ET every minute lane is overdue");
}
{
  const fresh = [...minuteTick("aaaa000000000002", new Date(now - 30_000).toISOString())];
  eq(overdueMinuteLanes(fresh, now).overdue, [], "a lane that claimed 30 seconds ago (running or just ran) is never started");
  const edge = [...minuteTick("aaaa000000000003", new Date(now - (3 * MIN - 1_000)).toISOString())];
  eq(overdueMinuteLanes(edge, now).overdue, [], "2:59 old is not overdue");
  const past = [...minuteTick("aaaa000000000004", new Date(now - (3 * MIN + 1_000)).toISOString())];
  eq(overdueMinuteLanes(past, now).overdue, [...MINUTE_LANE_PATHS], "3:01 old is overdue");
}
{
  // One lane behind, the rest current: only that lane.
  const rows = [
    row("aaaa000000000005", "sync", new Date(now - 20_000).toISOString()),
    row("aaaa000000000005", "recompute", new Date(now - 20_000).toISOString()),
    row("aaaa000000000005", "outbox", new Date(now - 20_000).toISOString()),
    row("aaaa000000000006", "selfheal", new Date(now - 6 * MIN).toISOString()),
  ];
  eq(overdueMinuteLanes(rows, now).overdue, ["/api/cron/selfheal"], "only the lane whose own claim is old");
}
{
  // A claim the backstop itself made counts as the lane having run: no second start.
  const rows = [row("bbbb000000000002", "sync", new Date(now - 60_000).toISOString())];
  assert(!overdueMinuteLanes(rows, now).overdue.includes("/api/cron/sync"), "any claim counts as a run, the backstop's own included");
}
{
  // An unreadable stamp can prove nothing about when the lane last ran, so it is not started.
  const rows = [row("aaaa000000000007", "sync", "not a time"), ...minuteTick("aaaa000000000008", new Date(now - 10 * MIN).toISOString()).filter((r) => r.lane !== "sync")];
  const judged = overdueMinuteLanes(rows, now);
  assert(!judged.overdue.includes("/api/cron/sync"), "a lane with an unreadable stamp is not started");
  eq(judged.unreadable, ["/api/cron/sync"], "and is named as unreadable");
}

// Whether Cloudflare delivered the every minute trigger. A tick that claimed ONLY every
// minute lanes is a delivery; a five minute tick that also started a minute lane is the
// backstop, never a delivery.
{
  const delivered = minuteTriggerReading([...minuteTick("aaaa000000000009", new Date(now - 40_000).toISOString())], now, { truncated: false });
  eq(delivered.kind, "delivered", "a minute tick 40 seconds ago is a delivery");
  const today = minuteTriggerReading(
    [
      ...minuteTick("aaaa00000000000a", "2026-10-29T08:51:57Z"),
      ...minuteTick("aaaa00000000000b", "2026-10-29T08:49:23Z"),
      // The 5:05 five minute tick, its backstop starting all four lanes.
      row("bbbb000000000003", "complete", "2026-10-29T09:05:52Z"),
      row("bbbb000000000003", "monitor", "2026-10-29T09:05:52Z"),
      ...minuteTick("bbbb000000000003", "2026-10-29T09:05:54Z"),
    ],
    at("2026-10-29T09:06:08Z"),
    { truncated: false },
  );
  eq(today, { kind: "silent", sinceMs: at("2026-10-29T08:51:57Z") }, "today: silent since 4:51:57 AM ET, the backstop's claims not counted");
  eq(minuteTriggerReading([], now, { truncated: false }), { kind: "silent", sinceMs: null }, "no minute tick in the whole window is silent, since unknown");
  eq(minuteTriggerReading([], now, { truncated: true }).kind, "unknown", "a cut short read that found no delivery claims nothing");
  eq(
    minuteTriggerReading([row("aaaa00000000000d", "sync", "not a time")], now, { truncated: false }).kind,
    "unknown",
    "an unreadable stamp that might be the last delivery claims nothing (L50)",
  );
  const lateButThere = minuteTriggerReading([...minuteTick("aaaa00000000000c", new Date(now - 2 * MIN).toISOString())], now, { truncated: true });
  eq(lateButThere.kind, "delivered", "a delivery found in a cut short read still counts");
}

// The check's answer, as the dispatcher reads it.
{
  eq(parseBackstopAnswer('{"overdue":["/api/cron/sync","/api/cron/outbox"]}'), ["/api/cron/sync", "/api/cron/outbox"], "reads the overdue paths");
  eq(parseBackstopAnswer('{"overdue":[]}'), [], "an empty list starts nothing");
  eq(parseBackstopAnswer('{"overdue":["/api/cron/monitor"]}'), null, "a path that is not an every minute lane makes the whole answer unreadable");
  eq(parseBackstopAnswer('{"overdue":"/api/cron/sync"}'), null, "a non list is unreadable");
  eq(parseBackstopAnswer("not json"), null, "garbage is unreadable");
  eq(parseBackstopAnswer('{"overdue":["/api/cron/sync","/api/cron/sync"]}'), ["/api/cron/sync"], "a repeated path is started once");
}

// ------------------------------------------------------------------ 2. the dispatch

interface Seen {
  paths: string[];
  ticks: (string | null)[];
  errors: { fields: Record<string, unknown> }[];
  infos: { fields: Record<string, unknown> }[];
}

function harness(check: () => Promise<Response>, lane: (path: string) => Promise<Response> = async () => new Response("{}")) {
  const seen: Seen = { paths: [], ticks: [], errors: [], infos: [] };
  let clock = 0;
  const deps: LaneRunDeps = {
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      seen.paths.push(path);
      seen.ticks.push(req.headers.get(TICK_ID_HEADER));
      return path === MINUTE_BACKSTOP_PATH ? check() : lane(path);
    },
    now: () => (clock += 3),
    // A deadline that never arrives: every fake answer is read through to its end.
    wait: () => new Promise<void>(() => {}),
    log: {
      error: (_tag, fields) => seen.errors.push({ fields: fields as Record<string, unknown> }),
      warn: () => {},
      info: (_tag, fields) => seen.infos.push({ fields: fields as Record<string, unknown> }),
    },
  };
  return { deps, seen };
}
const tick: LaneTick = { tickId: "cccc000000000001", cronSecret: "s" };
const all = (paths: string[]) => paths;

async function main() {
  {
    const { deps, seen } = harness(async () => Response.json({ overdue: ["/api/cron/sync", "/api/cron/recompute"] }));
    const out = await runMinuteBackstop(tick, deps, all);
    eq(seen.paths, [MINUTE_BACKSTOP_PATH, "/api/cron/sync", "/api/cron/recompute"], "asks the check, then starts exactly the lanes it named");
    assert(seen.ticks.every((t) => t === tick.tickId), "every request carries the tick, so each lane claims it through its own route");
    eq(out.summary, "started:sync+recompute", "the timings line says which lanes it started");
    eq(out.outcomes.map((o) => o.run.path), ["/api/cron/sync", "/api/cron/recompute"], "their runs come back for the timings line");
  }
  {
    const { deps, seen } = harness(async () => Response.json({ overdue: [] }));
    const out = await runMinuteBackstop(tick, deps, all);
    eq(seen.paths, [MINUTE_BACKSTOP_PATH], "nothing overdue starts nothing");
    eq(out.summary, "none", "and says none");
    eq(seen.errors.length, 0, "a healthy check logs no error");
  }
  for (const [what, check] of [
    ["answered 503", async () => Response.json({ error: "lane_runs could not be read" }, { status: 503 })],
    ["threw", async () => { throw new Error("binding gone"); }],
    ["answered garbage", async () => new Response("<html>")],
    ["named a lane that is not an every minute lane", async () => Response.json({ overdue: ["/api/cron/monitor"] })],
  ] as const) {
    const { deps, seen } = harness(check as () => Promise<Response>);
    const out = await runMinuteBackstop(tick, deps, all);
    eq(seen.paths, [MINUTE_BACKSTOP_PATH], `a check that ${what} starts NOTHING extra`);
    eq(out.summary, "unreadable", `a check that ${what} says unreadable, never none`);
    eq(out.outcomes.length, 0, `a check that ${what} returns no runs`);
    assert(seen.errors.some((e) => e.fields.msg === "the every minute backstop could not read the lanes' claims, so it started nothing"), `a check that ${what} is logged as an error`);
  }
  {
    // SLATE_LANES_DISABLED still holds back a lane the backstop would start.
    const { deps, seen } = harness(async () => Response.json({ overdue: ["/api/cron/sync", "/api/cron/outbox"] }));
    const out = await runMinuteBackstop(tick, deps, (paths) => paths.filter((p) => p !== "/api/cron/outbox"));
    eq(seen.paths, [MINUTE_BACKSTOP_PATH, "/api/cron/sync"], "a lane the deployment holds back is not started");
    eq(out.summary, "started:sync", "and is not named as started");
  }
  {
    // A lane that is already running holds its lock: the backstop's request reaches the
    // lane's own route, which answers that it skipped, and nothing else happens.
    const { deps, seen } = harness(
      async () => Response.json({ overdue: ["/api/cron/sync"] }),
      async () => Response.json({ skipped: "locked" }),
    );
    const out = await runMinuteBackstop(tick, deps, all);
    eq(seen.paths, [MINUTE_BACKSTOP_PATH, "/api/cron/sync"], "the lane is asked once, through its own route and lock");
    assert(out.outcomes[0]?.run.ok === true && out.outcomes[0]?.failure === null, "a lane its lock refused is not a failure");
  }

  // ---------------------------------------------------------------- 3. the wiring
  const entry = readFileSync(join(ROOT, "worker/index.ts"), "utf8");
  assert(/controller\.cron === BACKSTOP_CRON/.test(entry), "the entry runs the backstop on the five minute trigger only");
  assert(/runMinuteBackstop\(tick, deps,/.test(entry), "the entry hands it the tick's own deps");
  assert(/laneDecision\(\s*paths,\s*env\.SLATE_LANES_DISABLED\s*\)\.run/.test(entry), "the backstop's lanes pass the same SLATE_LANES_DISABLED decision");
  finish();
}

void main();
