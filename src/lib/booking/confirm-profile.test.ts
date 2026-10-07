// Where a confirm's time actually goes (#2321, #3300).
//
// The 2026-09-14 load run measured the request path at a CPU p99 of 4,908ms over
// 1,364 invocations with no cron in the window, against a wall p95 of 4,025ms. CPU
// roughly equals wall, so the confirm path is compute bound rather than waiting on
// anything, and nothing in the run could say WHICH part of it.
//
// Reading the code names candidates and cannot rank them (L355: a profile is a
// shape, not a cost, until the sample count is read; L353: an estimate in a comment
// is a measurement nobody took). So the path times its own named stages, and since
// #3300 it does so on every confirm, so a slow or timed out one in production can
// say where it waited.
//
// Things this accounting has to get right, every one of which is how a profile
// misleads rather than fails:
//
//   - the named stages plus an explicit RESIDUAL must equal the whole, or a reader
//     takes the named ones for the entire cost and optimises a path that is a
//     fraction of it (L466);
//   - a stage that ran N times must report N, because a cheap thing done forty
//     times and an expensive thing done once are the same total and different fixes;
//   - spans that OVERLAP (parallel calls, a rung inside the stage that walks the
//     ladder) must be counted once, or the remainder goes negative and the covered
//     time exceeds the wall;
//   - the remainder lies on both sides of the stages (L699), so it is split by
//     where it fell rather than handed to one side.
import { describe, it, expect } from "vitest";
import {
  confirmProfileFields,
  confirmProfileLine,
  makeConfirmProfile,
  timeStage,
} from "./confirm-profile";

/** A clock the test drives, so nothing here waits on real time (L524). */
function fakeClock(): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
}

