// The deciding half of the design match score (claude-config#1364): pure, so
// scripts/test-design-match.ts drives it without Chrome. scripts/design-match/score.ts does the
// rendering and hands its results here.

/** The fixture file a design's frames and the built page's fixture preview both draw from. */
export interface DesignFixture {
  nearlyFullPct: number;
  examples: { unsynced: string; timeOff: { advisor: string; dayIndex: number; start: string; end: string } };
  frames: Record<string, { theme: string; examples?: boolean; illustrate?: string; [k: string]: unknown }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the snapshot's shape belongs to the design, not to the scorer
  snapshot: any;
}

/** A fixture time, or a throw: an unreadable one would compare false both ways and silently drop a call (L50). */
function stampMs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`the fixture holds an unreadable time: "${iso}"`);
  return ms;
}

/**
 * The data one frame draws, after that frame's illustrations, exactly as the design applies them,
 * so the built page's fixture preview can be checked against the same numbers. A copy: the shared
 * fixture is never changed. A frame the fixture does not name throws rather than drawing nothing.
 */
export function frameFixture(fixture: DesignFixture, id: string) {
  const v = fixture.frames[id];
  if (!v) throw new Error(`the fixture names no frame "${id}"`);
  const snap = JSON.parse(JSON.stringify(fixture.snapshot));
  const unsynced: string[] = [];
  if (v.examples) {
    unsynced.push(fixture.examples.unsynced);
    const t = fixture.examples.timeOff;
    const callMin = fixture.snapshot?.eventType?.duration_min;
    if (!Number.isFinite(callMin) || callMin <= 0) throw new Error("the fixture's snapshot carries no call length (eventType.duration_min)");
    const CALL_MS = callMin * 60_000;
    const s0 = stampMs(t.start);
    const s1 = stampMs(t.end);
    for (const a of snap.advisors) {
      if (a.name !== t.advisor) continue;
      const d = a.days[t.dayIndex];
      d.openTimes = d.openTimes.filter((x: string) => stampMs(x) + CALL_MS <= s0 || stampMs(x) >= s1);
      d.open = d.openTimes.length;
    }
  }
  if (v.illustrate === "today-full") {
    for (const a of snap.advisors) {
      a.days[0].open = 0;
      a.days[0].openTimes = [];
    }
  }
  return { fixture: snap, unsynced, timeOff: fixture.examples.timeOff.advisor, nearlyFull: fixture.nearlyFullPct, frame: id };
}

export interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
  threw?: boolean;
}

export interface FrameResult {
  frame: string;
  /** Share of pixels within tolerance, 0 to 1. */
  picture: number;
  /** The checks run against the built page's frame. */
  checks: CheckResult[];
  /** The same checks run against the design's own frame: the positive control. */
  designChecks: CheckResult[];
  /** Set when the built page could not be loaded at all, as against loaded and wrong. */
  loadError?: string;
}

/**
 * Matched only when every decision is met on every frame it was checked on AND every frame's
 * picture is whole. Exit 0 matched, 1 not matched yet, 2 no score at all: no frames, a check that
 * threw, a built page that could not be loaded, or a design failing its own checks, since then the checks are wrong and say nothing
 * about the build (L1, L98). The three never read alike (L11).
 */
export function verdict(rows: FrameResult[]) {
  const reasons: string[] = [];
  const ids = [...new Set(rows.flatMap((r) => r.checks.map((c) => c.id)))];
  const met = ids.filter((id) => rows.every((r) => r.checks.filter((c) => c.id === id).every((c) => c.ok))).length;
  const decisionScore = ids.length ? met / ids.length : 0;
  const pictureScore = rows.length ? rows.reduce((s, r) => s + r.picture, 0) / rows.length : 0;
  const designFails = rows.flatMap((r) => r.designChecks.filter((c) => !c.ok && !c.threw).map((c) => `${r.frame} ${c.id}: ${c.detail}`));
  if (rows.length === 0) reasons.push("no frames were scored");
  if (designFails.length) reasons.push(`the design fails its own checks, so the checks are wrong, not the build: ${designFails.join("; ")}`);
  if (rows.some((r) => r.checks.some((c) => c.threw) || r.designChecks.some((c) => c.threw))) reasons.push("a check threw while scoring");
  const unloaded = rows.filter((r) => r.loadError);
  if (unloaded.length) reasons.push(`the built page could not be loaded for ${unloaded.map((r) => r.frame).join(", ")}: ${unloaded[0].loadError}`);
  const matched = rows.length > 0 && decisionScore === 1 && rows.every((r) => r.picture === 1);
  const exitCode = reasons.length ? 2 : matched ? 0 : 1;
  return { met, of: ids.length, decisionScore, pictureScore, matched: exitCode === 0, exitCode, reasons };
}

/**
 * One line per decision with no on screen form, naming it and where it is proven instead, so a
 * score is never read as covering a decision it did not check.
 */
export function offScreenLines(checks: { id: string; offScreen?: string }[]): string[] {
  return checks.filter((c) => c.offScreen).map((c) => `${c.id}: ${c.offScreen}`);
}
