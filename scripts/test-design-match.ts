// The design match score's own logic (claude-config#1364, first used on #3934).
//
// scripts/design-match/score.ts renders frames in Chrome, which this suite does not; what it
// drives is the part that decides: how a frame's illustrations change the fixture both sides draw
// from, and when a score is a match, a miss, or no score at all. The two failure modes worth a
// test are the ones that read as success: a design that fails its own checks (the checks are
// wrong, so nothing they say about the build means anything) and a check that threw.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-design-match.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { CONTENT_READY, frameFixture, offScreenLines, verdict, waitForContent, type FrameResult } from "./lib/design-match.ts";

const day = (open: number, openTimes: string[]) => ({
  iso: "2026-10-19", open, capacity: 10, out: false, openTimes,
  shiftStart: "2026-10-19T13:00:00Z", shiftEnd: "2026-10-19T20:40:00Z", fullShiftStart: "2026-10-19T13:00:00Z", fullShiftEnd: "2026-10-19T21:00:00Z",
});
const base = {
  nearlyFullPct: 85,
  examples: { unsynced: "B", timeOff: { advisor: "A", dayIndex: 0, start: "2026-10-19T17:00:00Z", end: "2026-10-19T18:00:00Z" } },
  picker: { closedWeekday: 7, savedFrom: "2026-10-12", aheadDays: 21 },
  frames: {
    plain: { theme: "light" as const },
    ex: { theme: "light" as const, examples: true },
    full: { theme: "light" as const, illustrate: "today-full" as const },
    picked: { theme: "light" as const, pick: "2026-10-26" },
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

// --- frame fixtures --------------------------------------------------------------
{
  const plain = frameFixture(base, "plain");
  eq(plain.unsynced.length, 0, "a plain frame pretends nothing");
  eq(plain.fixture.advisors[0].days[0].open, 3, "a plain frame keeps the snapshot's numbers");

  const ex = frameFixture(base, "ex");
  eq(ex.unsynced, ["B"], "the examples frame marks the not syncing advisor");
  eq(ex.fixture.advisors[0].days[0].open, 2, "the hour off removes the one call that started inside it");
  eq(ex.fixture.advisors[0].days[0].openTimes, ["2026-10-19T16:00:00Z", "2026-10-19T18:00:00Z"], "a call ending at the hour's start and one starting at its end stay");
  eq(base.snapshot.advisors[0].days[0].open, 3, "a frame never changes the shared fixture it was built from");

  const full = frameFixture(base, "full");
  assert(full.fixture.advisors.every((a: { days: { open: number }[] }) => a.days[0].open === 0), "the full day frame empties today for everyone");

  const picked = frameFixture(base, "picked");
  eq(picked.fixture.advisors[0].days.map((d: { iso: string }) => d.iso), ["2026-10-19", "2026-10-26"], "a picked date joins the days, drawn from the window's last day");

  let threw = false;
  try { frameFixture(base, "missing"); } catch { threw = true; }
  assert(threw, "a frame the fixture does not name is refused, not drawn as a blank one");

  const bad = JSON.parse(JSON.stringify(base));
  bad.snapshot.advisors[0].days[0].openTimes[1] = "not a time";
  let refused = false;
  try { frameFixture(bad, "ex"); } catch { refused = true; }
  assert(refused, "an unreadable time in the fixture is refused, never silently dropped as a call");

  const noLength = JSON.parse(JSON.stringify(base));
  delete noLength.snapshot.eventType;
  let refusedLength = false;
  try { frameFixture(noLength, "ex"); } catch { refusedLength = true; }
  assert(refusedLength, "a fixture with no call length is refused rather than assuming one");
}

// --- the verdict ------------------------------------------------------------------
const met = (id: string) => ({ id, ok: true, detail: "" });
const missed = (id: string) => ({ id, ok: false, detail: "missing" });
const row = (frame: string, picture: number, checks = [met("D1")], designChecks = [met("D1")]): FrameResult => ({ frame, picture, checks, designChecks });

{
  const v = verdict([row("f1", 1), row("f2", 1, [met("D1"), met("D2")], [met("D1"), met("D2")])]);
  eq(v.exitCode, 0, "every decision met and every picture whole is a match");
  eq([v.met, v.of], [2, 2], "decisions are counted once across frames");
}
{
  const v = verdict([row("f1", 0.9999)]);
  eq(v.exitCode, 1, "a frame one pixel short of whole is not a match");
  assert(v.decisionScore === 1, "the decision half can be whole while the picture half is not");
}
{
  const v = verdict([row("f1", 1, [met("D1")]), row("f2", 1, [missed("D1")])]);
  eq(v.exitCode, 1, "a decision met on one frame and missed on another is missed");
  eq(v.met, 0, "it does not count as met");
}
{
  const v = verdict([row("f1", 1, [met("D1")], [missed("D1")])]);
  eq(v.exitCode, 2, "a design failing its own check is no score: the check is wrong, not the build");
  assert(v.reasons.some((r) => /own checks/.test(r)), "and it says so");
}
{
  const v = verdict([row("f1", 1, [{ id: "D1", ok: false, detail: "threw: x", threw: true }])]);
  eq(v.exitCode, 2, "a check that threw is no score, never a miss");
}
{
  const v = verdict([row("f1", 1, [met("D1")], [{ id: "D1", ok: false, detail: "threw: x", threw: true }])]);
  eq(v.exitCode, 2, "a check that threw on the design is no score too");
  assert(v.reasons.some((r) => /threw/.test(r)) && !v.reasons.some((r) => /own checks/.test(r)), "named as a throw, not as the design failing its checks");
}
{
  const v = verdict([{ ...row("f1", 0), loadError: "net::ERR_CONNECTION_REFUSED" }]);
  eq(v.exitCode, 2, "a built page that could not be loaded is no score, never a miss");
  assert(v.reasons.some((r) => /could not be loaded/.test(r)), "and it says which frame and why");
}
{
  const v = verdict([]);
  eq(v.exitCode, 2, "no frames scored is no score, never a match");
}

// --- decisions with no on screen form ----------------------------------------------
{
  const lines = offScreenLines([{ id: "D1" }, { id: "D25", offScreen: "proven by the history lane's tests" }]);
  eq(lines, ["D25: proven by the history lane's tests"], "each decision left off screen is named with where it is proven");
  eq(offScreenLines([{ id: "D1" }]), [], "a map with every decision on screen names none");
}

// --- a built page is pictured only once its content is on screen (#3947) ------------------------
// CI photographed the page's loading placeholder: a streamed page fires load before its content
// arrives on a slow machine. The scorer waits for the design's own hooks, and a page that never
// shows them is no score rather than a picture of a placeholder.
{
  const asked: { selector: string; timeout: number }[] = [];
  const arrives = { waitForSelector: async (selector: string, o: { timeout: number }) => { asked.push({ selector, timeout: o.timeout }); return null; } };
  eq(await waitForContent(arrives, 30_000), undefined, "content that arrives is ready");
  eq(asked, [{ selector: CONTENT_READY, timeout: 30_000 }], "and is asked for by the design's own hooks inside the page");
  const never = { waitForSelector: async () => { throw new Error("Timeout 30000ms exceeded"); } };
  const why = await waitForContent(never, 30_000);
  assert(typeof why === "string" && why.includes(CONTENT_READY), "content that never arrives is a reason not to score, naming what was waited for");
}

finish();
