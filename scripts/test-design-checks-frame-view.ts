// The Team capacity design's checks against the fixture they are handed (#3954).
//
// The design match score's web adapter (scripts/design-score/capture-web.mjs) hands every check
// the committed fixture as it is on disk. Several frames draw it with an illustration applied (a
// calendar not syncing, an hour off, a full day), so docs/design/team-capacity.checks.js applies
// them itself, in `frameView`, a browser side copy of what fixtureView does for the page. A copy
// that drifted would have the checks expect numbers neither side draws, and the score would read
// that as the build being wrong, so this suite holds the copy to the original on every frame of
// the real fixture and on a small one where each illustration visibly changes a number. It also
// holds the checks to the design's decision map, the score's denominator: a checked decision with
// no check, or a check on frames the map does not name, would only be found by a browser run.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-design-checks-frame-view.ts
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { assert, eq, finish } from "./lib/harness.ts";
import { fixtureView, type DesignFixtureFile } from "../src/lib/admin/team-capacity-fixture.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

interface Check { id: string; frames: string[] }
interface View { offeredOpenDays: number; advisors: { name: string; days: { open: number; capacity: number; out: boolean }[] }[]; unsynced: string[]; timeOff: string; nearlyFull: number }
const sandbox: { window: { DESIGN_CHECKS?: Check[]; DESIGN_CHECKS_FRAME_VIEW?: (f: unknown, id: string) => View } } = { window: {} };
runInNewContext(read("docs/design/team-capacity.checks.js"), sandbox);
const checks = sandbox.window.DESIGN_CHECKS;
const frameView = sandbox.window.DESIGN_CHECKS_FRAME_VIEW;
if (!checks || !frameView) throw new Error("the checks file sets no window.DESIGN_CHECKS or window.DESIGN_CHECKS_FRAME_VIEW");

/** What fixtureView gives the page for one frame, in the shape the checks read. */
function pageView(fixture: DesignFixtureFile, id: string): View {
  const f = fixtureView(fixture, id);
  // A failed read draws no advisors; the checks still read the snapshot's for that frame.
  const advisors = f.report.measurable ? f.report.advisors : fixture.snapshot.advisors;
  return {
    offeredOpenDays: fixture.snapshot.offeredOpenDays,
    advisors: advisors.map((a) => ({
      name: a.name,
      days: a.days.slice(0, fixture.snapshot.days.length).map((d) => ({ open: d.open, capacity: d.capacity, out: d.out })),
    })),
    unsynced: f.unsynced,
    timeOff: fixture.examples.timeOff.advisor,
    nearlyFull: f.nearlyFullPct,
  };
}

