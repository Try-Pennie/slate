// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CronLaneHealth, agoPhrase, summariseLanes, withinPhrase } from "./CronLaneHealth";
import type { LaneHealthRow } from "@/lib/monitor/health";

const row = (
  lane: string,
  state: LaneHealthRow["state"],
  ageMs: number | null,
): LaneHealthRow => ({ lane, state, ageMs, maxStaleMs: 10 * 60_000 });

// #1767 collapsed this strip. Nine lanes agreeing is ONE fact, and it used to be
// printed nine times. What must not erode with the collapse is that the summary
// still NAMES every lane that is not ok, in its own third state: a `never` lane
// (the heartbeat read fine and there is no stamp at all) is a different condition
// from a `stale` one, with a different remedy, and a summary that only counted
// stale lanes would fold it into "all lanes ran on time" (L98, L11).
describe("summariseLanes (#1767)", () => {
  it("states agreeing lanes once, naming none of them", () => {
    const { verdict, summary } = summariseLanes(
      [row("sync", "ok", 30_000), row("monitor", "ok", 60_000)],
      false,
    );
    expect(verdict).toBe("ok");
    expect(summary).toBe("All 2 lanes ran on time, all within the last minute.");
    expect(summary).not.toMatch(/sync|monitor/);
  });

  it("states a window every lane really fits inside", () => {
    // Rounded up: "within the last 3 minutes" has to be true of the lane it is
    // about, and rounding down would understate the least recent one.
    const { summary } = summariseLanes(
      [row("sync", "ok", 30_000), row("monitor", "ok", 2 * 60_000 + 30_000)],
      false,
    );
    expect(summary).toBe("All 2 lanes ran on time, all within the last 3 minutes.");
  });

  it("names the stale lanes rather than only counting them", () => {
    const { verdict, summary } = summariseLanes(
      [row("sync", "ok", 60_000), row("recompute", "stale", 15 * 60_000)],
      false,
    );
    expect(verdict).toBe("attention");
    expect(summary).toMatch(/1 past its bound \(recompute\)/);
  });

  it("reports a never-ticked lane in its own words, not as stale", () => {
    const { verdict, summary } = summariseLanes([row("watch", "never", null)], false);
    expect(verdict).toBe("attention");
    expect(summary).toMatch(/no successful tick recorded yet \(watch\)/);
    expect(summary).not.toMatch(/past its bound|ran on time/);
  });

  it("reports both conditions when a run has one of each", () => {
    const { summary } = summariseLanes(
      [row("sync", "stale", 40 * 60_000), row("watch", "never", null), row("outbox", "ok", 0)],
      false,
    );
    expect(summary).toMatch(/1 past its bound \(sync\)/);
    expect(summary).toMatch(/1 with no successful tick recorded yet \(watch\)/);
  });

  it("refuses to report health at all when the heartbeats could not be read", () => {
    const { verdict, summary } = summariseLanes([], true);
    expect(verdict).toBe("unmeasured");
    expect(summary).toMatch(/could not be read/i);
    expect(summary).not.toMatch(/ran on time/);
  });

  it("refuses to report an all clear over a bounds map covering no lane", () => {
    // Zero rows and "every lane is fine" must never render the same (L98).
    const { verdict, summary } = summariseLanes([], false);
    expect(verdict).toBe("unmeasured");
    expect(summary).toMatch(/no lane is covered by a staleness bound/i);
  });
});

describe("agoPhrase (#1767)", () => {
  it("reads as prose at every scale, and never invents a run", () => {
    expect(agoPhrase(null)).toBe("no run yet");
    expect(agoPhrase(0)).toBe("just now");
    expect(agoPhrase(59_000)).toBe("just now");
    expect(agoPhrase(60_000)).toBe("1 minute ago");
    expect(agoPhrase(8 * 60_000)).toBe("8 minutes ago");
    expect(agoPhrase(90 * 60_000)).toBe("1 hour ago");
    expect(agoPhrase(50 * 60 * 60_000)).toBe("2 days ago");
  });
});

describe("withinPhrase (#1767)", () => {
  it("rounds UP, so the window is always true of the lane it describes", () => {
    expect(withinPhrase(0)).toBe("minute");
    expect(withinPhrase(59_000)).toBe("minute");
    expect(withinPhrase(60_000)).toBe("minute");
    expect(withinPhrase(61_000)).toBe("2 minutes");
    expect(withinPhrase(11 * 60_000)).toBe("11 minutes");
    expect(withinPhrase(61 * 60_000)).toBe("2 hours");
    expect(withinPhrase(25 * 60 * 60_000)).toBe("2 days");
  });
});

describe("CronLaneHealth (#288, collapsed by #1767)", () => {
  it("rests as one summary line with every lane behind the disclosure", () => {
    render(
      <CronLaneHealth
        rows={[row("sync", "ok", 3 * 60_000), row("monitor", "ok", 60_000)]}
      />,
    );
    const details = document.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toMatch(/All 2 lanes ran on time/);
    // Collapsed hides detail, not lanes: each is still rendered, with its own age.
    const list = details.querySelector("ul")?.textContent ?? "";
    expect(list).toMatch(/sync 3 minutes ago/);
    expect(list).toMatch(/monitor 1 minute ago/);
  });

  it("labels a never-run lane distinctly from a stale one in the expanded list", () => {
    render(<CronLaneHealth rows={[row("watch", "never", null), row("sync", "stale", 15 * 60_000)]} />);
    const list = document.querySelector("details ul")?.textContent ?? "";
    expect(list).toMatch(/watch no successful tick recorded yet/i);
    expect(list).toMatch(/sync 15 minutes ago, past its 10 minute bound/i);
  });

  it("fails loud when the heartbeat read was unavailable, and offers nothing to expand", () => {
    render(<CronLaneHealth rows={[]} unavailable />);
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
    // A disclosure over an empty body is a control that can only disappoint (L109).
    expect(document.querySelector("details")).toBeNull();
  });
});
