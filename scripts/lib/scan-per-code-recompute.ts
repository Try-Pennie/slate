// Scan logic for the #2357 guard on per CODE slot recomputes, kept beside the
// guard so its positive control can drive it with synthetic sources.
//
// `recomputeBucketSlotsForToday(code)` runs the WHOLE multi agent compute for the
// code's pool and writes one row. Sixty codes resolve to fifteen pools (#2245), so
// a loop of it over a set of codes computes the same pool several times, and with
// no count it has no ceiling. Three every minute sweeps had exactly that loop (the
// sync lane's post sync refresh and both self heal reconciles), and on the load
// test Worker it took a minute tick to 119 s of CPU against the 120 s kill.
//
// So every call site is named, with the reason it is a single code rather than a
// sweep, and a new one fails the build until somebody either routes it through
// `refreshPoolsForAgents` / `recomputePoolsForCodes` or adds it here with a reason.

export interface PerCodeRecomputeSite {
  file: string;
  line: number;
  text: string;
}

/**
 * The sites allowed to call it, each with WHY it is one code and not a sweep.
 * Keyed by repo relative path; the count is how many calls that file may hold.
 */
export const ALLOWED_PER_CODE_RECOMPUTE: Record<string, { count: number; why: string }> = {
  "src/lib/booking/service.ts": {
    count: 1,
    why:
      "invalidateSlots on the cron drains: ONE booking's own bucket, the #503 float, " +
      "debounced per bucket. The user facing paths refresh the POOL, coalesced (#3258)",
  },
  "src/app/api/cron/monitor/route.ts": {
    count: 1,
    why: "the anomaly self heal: one code at a time, each behind its own claimed lock",
  },
};

const CALL = /\brecomputeBucketSlotsForToday\s*\(/;
const DEFINITION = /\bfunction\s+recomputeBucketSlotsForToday\s*\(/;

/** Every call (never the definition) in one file's text. */
export function perCodeRecomputeSites(file: string, text: string): PerCodeRecomputeSite[] {
  const out: PerCodeRecomputeSite[] = [];
  text.split("\n").forEach((line, i) => {
    if (CALL.test(line) && !DEFINITION.test(line)) out.push({ file, line: i + 1, text: line.trim() });
  });
  return out;
}

/** The sites the allowlist does not cover, as human readable findings. */
export function unexpectedPerCodeRecomputes(sites: PerCodeRecomputeSite[]): string[] {
  const byFile = new Map<string, PerCodeRecomputeSite[]>();
  for (const s of sites) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  const findings: string[] = [];
  for (const [file, list] of byFile) {
    const allowed = ALLOWED_PER_CODE_RECOMPUTE[file]?.count ?? 0;
    if (list.length > allowed) {
      findings.push(
        `${file} calls recomputeBucketSlotsForToday ${list.length} time(s), ${allowed} allowed ` +
          `(lines ${list.map((s) => s.line).join(", ")}). A sweep over several codes must use ` +
          "refreshPoolsForAgents or recomputePoolsForCodes (src/lib/availability/slot-cache.ts), " +
          "which compute once per pool under a count; a genuinely single code site goes in " +
          "ALLOWED_PER_CODE_RECOMPUTE with its reason.",
      );
    }
  }
  return findings;
}
