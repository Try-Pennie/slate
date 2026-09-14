// Where a confirm's time actually goes (#2321).
//
// The 2026-09-14 load run measured the request path at a CPU p99 of 4,908ms over
// 1,364 invocations with no cron in the window, against a wall p95 of 4,025ms. CPU
// roughly equals wall, so the confirm path is compute bound rather than waiting on
// anything, and nothing in the run could say WHICH part of it.
//
// Reading the code names candidates and cannot rank them (L355: a profile is a
// shape, not a cost, until the sample count is read; L353: an estimate in a comment
// is a measurement nobody took). So the path times its own named stages under
// SLATE_LOADTEST and the next run's archived log carries the apportionment.
//
// Two things this accounting has to get right, both of which are how a profile
// misleads rather than fails:
//
//   - the named stages plus an explicit RESIDUAL must equal the whole, or a reader
//     takes the named ones for the entire cost and optimises a path that is a
//     fraction of it (L466);
//   - a stage that ran N times must report N, because a cheap thing done forty
//     times and an expensive thing done once are the same total and different fixes.
import { describe, it, expect } from "vitest";
import { makeConfirmProfile, confirmProfileLine } from "./confirm-profile";

/** A clock the test drives, so nothing here waits on real time (L524). */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("makeConfirmProfile", () => {
  it("apportions the total across named stages and an explicit residual", async () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ enabled: true, now: clock.now });
    await p.time("assign", async () => { clock.advance(300); });
    await p.time("insert", async () => { clock.advance(120); });
    // Time the confirm did not spend inside any named stage.
    clock.advance(80);

    const reading = p.read();
    expect(reading).not.toBeNull();
    expect(reading!.totalMs).toBe(500);
    expect(reading!.stages).toEqual([
      { stage: "assign", ms: 300, calls: 1 },
      { stage: "insert", ms: 120, calls: 1 },
    ]);
    // The whole point: what the named stages do NOT account for is stated, never
    // left for a reader to subtract.
    expect(reading!.residualMs).toBe(80);
    expect(reading!.stages.reduce((n, s) => n + s.ms, 0) + reading!.residualMs).toBe(
      reading!.totalMs,
    );
  });

  it("counts how many times a stage ran, not just how long it took in total", async () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ enabled: true, now: clock.now });
    for (let i = 0; i < 4; i++) {
      await p.time("verify-wave", async () => { clock.advance(100); });
    }
    const reading = p.read()!;
    expect(reading.stages).toEqual([{ stage: "verify-wave", ms: 400, calls: 4 }]);
  });

  it("orders the stages by cost, so the reader meets the expensive one first", async () => {
    const clock = fakeClock();
    const p = makeConfirmProfile({ enabled: true, now: clock.now });
    await p.time("cheap", async () => { clock.advance(5); });
    await p.time("dear", async () => { clock.advance(900); });
    await p.time("middling", async () => { clock.advance(50); });
    expect(p.read()!.stages.map((s) => s.stage)).toEqual(["dear", "middling", "cheap"]);
  });

  it("charges a stage that threw for the time it spent before throwing", async () => {
    // A confirm that fails is exactly the one somebody profiles, and a stage that
    // only records on success would report the expensive failing step as free.
    const clock = fakeClock();
    const p = makeConfirmProfile({ enabled: true, now: clock.now });
    await expect(
      p.time("boom", async () => {
        clock.advance(250);
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(p.read()!.stages).toEqual([{ stage: "boom", ms: 250, calls: 1 }]);
  });

  it("returns the stage's own value, so wrapping a step changes nothing about it", async () => {
    const p = makeConfirmProfile({ enabled: true, now: fakeClock().now });
    await expect(p.time("x", async () => "the answer")).resolves.toBe("the answer");
  });

  it("reads back NOTHING when profiling is off, rather than a row of zeroes", () => {
    // A disabled profile that reported zeroes would render as a confirm that cost
    // nothing, which is the shape of a measurement rather than of an absent one.
    const p = makeConfirmProfile({ enabled: false, now: fakeClock().now });
    expect(p.read()).toBeNull();
  });

  it("never touches the clock when profiling is off", async () => {
    // Production runs with this disabled on every confirm, so the disabled path
    // must cost nothing at all, not merely discard what it measured.
    let reads = 0;
    const p = makeConfirmProfile({ enabled: false, now: () => { reads++; return 0; } });
    await p.time("a", async () => {});
    await p.time("b", async () => {});
    expect(reads).toBe(0);
  });

  it("still returns the stage's value and still throws when profiling is off", async () => {
    const p = makeConfirmProfile({ enabled: false, now: () => 0 });
    await expect(p.time("x", async () => 7)).resolves.toBe(7);
    await expect(p.time("y", async () => { throw new Error("nope"); })).rejects.toThrow("nope");
  });

  it("renders one line naming every stage, its share, and what is unattributed", async () => {
    // The SHARE is what a reader acts on, and computing it from two numbers on a
    // phone mid incident is what nobody does.
    const clock = fakeClock();
    const p = makeConfirmProfile({ enabled: true, now: clock.now });
    await p.time("assign-and-verify", async () => { clock.advance(600); });
    await p.time("reserve", async () => { clock.advance(200); });
    clock.advance(200);

    const line = confirmProfileLine(p.read()!);
    expect(line).toContain("1000ms wall");
    expect(line).toContain("assign-and-verify 600ms (60%, x1)");
    expect(line).toContain("reserve 200ms (20%, x1)");
    // Named, so a reader never takes the named stages for the whole cost.
    expect(line).toContain("unattributed 200ms (20%)");
    expect(line).not.toMatch(/undefined|NaN|\[object/);
  });

  it("says n/a rather than dividing by zero when the whole confirm read as instant", async () => {
    const p = makeConfirmProfile({ enabled: true, now: () => 1000 });
    await p.time("a", async () => {});
    const line = confirmProfileLine(p.read()!);
    expect(line).not.toMatch(/NaN|Infinity/);
    expect(line).toContain("n/a");
  });

  it("reports a residual of zero rather than a negative one on a clock that went backwards", async () => {
    // Workers clocks do not advance inside a synchronous span, so two stages can
    // legitimately read as instant. A negative residual would be nonsense printed
    // beside real numbers.
    const p = makeConfirmProfile({ enabled: true, now: () => 1000 });
    await p.time("a", async () => {});
    const reading = p.read()!;
    expect(reading.residualMs).toBe(0);
    expect(reading.totalMs).toBe(0);
  });
});
