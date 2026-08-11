/**
 * Pure half of the availability-truth LIVE positive control (#1377).
 *
 * The drift probe (#1315) scores a calendar it cannot read as `unverified`, so a
 * probe whose Google reads never succeed looks exactly like a probe finding
 * nothing wrong. It also cannot prove itself from production traffic: every
 * bucket on its rotation offers zero times while the roster is dark before
 * cutover (#1272), so the live half is never reached at all.
 *
 * This builds the two control windows the probe is then asked about, from
 * Google's OWN answer for a calendar rather than from Slate's cache. Deriving
 * them from `busy_blocks` would be the L58 mistake: the cache is written from
 * the same reads the control is meant to vouch for, so the comparison would pass
 * for a reason unrelated to whether Google can be read at all.
 *
 * Nothing here talks to Google or the database, so the whole decision surface is
 * driven node-natively by scripts/test-availability-truth-live-control.ts.
 */
import { parseStampMs } from "../../src/lib/date/stamp.ts";

/** One busy period as Google reports it: ISO bounds, either possibly garbage. */
export interface BusyInterval {
  start: string;
  end: string;
}

export interface ControlWindow {
  startIso: string;
  endIso: string;
}

export interface ControlWindows {
  /** A window we independently know is occupied. The probe must call it `drift`. */
  busy: ControlWindow;
  /** A window we independently know is clear. The probe must call it `free`. */
  free: ControlWindow;
}

export type ControlPick = { ok: true; windows: ControlWindows } | { ok: false; why: string };

export interface ControlOptions {
  nowMs: number;
  /** How far ahead to look for a free window. */
  horizonMs: number;
  /** The booking length the probe checks over. */
  durationMs: number;
  /** Granularity of the forward walk for the free window. */
  stepMs: number;
}

interface Span {
  startMs: number;
  endMs: number;
}

/**
 * Both control windows, or a refusal naming the one that could not be built.
 *
 * Refusing is the point. A control run that quietly drops the direction it could
 * not build would report success having proved half of what it claims, and
 * "found nothing to check" would be indistinguishable from "checked and passed"
 * (L98). So an empty calendar, a calendar busy for the whole horizon, and an
 * unreadable bound are each a non-success outcome with a reason.
 */
export function pickControlWindows(busy: BusyInterval[], opts: ControlOptions): ControlPick {
  const spans: Span[] = [];
  for (const b of busy) {
    // parseStampMs, never a bare Date.parse (#1169 / L50): NaN compares false
    // against every threshold, so an unreadable bound would silently overlap
    // nothing and hand back a "free" window that is free only in the sense that
    // we failed to read the thing occupying it. One shared helper decides
    // readable-or-null, and null is mapped to the fail-safe side right here.
    const startMs = parseStampMs(b.start);
    const endMs = parseStampMs(b.end);
    // The fail-safe side is refusing the whole set. An unreadable bound poisons
    // BOTH directions: it cannot host a busy window, and it cannot be ruled out
    // of a free one either, so dropping it would quietly shrink the control
    // rather than fail it.
    if (startMs === null || endMs === null) {
      return { ok: false, why: `a busy interval has an unreadable bound (${b.start} to ${b.end})` };
    }
    if (endMs > startMs) spans.push({ startMs, endMs });
  }
  spans.sort((a, b) => a.startMs - b.startMs);

  const busyWindow = pickBusyWindow(spans, opts);
  if (!busyWindow) {
    return {
      ok: false,
      why:
        "no busy control: the calendar has no busy period at least " +
        `${Math.round(opts.durationMs / 60_000)} minutes long still ahead of now`,
    };
  }
  const freeWindow = pickFreeWindow(spans, opts);
  if (!freeWindow) {
    return {
      ok: false,
      why:
        "no free control: the calendar is busy for every window in the next " +
        `${Math.round(opts.horizonMs / 3_600_000)} hours`,
    };
  }
  return { ok: true, windows: { busy: busyWindow, free: freeWindow } };
}

/**
 * A window sitting ENTIRELY inside one busy period.
 *
 * Entirely matters. A window that merely overlaps a meeting still contains
 * genuinely free minutes, and the probe answering `free` for it would be
 * correct while the control scored it a failure, so the control would page about
 * itself. An in-progress meeting still counts as long as enough of it is left.
 */
function pickBusyWindow(spans: Span[], opts: ControlOptions): ControlWindow | null {
  for (const s of spans) {
    const startMs = Math.max(s.startMs, opts.nowMs);
    if (startMs + opts.durationMs <= s.endMs) {
      return {
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(startMs + opts.durationMs).toISOString(),
      };
    }
  }
  return null;
}

/**
 * The first window ahead of now that overlaps nothing.
 *
 * Overlap is half-open on purpose: a meeting ending exactly when the window
 * starts leaves the window clear, and treating that as a conflict would make a
 * back-to-back calendar look like it had no free time anywhere.
 */
function pickFreeWindow(spans: Span[], opts: ControlOptions): ControlWindow | null {
  const limit = opts.nowMs + opts.horizonMs;
  for (let startMs = opts.nowMs; startMs + opts.durationMs <= limit; startMs += opts.stepMs) {
    const endMs = startMs + opts.durationMs;
    const clash = spans.some((s) => s.startMs < endMs && s.endMs > startMs);
    if (!clash) {
      return { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
    }
    // Jump straight to the end of whatever is blocking, rather than stepping
    // through a long meeting one step at a time.
    const blocking = spans.filter((s) => s.startMs < endMs && s.endMs > startMs);
    const furthest = Math.max(...blocking.map((s) => s.endMs));
    if (furthest > startMs) startMs = Math.max(startMs, furthest - opts.stepMs);
  }
  return null;
}

/** The probe's verdict vocabulary, mirrored so this file stays import-free. */
export type ControlVerdict = "free" | "drift" | "unverified";

export interface ControlJudgement {
  ok: boolean;
  failures: string[];
}

/**
 * Judge the pair.
 *
 * Both directions have to hold. A control that only checked the busy side is
 * satisfied by a probe hard-wired to answer `drift`, and one that only checked
 * the free side is satisfied by a probe that never reads a calendar at all,
 * since an empty read looks free (L1). `unverified` is a FAILURE on either side,
 * not a skip: it is the exact state this control exists to distinguish from
 * healthy.
 */
export function judgeControlVerdicts(
  busyVerdict: ControlVerdict,
  freeVerdict: ControlVerdict,
): ControlJudgement {
  const failures: string[] = [];
  if (busyVerdict === "unverified") {
    failures.push(
      "the busy control came back unverified: the calendar could not be read at all, " +
        "which is the state the probe reports as silence",
    );
  } else if (busyVerdict !== "drift") {
    failures.push(
      "the busy control came back free: a window Google itself reports as occupied " +
        "read as bookable, so the probe is not seeing that calendar's events",
    );
  }
  if (freeVerdict === "unverified") {
    failures.push(
      "the free control came back unverified: the calendar could not be read at all, " +
        "which is the state the probe reports as silence",
    );
  } else if (freeVerdict !== "free") {
    failures.push(
      "the free control came back drift: a window Google itself reports as clear " +
        "read as busy, so the probe is calling everything occupied",
    );
  }
  return { ok: failures.length === 0, failures };
}
