import type { LaneHealthRow } from "@/lib/monitor/health";
import { ChevronRightIcon } from "@/components/icons";

/**
 * The admin Overview's cron lane row (#288, rebuilt for #1767).
 *
 * It reads the dead-man's-switch heartbeats (a stamp = a SUCCESSFUL tick), so a
 * silently-wedged lane is visible in-app without opening the Cloudflare dashboard.
 * Presentational and read-only; the page does the heartbeat read and passes the
 * classified rows.
 *
 * #1767 collapsed it. Nine lanes agreeing is ONE fact, and printing it nine times
 * (nine dots, all saying "just now", wrapping onto a second line) is what made the
 * bottom of the page read as debug output. So the resting state is one derived
 * sentence and the nine lanes sit behind a disclosure.
 *
 * The part that must not erode: **the summary names every lane that is not ok**,
 * in the lane's own third state. `stale` (past its bound) and `never` (the
 * heartbeat read fine and there is no stamp at all) are different conditions with
 * different remedies, and a collapse that only counted stale lanes would fold a
 * `never` lane into "all 9 lanes ran on time" (L98: nothing to report and could
 * not check anything must never render the same). So the offenders are named in
 * the summary, closed, and expanding is for detail rather than for the verdict.
 */

/**
 * A prose age phrase, used BOTH for a lane's own age and for the page's derived
 * "everything checked out ..." headline. One formatter rather than two, because
 * the page's headline is computed from the oldest of these same inputs and two
 * spellings of one age would drift (L370).
 */
export function agoPhrase(ageMs: number | null): string {
  if (ageMs === null) return "no run yet";
  if (ageMs < 60_000) return "just now";
  const min = Math.floor(ageMs / 60_000);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * A window every lane fits inside, ROUNDED UP. "all within the last 11 minutes"
 * has to be true of the least recent lane, so rounding down would understate it
 * by up to a minute and make the sentence false of the one lane it is about.
 */
export function withinPhrase(ageMs: number): string {
  const min = Math.ceil(ageMs / 60_000);
  if (min <= 1) return "minute";
  if (min < 60) return `${min} minutes`;
  const hours = Math.ceil(min / 60);
  if (hours < 24) return hours === 1 ? "hour" : `${hours} hours`;
  const days = Math.ceil(hours / 24);
  return days === 1 ? "day" : `${days} days`;
}

/**
 * The three states a row on the Overview can be in: measured healthy, measured
 * bad, and could-not-measure. Never flattened to a tick or a cross, because a
 * read that failed and a fleet that is fine are different screens (L10, L530).
 */
export type LaneSummaryVerdict = "ok" | "attention" | "unmeasured";

export interface LaneSummary {
  verdict: LaneSummaryVerdict;
  /** One sentence, for the page's status row. */
  summary: string;
}

/** Every lane that is not `ok`, named, so the collapse hides detail and not news. */
export function summariseLanes(rows: LaneHealthRow[], unavailable: boolean): LaneSummary {
  if (unavailable) {
    return {
      verdict: "unmeasured",
      summary:
        "Lane health unavailable: the heartbeats could not be read, so no lane is being reported as healthy or as stale.",
    };
  }
  if (rows.length === 0) {
    // Fail loud, not silent: no rows would otherwise render as an all clear over
    // a bounds map that covers nothing.
    return {
      verdict: "unmeasured",
      summary:
        "Lane health unavailable: no lane is covered by a staleness bound, so there is nothing here to report.",
    };
  }

  const stale = rows.filter((r) => r.state === "stale");
  const never = rows.filter((r) => r.state === "never");
  const named = (rs: LaneHealthRow[]) => rs.map((r) => r.lane).join(", ");
  const parts: string[] = [];
  if (stale.length > 0) {
    parts.push(
      `${stale.length} past ${stale.length === 1 ? "its" : "their"} bound (${named(stale)})`,
    );
  }
  if (never.length > 0) {
    parts.push(
      `${never.length} with no successful tick recorded yet (${named(never)})`,
    );
  }

  if (parts.length === 0) {
    // "all within the last ..." rather than "the oldest ...", deliberately: the
    // page's own headline already says "oldest reading" about something DIFFERENT
    // (how fresh the data behind a row is, not how long ago a lane last ran), and
    // both sentences sit on one screen, where one word naming two units reads as a
    // contradiction (L118).
    const oldest = rows.reduce((worst, r) => Math.max(worst, r.ageMs ?? 0), 0);
    return {
      verdict: "ok",
      summary: `All ${rows.length} lanes ran on time, all within the last ${withinPhrase(oldest)}.`,
    };
  }
  return { verdict: "attention", summary: `Of ${rows.length} lanes, ${parts.join(", and ")}.` };
}

/**
 * Reinforcement only. Each lane's state is spelled out beside its dot by
 * `laneStateText`, so the colour is decorative under 1.4.11 and never the signal
 * (measured on the light theme: green 1.96:1, mercury lower still, both far under
 * 3:1, which would be a failure if the dot were carrying the state).
 */
const DOT: Record<LaneHealthRow["state"], string> = {
  ok: "bg-pennie-green",
  stale: "bg-[var(--pennie-rose)]",
  never: "bg-[var(--pennie-mercury)]",
};

/** What one lane says about itself, in words. Colour is never the only signal. */
function laneStateText(row: LaneHealthRow): string {
  if (row.state === "never") return "no successful tick recorded yet";
  if (row.state === "stale") {
    return `${agoPhrase(row.ageMs)}, past its ${Math.round(row.maxStaleMs / 60_000)} minute bound`;
  }
  return agoPhrase(row.ageMs);
}

export function CronLaneHealth({
  rows,
  unavailable = false,
}: {
  rows: LaneHealthRow[];
  unavailable?: boolean;
}) {
  const { summary } = summariseLanes(rows, unavailable);

  // Nothing to disclose: the sentence IS the whole answer, and a disclosure over
  // an empty body would offer a control that can only disappoint (L109).
  if (unavailable || rows.length === 0) {
    return <span>{summary}</span>;
  }

  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        <span>{summary}</span>
        <ChevronRightIcon className="size-4 shrink-0 transition-transform group-open:rotate-90" />
      </summary>
      <ul className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => (
          <li key={row.lane} className="flex items-start gap-2">
            <span
              className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${DOT[row.state]}`}
            />
            <span>
              <span className="font-semibold text-fg">{row.lane}</span>{" "}
              <span className="tabular-nums">{laneStateText(row)}</span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
