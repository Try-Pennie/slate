import type { LaneHealthRow } from "@/lib/monitor/health";

/**
 * Compact in-app cron lane-health strip (#288): one badge per scheduled lane with
 * a colored dot (ok / stale / never) and how long ago it last completed. Reads the
 * dead-man's-switch heartbeats (a stamp = a SUCCESSFUL tick), so a silently-wedged
 * lane is visible here without opening the Cloudflare dashboard. Presentational and
 * read-only; the page does the heartbeat read and passes the classified rows.
 */

function ageLabel(ageMs: number | null): string {
  if (ageMs === null) return "no run yet";
  const min = Math.floor(ageMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const DOT: Record<LaneHealthRow["state"], string> = {
  ok: "bg-pennie-green",
  stale: "bg-[var(--pennie-rose)]",
  never: "bg-[var(--pennie-mercury)]",
};

export function CronLaneHealth({
  rows,
  unavailable = false,
}: {
  rows: LaneHealthRow[];
  unavailable?: boolean;
}) {
  if (unavailable) {
    // Fail loud, not silent: an empty strip would read as "no lanes", so say the
    // read failed instead of implying every lane is fine.
    return (
      <p className="text-xs text-fg-muted">
        Cron lane health is unavailable right now (couldn&apos;t read the lane heartbeats).
      </p>
    );
  }

  const staleCount = rows.filter((r) => r.state === "stale").length;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-muted">
      <span className="font-medium">
        Cron lanes
        {staleCount > 0 && (
          <span className="ml-1 text-[var(--pennie-rose)] tabular-nums">
            ({staleCount} stale)
          </span>
        )}
      </span>
      {rows.map((r) => (
        <span
          key={r.lane}
          className="inline-flex items-center gap-1.5 tabular-nums"
          title={
            r.state === "stale"
              ? `${r.lane}: last completed ${ageLabel(r.ageMs)}, past its ${Math.round(
                  r.maxStaleMs / 60_000,
                )}m bound. It may be wedged (stuck lock, repeated error, or not firing).`
              : r.state === "never"
                ? `${r.lane}: no successful tick recorded yet (e.g. since the last deploy).`
                : `${r.lane}: last completed ${ageLabel(r.ageMs)}.`
          }
        >
          <span className={`inline-block h-2 w-2 rounded-full ${DOT[r.state]}`} />
          {r.lane} {ageLabel(r.ageMs)}
        </span>
      ))}
    </div>
  );
}
