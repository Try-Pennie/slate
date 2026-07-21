// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CronLaneHealth } from "./CronLaneHealth";
import type { LaneHealthRow } from "@/lib/monitor/health";

const row = (
  lane: string,
  state: LaneHealthRow["state"],
  ageMs: number | null,
): LaneHealthRow => ({ lane, state, ageMs, maxStaleMs: 10 * 60_000 });

describe("CronLaneHealth (#288)", () => {
  it("renders a badge per lane with a relative last-run label", () => {
    render(
      <CronLaneHealth
        rows={[row("sync", "ok", 3 * 60_000), row("monitor", "ok", 60_000)]}
      />,
    );
    expect(screen.getByText(/sync 3m ago/i)).toBeTruthy();
    expect(screen.getByText(/monitor 1m ago/i)).toBeTruthy();
  });

  it("summarizes stale lanes so a wedged lane is obvious", () => {
    render(
      <CronLaneHealth
        rows={[row("sync", "ok", 60_000), row("recompute", "stale", 15 * 60_000)]}
      />,
    );
    // Leading summary flags the count of stale lanes.
    expect(screen.getByText(/1 stale/i)).toBeTruthy();
    expect(screen.getByText(/recompute 15m ago/i)).toBeTruthy();
  });

  it("labels a never-run lane distinctly (no false last-run)", () => {
    render(<CronLaneHealth rows={[row("watch", "never", null)]} />);
    expect(screen.getByText(/watch no run yet/i)).toBeTruthy();
  });

  it("fails loud when the heartbeat read was unavailable (no empty 'all fine' strip)", () => {
    render(<CronLaneHealth rows={[]} unavailable />);
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
  });
});