// --- a small fixture, where every illustration moves a number ------------------------------------
const day = (open: number, openTimes: string[]) => ({
  iso: "2026-10-19", open, capacity: 10, out: false, openTimes,
  shiftStart: "2026-10-19T13:00:00Z", shiftEnd: "2026-10-19T20:40:00Z", fullShiftStart: "2026-10-19T13:00:00Z", fullShiftEnd: "2026-10-19T21:00:00Z",
});
const small: DesignFixtureFile = {
  nearlyFullPct: 85,
  examples: { unsynced: "B", timeOff: { advisor: "A", dayIndex: 0, start: "2026-10-19T17:00:00Z", end: "2026-10-19T18:00:00Z" } },
  picker: { closedWeekday: 7, savedFrom: "2026-10-12", aheadDays: 21 },
  pace: { readAt: "2026-10-19T11:30:00Z", days: [{ pace_state: "no-pace-yet", pace_per_hour: null, pace_back_at: null, estimate_method: null, estimate_line_state: null, estimate_line_at: null, estimate_pattern_state: null, estimate_pattern_at: null }] },
  frames: {
    plain: { theme: "light" },
    ex: { theme: "light", examples: true },
    full: { theme: "light", illustrate: "today-full" },
    picked: { theme: "light", pick: "2026-10-26" },
    failed: { theme: "light", failed: true },
  },
  snapshot: {
    takenAt: "2026-10-19T12:00:00Z",
    zone: "America/New_York",
    offeredOpenDays: 1,
    eventType: { duration_min: 20, slot_interval_min: 10, min_notice_min: 5, buffer_before_min: 10, buffer_after_min: 10 },
    days: ["2026-10-19"],
    advisors: [
      { name: "A", timezone: "America/New_York", days: [day(3, ["2026-10-19T16:00:00Z", "2026-10-19T17:20:00Z", "2026-10-19T18:00:00Z"])] },
      { name: "B", timezone: "America/New_York", days: [day(1, ["2026-10-19T15:00:00Z"])] },
    ],
  },
};
{
  const plain = fixtureView(small, "plain");
  eq(plain.unsynced.length, 0, "a plain frame pretends nothing");
  if (!plain.report.measurable) throw new Error("plain is measurable");
  eq(plain.report.advisors[0].days[0].open, 3, "a plain frame keeps the snapshot's numbers");

  const ex = fixtureView(small, "ex");
  if (!ex.report.measurable) throw new Error("ex is measurable");
  eq(ex.unsynced, ["B"], "the examples frame marks the not syncing advisor");
  eq(ex.report.advisors[0].days[0].open, 2, "the hour off removes the one call that started inside it");
  eq(ex.report.advisors[0].days[0].openTimes, ["2026-10-19T16:00:00Z", "2026-10-19T18:00:00Z"], "a call ending at the hour's start and one starting at its end stay");
  eq(small.snapshot.advisors[0].days[0].open, 3, "a frame never changes the shared fixture it was built from");

  const full = fixtureView(small, "full");
  if (!full.report.measurable) throw new Error("full is measurable");
  assert(full.report.advisors.every((a) => a.days[0].open === 0), "the full day frame empties today for everyone");

  const picked = fixtureView(small, "picked");
  if (!picked.report.measurable) throw new Error("picked is measurable");
  eq(picked.report.advisors[0].days.map((d) => d.iso), ["2026-10-19", "2026-10-26"], "a picked date joins the days, drawn from the window's last day");

  let threw = false;
  try { fixtureView(small, "missing"); } catch { threw = true; }
  assert(threw, "a frame the fixture does not name is refused, not drawn as a blank one");
  let threwChecks = false;
  try { frameView(small, "missing"); } catch { threwChecks = true; }
  assert(threwChecks, "and the checks refuse it too, rather than expecting a blank frame");

  const bad = JSON.parse(JSON.stringify(small)) as DesignFixtureFile;
  bad.snapshot.advisors[0].days[0].openTimes[1] = "not a time";
  let refused = false;
  try { fixtureView(bad, "ex"); } catch { refused = true; }
  assert(refused, "an unreadable time in the fixture is refused, never silently dropped as a call");
  let refusedChecks = false;
  try { frameView(bad, "ex"); } catch { refusedChecks = true; }
  assert(refusedChecks, "and the checks refuse it too, rather than expecting totals with that call dropped");

  for (const id of Object.keys(small.frames)) {
    eq(frameView(small, id), pageView(small, id), `the checks see what the page draws on the small fixture's ${id} frame`);
  }
  // The positive control: the copy really is judged, since the illustrations move these numbers.
  const exView = frameView(small, "ex");
  eq([exView.advisors[0].days[0].open, exView.unsynced], [2, ["B"]], "the checks apply the hour off and the not syncing advisor");
  eq(frameView(small, "full").advisors.map((a) => a.days[0].open), [0, 0], "the checks empty today on the full day frame");
}

// --- the real fixture, every frame ---------------------------------------------------------------
const fixture = JSON.parse(read("docs/design/fixtures/team-capacity.json")) as DesignFixtureFile;
const frameIds = Object.keys(fixture.frames);
assert(frameIds.length >= 10, `the fixture names every frame of the design (${frameIds.length})`);
for (const id of frameIds) {
  eq(frameView(fixture, id), pageView(fixture, id), `the checks see what the page draws on ${id}`);
}

// --- the checks against the decision map ---------------------------------------------------------
const design = read("docs/design/team-capacity.html");
const block = (id: string) => {
  const m = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(design);
  if (!m) throw new Error(`the design holds no ${id} block`);
  return JSON.parse(m[1]);
};
const decisions = block("decision-map").decisions as { id: string; verify?: string; frames?: string[]; provenBy?: string }[];
const declared = (block("design-frames").frames as { id: string; width: number }[]).map((f) => f.id);
eq(declared, frameIds, "the design declares exactly the fixture's frames, in its order");
const byId = new Map(checks.map((c) => [c.id, c]));
eq(byId.size, checks.length, "no decision has two checks");
for (const d of decisions) {
  const c = byId.get(d.id);
  if ((d.verify ?? "check") === "check") {
    assert(!!c, `${d.id} is verified by a check, and the checks file has one`);
    if (c) eq(c.frames, d.frames, `${d.id}'s check runs on exactly the frames the map says it shows on`);
  } else {
    assert(!c, `${d.id} is marked "${d.verify}" and has no check beside it`);
  }
}
for (const c of checks) assert(decisions.some((d) => d.id === c.id), `${c.id} is a decision in the map`);
const d25 = decisions.find((d) => d.id === "D25");
eq(d25?.verify, "elsewhere", "history being saved has no on screen form and is proven elsewhere");
assert(!!d25?.provenBy && d25.provenBy.startsWith("scripts/test-capacity-history.ts"), "and the map names the suite that proves it");

finish();