/** A promise the test settles by hand, so two pieces of work can interleave. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}

describe("the load test's window (#2321), unchanged by #3300", () => {
  it("apportions the window across named stages and an explicit residual", async () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now });
    const w = p.window();
    await p.time("assign", async () => { clock.advance(300); });
    await p.time("insert", async () => { clock.advance(120); });
    // Time the confirm did not spend inside any named stage.
    clock.advance(80);

    const reading = w.read();
    expect(reading.totalMs).toBe(500);
    expect(reading.stages).toEqual([
      { stage: "assign", ms: 300, calls: 1 },
      { stage: "insert", ms: 120, calls: 1 },
    ]);
    expect(reading.residualMs).toBe(80);
    expect(reading.stages.reduce((n, s) => n + s.ms, 0) + reading.residualMs).toBe(reading.totalMs);
  });

  it("leaves out every stage that ran before the window opened", async () => {
    // The request profile now starts at the route, and the load test's line still
    // describes the confirm from the point it always did, so its total_ms and the
    // judge reading it keep their meaning.
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now });
    await p.time("route-checks", async () => { clock.advance(700); });
    const w = p.window();
    await p.time("assign", async () => { clock.advance(200); });
    expect(w.read()).toEqual({ totalMs: 200, isolateAgeMs: 0, stages: [{ stage: "assign", ms: 200, calls: 1 }], residualMs: 0 });
  });

  it("counts how many times a stage ran, not just how long it took in total", async () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now });
    const w = p.window();
    for (let i = 0; i < 4; i++) {
      await p.time("verify-wave", async () => { clock.advance(100); });
    }
    expect(w.read().stages).toEqual([{ stage: "verify-wave", ms: 400, calls: 4 }]);
  });

  it("orders the stages by cost, so the reader meets the expensive one first", async () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now });
    const w = p.window();
    await p.time("cheap", async () => { clock.advance(5); });
    await p.time("dear", async () => { clock.advance(900); });
    await p.time("middling", async () => { clock.advance(50); });
    expect(w.read().stages.map((s) => s.stage)).toEqual(["dear", "middling", "cheap"]);
  });

  it("charges a stage that threw for the time it spent before throwing", async () => {
    // A confirm that fails is exactly the one somebody profiles, and a stage that
    // only records on success would report the expensive failing step as free.
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now });
    const w = p.window();
    await expect(
      p.time("boom", async () => {
        clock.advance(250);
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(w.read().stages).toEqual([{ stage: "boom", ms: 250, calls: 1 }]);
  });

  it("returns the stage's own value, so wrapping a step changes nothing about it", async () => {
    const p = makeConfirmProfile({ now: fakeClock().now });
    await expect(p.time("x", async () => "the answer")).resolves.toBe("the answer");
  });

  it("renders one line naming every stage, its share, and what is unattributed", async () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now });
    const w = p.window();
    await p.time("assign-and-verify", async () => { clock.advance(600); });
    await p.time("reserve", async () => { clock.advance(200); });
    clock.advance(200);

    const line = confirmProfileLine(w.read());
    expect(line).toContain("1000ms wall");
    expect(line).toContain("assign-and-verify 600ms (60%, x1)");
    expect(line).toContain("reserve 200ms (20%, x1)");
    expect(line).toContain("unattributed 200ms (20%)");
    expect(line).not.toMatch(/undefined|NaN|\[object/);
  });

  it("says n/a rather than dividing by zero when the whole confirm read as instant", async () => {
    const p = makeConfirmProfile({ now: () => 1000 });
    const w = p.window();
    await p.time("a", async () => {});
    const line = confirmProfileLine(w.read());
    expect(line).not.toMatch(/NaN|Infinity/);
    expect(line).toContain("n/a");
  });

  it("reports a residual of zero rather than a negative one on a clock that went backwards", async () => {
    const p = makeConfirmProfile({ now: () => 1000 });
    const w = p.window();
    await p.time("a", async () => {});
    const reading = w.read();
    expect(reading.residualMs).toBe(0);
    expect(reading.totalMs).toBe(0);
  });
});

// #2340: which of these confirms paid for the isolate starting up. The age is
// measured when the window OPENS, which is where the load test's profile always
// started: by read time the confirm's own seconds have passed, and a warm isolate's
// age would then be indistinguishable from a cold one plus a slow confirm.
describe("the isolate's age, carried on the load test's window", () => {
  it("reports how long before the window this isolate evaluated the module", () => {
    const clock = fakeClock();
    const w = makeConfirmProfile({ now: clock.now }).window(clock.now() - 45_000);
    expect(w.read().isolateAgeMs).toBe(45_000);
  });

  it("is measured when the window opens, not when it is read", () => {
    const clock = fakeClock();
    const w = makeConfirmProfile({ now: clock.now }).window(clock.now() - 12);
    clock.advance(4_000);
    expect(w.read().isolateAgeMs).toBe(12);
  });

  it("never reports a negative age", () => {
    const w = makeConfirmProfile({ now: () => 1_000 }).window(5_000);
    expect(w.read().isolateAgeMs).toBe(0);
  });
});

// #3300: the whole request, read once at the instant the confirm answered.
describe("the request's own reading (#3300)", () => {
  it("states the wall time no stage covers, split by where it fell (L699)", async () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now, startedAt: 1_000 });
    clock.set(1_400); // 400 before any stage
    await p.time("route-checks", async () => { clock.advance(100); });
    clock.advance(2_500); // a gap between stages with nothing awaited
    await p.time("assign-and-verify", async () => { clock.advance(900); });
    clock.advance(50); // after the last stage, building the answer
    const r = p.read(clock.now());

    expect(r.wallMs).toBe(3_950);
    expect(r.stagedMs).toBe(1_000);
    expect(r.unattributed).toEqual({ totalMs: 2_950, beforeMs: 400, betweenMs: 2_500, afterMs: 50 });
    // The parts are the whole: nothing is left for a reader to subtract.
    expect(r.stagedMs + r.unattributed.totalMs).toBe(r.wallMs);
  });

  it("counts overlapping spans once, so parallel work never reads as more than the wall", async () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now, startedAt: 1_000 });
    const a = gate();
    const b = gate();
    // Two stages in flight together: a from 1000 to 1600, b from 1200 to 1900.
    const first = p.time("read-a", () => a.wait);
    clock.set(1_200);
    const second = p.time("read-b", () => b.wait);
    clock.set(1_600);
    a.open();
    await first;
    clock.set(1_900);
    b.open();
    await second;
    clock.set(2_000);
    const r = p.read(clock.now());

    // Each stage is still charged its own span...
    expect(r.stages).toEqual([
      { stage: "read-b", ms: 700, calls: 1 },
      { stage: "read-a", ms: 600, calls: 1 },
    ]);
    // ...but the covered time is the union, 1000 to 1900, never the 1300 sum.
    expect(r.stagedMs).toBe(900);
    expect(r.unattributed).toEqual({ totalMs: 100, beforeMs: 0, betweenMs: 0, afterMs: 100 });
  });

  it("closes a stage still open at the answer, so an early return is charged, not lost", () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now, startedAt: 1_000 });
    p.begin("route-checks");
    clock.set(1_300);
    const r = p.read(clock.now());
    expect(r.stages).toEqual([{ stage: "route-checks", ms: 300, calls: 1 }]);
    expect(r.unattributed.totalMs).toBe(0);
  });

  it("ends a begun stage once, however many times its end is called", () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now, startedAt: 1_000 });
    const end = p.begin("route-checks");
    clock.set(1_100);
    end();
    clock.set(1_500);
    end();
    expect(p.read(clock.now()).stages).toEqual([{ stage: "route-checks", ms: 100, calls: 1 }]);
  });

  it("names each ladder rung walked, in order, with its own time", async () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now, startedAt: 1_000 });
    await p.time("assign-and-verify", async () => {
      await p.rung("411", async () => { clock.advance(4_000); });
      await p.rung("311", async () => { clock.advance(1_500); });
    });
    const r = p.read(clock.now());
    expect(r.rungs).toEqual([{ code: "411", ms: 4_000 }, { code: "311", ms: 1_500 }]);
    // A rung sits inside the stage that walks the ladder, so it is never a second
    // claim on the same time.
    expect(r.stagedMs).toBe(5_500);
  });

  it("charges a rung that threw, which is the rung a deadline struck in", async () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now, startedAt: 1_000 });
    await expect(p.rung("112", async () => { clock.advance(9_000); throw new Error("deadline"); })).rejects.toThrow("deadline");
    expect(p.read(clock.now()).rungs).toEqual([{ code: "112", ms: 9_000 }]);
  });

  it("totals dependency calls per dependency, with the slowest one, counting overlap once", () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now, startedAt: 1_000 });
    // Three Supabase reads, two of them in parallel, and a Google call.
    p.call("supabase", 1_000, 1_300);
    p.call("supabase", 1_100, 1_500);
    p.call("supabase", 2_000, 2_100);
    p.call("google freeBusy", 2_100, 2_900);
    p.call("google token mint", 2_100, 2_200);
    clock.set(3_000);
    const r = p.read(clock.now());
    expect(r.calls).toEqual({
      count: 5,
      ms: 1_400, // 1000 to 1500, 2000 to 2900
      byDependency: [
        { dependency: "google", calls: 2, ms: 800, maxMs: 800 },
        { dependency: "supabase", calls: 3, ms: 600, maxMs: 400 },
      ],
      // #3511: the slowest single call by its full label, which byDependency folds away.
      slowest: { label: "google freeBusy", ms: 800 },
    });
  });

  it("renders the reading as counts and milliseconds only", async () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now, startedAt: 1_000 });
    await p.time("route-checks", async () => { clock.advance(100); });
    await p.time("assign-and-verify", async () => {
      await p.rung("112", async () => {
        p.call("supabase", clock.now(), clock.now() + 200);
        clock.advance(9_000);
      });
    });
    clock.advance(10);
    const fields = confirmProfileFields(p.read(clock.now()));
    expect(fields).toEqual({
      stages_run: 2,
      stages: "assign-and-verify:9000/1,route-checks:100/1",
      staged_ms: 9_100,
      unattributed_ms: 10,
      unattributed_before_ms: 0,
      unattributed_between_ms: 0,
      unattributed_after_ms: 10,
      rungs_walked: 1,
      rung_ms: "112:9000",
      calls_made: 1,
      calls_ms: 200,
      calls_by: "supabase:200/1/200",
      slowest_call: "supabase:200",
    });
    for (const v of Object.values(fields)) expect(String(v)).not.toMatch(/undefined|NaN|\[object|null/);
  });

  it("leaves the calls out on a request whose calls nobody watched, rather than claiming zero", () => {
    // The admin time change runs under no confirm budget, so no call is reported to
    // its profile. Zero there would read as a confirm that waited on nothing (L90).
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now, startedAt: 1_000 });
    clock.set(1_200);
    const r = p.read(clock.now());
    expect(r.calls).toBeNull();
    const fields = confirmProfileFields(r);
    expect(Object.keys(fields).filter((k) => k.startsWith("calls"))).toEqual([]);
  });

  it("says zero rungs and zero calls rather than leaving them out, so absent never reads as unknown", () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ now: clock.now, startedAt: 1_000 });
    // Handed to the confirm budget as its observer: its calls are being watched.
    p.observeCalls();
    clock.set(1_200);
    const fields = confirmProfileFields(p.read(clock.now()));
    expect(fields).toEqual({
      stages_run: 0,
      staged_ms: 0,
      unattributed_ms: 200,
      unattributed_before_ms: 200,
      unattributed_between_ms: 0,
      unattributed_after_ms: 0,
      rungs_walked: 0,
      calls_made: 0,
      calls_ms: 0,
    });
  });

  it("keeps two confirms in one isolate apart: each reads only its own stages and calls", async () => {
    // L748: an isolate serves many requests at once, so the profile is per request
    // state. Two confirms interleave here on one clock and must not mix.
    const clock = fakeClock();
    const one = makeConfirmProfile({ now: clock.now, startedAt: 1_000 });
    const two = makeConfirmProfile({ now: clock.now, startedAt: 1_000 });
    one.observeCalls();
    two.observeCalls();
    const g1 = gate();
    const g2 = gate();
    const a = one.time("assign-and-verify", () => one.rung("411", () => g1.wait));
    const b = two.time("reserve", () => g2.wait);
    two.call("supabase", 1_000, 1_100);
    clock.set(1_500);
    g2.open();
    await b;
    clock.set(2_000);
    g1.open();
    await a;
    const r1 = one.read(clock.now());
    const r2 = two.read(clock.now());
    expect(r1.stages).toEqual([{ stage: "assign-and-verify", ms: 1_000, calls: 1 }]);
    expect(r1.rungs).toEqual([{ code: "411", ms: 1_000 }]);
    expect(r1.calls?.count).toBe(0);
    expect(r2.stages).toEqual([{ stage: "reserve", ms: 500, calls: 1 }]);
    expect(r2.rungs).toEqual([]);
    expect(r2.calls?.count).toBe(1);
  });

  it("times a stage through an absent profile by running the work and nothing else", async () => {
    await expect(timeStage(undefined, "x", async () => 7)).resolves.toBe(7);
    await expect(timeStage(undefined, "y", async () => { throw new Error("nope"); })).rejects.toThrow("nope");
  });
});
