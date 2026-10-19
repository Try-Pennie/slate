/**
 * Production's Google read and write time, as the load test's `google_delay` value (#3490).
 *
 * Every `confirm answered` line carries the confirm's Google time per group
 * (`googleTimingFields`, `src/lib/booking/confirm-profile.ts`): `google_read_ms` and
 * `google_read_calls` for the live free/busy check, `google_write_ms` and
 * `google_write_calls` for the calendar writes, `google_mint_ms` and `google_mint_calls`
 * for the token mint, each absent on a confirm that made no such call. This reads a window
 * of those lines, as `scripts/logs.ts --lines` printed them, and prints the p50 and p95 the
 * delay is set from. Read only: it reads a file and the API is never touched here.
 *
 * Usage (RUNBOOK, "The Google delay"):
 *
 *   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/logs.ts \
 *     'msg="confirm answered"' --from <iso> --to <iso> --lines > lines.txt; echo $? > exit.txt
 *   node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *     scripts/loadtest/google-timings.ts lines.txt --logs-exit "$(cat exit.txt)"
 *
 * **Per call, not per confirm.** The stand in draws one delay per CALL, while `_ms` on the
 * line is the covered time of all that confirm's calls in the group. The two are the same
 * number exactly when the confirm made one such call, so the delay value comes from the
 * single call confirms, and the per confirm spread over every confirm is printed beside it
 * so a reader sees when the two diverge.
 *
 * **A short listing says so.** `logs.ts --lines` can list fewer rows than it counted (its
 * exit 3: a slice that filled the request limit, or rows the events view did not return).
 * The percentiles are then over the rows listed, which may not be a fair sample of the
 * window, and the report says INCOMPLETE and exits 3 rather than printing a value that
 * reads as the whole window (L98). The shortfall is judged from both the exit code given
 * and the two numbers in the file, so a forgotten `--logs-exit` cannot hide it.
 *
 * Percentiles are the judge's own nearest rank (`percentiles` in `judge-booking-run.ts`),
 * so this and a load run's report read a p95 the same way (L41).
 */
import { readFileSync } from "node:fs";
import { percentiles } from "./judge-booking-run.ts";
import { isEntryPoint } from "../lib/run-alerter.ts";
import { formatGoogleDelay, parseGoogleDelay, GOOGLE_DELAY_MAX_MS, type GoogleDelaySetting } from "../../src/lib/google/loadtest-google-delay.ts";
import { GOOGLE_TIMING_GROUPS } from "../../src/lib/booking/confirm-profile.ts";

export const GOOGLE_TIMINGS_EXIT = {
  /** Every counted line was listed, and a value was produced. */
  complete: 0,
  /**
   * Nothing to stand on: logs.ts could not verify, found nothing or exited with a code that is
   * not one of its answers, no line carries the fields, or no kind gave a usable value.
   */
  refused: 2,
  /** Percentiles printed, over fewer lines than the window holds. */
  incomplete: 3,
} as const;

/** Below this many single call confirms a p95 is a handful of rows, so the report warns. */
export const THIN_SAMPLE = 100;

type Kind = (typeof GOOGLE_TIMING_GROUPS)[number]["kind"];
type Spread = { n: number; p50: number; p95: number; max: number } | null;

export interface GoogleTimingsReport {
  kind: "report";
  listed: number;
  counted: number;
  dryRuns: number;
  incomplete: boolean;
  logsExit: number;
  groups: Record<Kind, { perCall: Spread; perConfirm: Spread }>;
  /** The `google_delay` value, or null when neither read nor write had a single call confirm. */
  googleDelay: string | null;
  /** Each kind left out of `googleDelay`, and why. */
  omitted: string[];
  exit: number;
}

export type GoogleTimingsResult = GoogleTimingsReport | { kind: "refused"; why: string; exit: number };

const fieldsOf = (line: string) => new Map([...line.matchAll(/ (\w+)=("[^"]*"|\S+)/g)].map((m) => [m[1]!, m[2]!]));

function spread(values: number[]): Spread {
  const p = percentiles(values);
  return p ? { n: values.length, ...p } : null;
}

/** The report, from what `logs.ts --lines` printed to stdout and the exit code it gave. */
export function summariseGoogleTimings(stdout: string, logsExit: number): GoogleTimingsResult {
  const refused = (why: string) => ({ kind: "refused" as const, why, exit: GOOGLE_TIMINGS_EXIT.refused });
  if (logsExit === 1) return refused("logs.ts found no confirm answered line in the window (exit 1), so there is nothing to measure.");
  if (logsExit === 2) return refused("logs.ts could not verify the window (exit 2); its count is not an answer, so neither is any percentile over it.");
  // Only 0 (a whole listing) and 3 (a short one) are listings at all; anything else is
  // logs.ts failing in a way it does not name (a crash, a missing node), never a pass (L184).
  if (logsExit !== 0 && logsExit !== 3) return refused(`logs.ts exited ${logsExit}, which is not one of its answers (0, 1, 2, 3); read its stderr and run it again.`);
  const lines = stdout.split("\n");
  const verdict = lines.map((l) => /^(PRESENT|ABSENT)\b.* matched (\d+) line\(s\)/.exec(l)).find((m) => m !== null);
  if (!verdict) {
    return refused("the file has no logs.ts verdict line (\"PRESENT: ... matched N line(s)\"), so the listing cannot be checked against the count. Save logs.ts's whole stdout.");
  }
  const counted = Number(verdict[2]);
  // Only the printed rows (`formatLine`: a timestamp, or "(no timestamp)", then two spaces),
  // never the verdict line, which echoes the needle and so also holds `msg="confirm answered"`.
  const rows = lines
    .filter((l) => /^(\d{4}-\d\d-\d\dT\S+|\(no timestamp\)) {2}/.test(l) && l.includes('msg="confirm answered"'))
    .map(fieldsOf);
  const dryRuns = rows.filter((f) => f.get("dry_run") === "true").length;
  const live = rows.filter((f) => f.get("dry_run") !== "true");
  const groups = {} as GoogleTimingsReport["groups"];
  for (const g of GOOGLE_TIMING_GROUPS) {
    const perConfirm: number[] = [];
    const perCall: number[] = [];
    for (const f of live) {
      const ms = Number(f.get(`google_${g.kind}_ms`));
      const calls = Number(f.get(`google_${g.kind}_calls`));
      // Absent means no such call; a field that does not read as a number is not a measurement.
      if (!f.has(`google_${g.kind}_ms`) || !Number.isFinite(ms) || !Number.isFinite(calls)) continue;
      perConfirm.push(ms);
      if (calls === 1) perCall.push(ms);
    }
    groups[g.kind] = { perCall: spread(perCall), perConfirm: spread(perConfirm) };
  }
  if (!groups.read.perConfirm && !groups.write.perConfirm) {
    return refused(
      `none of the ${rows.length} listed confirm answered lines carries google_read_ms or google_write_ms. ` +
        "Either the window predates the logging (#3490) or no confirm in it reached Google.",
    );
  }
  // Each kind is judged on its own, so one the setting cannot hold (a 0ms median, a p95
  // over its ceiling) leaves the other in the value rather than discarding both, and says why.
  const setting: GoogleDelaySetting = { read: null, write: null, unknown: null };
  const omitted: string[] = [];
  for (const k of ["read", "write"] as const) {
    const s = groups[k].perCall;
    if (!s) {
      omitted.push(`${k}: no single call confirm made one`);
      continue;
    }
    const one = formatGoogleDelay({ read: null, write: null, unknown: null, [k]: { p50Ms: s.p50, p95Ms: s.p95 } });
    if (parseGoogleDelay(one).unknown !== null) {
      omitted.push(`${k}: p50 ${s.p50}ms / p95 ${s.p95}ms is not a value the setting accepts (a median above 0, a p95 at most ${GOOGLE_DELAY_MAX_MS}ms)`);
      continue;
    }
    setting[k] = { p50Ms: s.p50, p95Ms: s.p95 };
  }
  const value = formatGoogleDelay(setting);
  const googleDelay = value === "" ? null : value;
  const incomplete = logsExit === 3 || rows.length < counted;
  return {
    kind: "report",
    listed: rows.length,
    counted,
    dryRuns,
    incomplete,
    logsExit,
    groups,
    googleDelay,
    omitted,
    // No value to dispatch with is not a success, whatever else the report printed (L98).
    exit: googleDelay === null ? GOOGLE_TIMINGS_EXIT.refused : incomplete ? GOOGLE_TIMINGS_EXIT.incomplete : GOOGLE_TIMINGS_EXIT.complete,
  };
}

const n = (x: number) => x.toLocaleString("en-US");
const describe = (s: Spread) => (s ? `n=${n(s.n)}, p50 ${n(s.p50)}ms, p95 ${n(s.p95)}ms, max ${n(s.max)}ms` : "none");

/** The report as lines to print. */
export function formatGoogleTimingsReport(r: GoogleTimingsReport): string[] {
  const out: string[] = [];
  out.push(`confirm answered lines: listed ${n(r.listed)} of ${n(r.counted)} counted (logs.ts exit ${r.logsExit}); ${n(r.dryRuns)} dry run(s) left out.`);
  if (r.incomplete) {
    out.push(
      `INCOMPLETE: logs.ts listed ${n(r.listed)} of ${n(r.counted)} lines, so the percentiles are over the ${n(r.listed)} listed, ` +
        "which may not be a fair sample of the window. Narrow the window or the slices (--slice-minutes) until the listing is whole.",
    );
  }
  for (const g of GOOGLE_TIMING_GROUPS) {
    const { perCall, perConfirm } = r.groups[g.kind];
    const note = g.kind === "mint" ? " (not delayed by the stand in, which delays free/busy and event calls only)" : "";
    out.push(`${g.kind}${note}:`);
    out.push(`  per call (single call confirms): ${describe(perCall)}`);
    out.push(`  per confirm (covered time, every confirm that made one): ${describe(perConfirm)}`);
    if (g.kind !== "mint" && perCall && perCall.n < THIN_SAMPLE) {
      out.push(`  WARNING: only ${n(perCall.n)} single call confirms; a p95 over so few is a handful of rows. Widen the window.`);
    }
  }
  out.push(`google_delay: ${r.googleDelay ?? "none"}`);
  for (const why of r.omitted) out.push(`  left out of google_delay, ${why}`);
  return out;
}

/** The file and the exit code from the arguments, in either order, or null when either is missing. */
export function parseGoogleTimingsArgs(argv: readonly string[]): { file: string; logsExit: number } | null {
  let file: string | null = null;
  let logsExit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--logs-exit") {
      // The flag's value is consumed here, so it can never be taken for the file.
      const raw = argv[++i];
      logsExit = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
      if (logsExit === null) return null;
    } else if (!a.startsWith("--") && file === null) {
      file = a;
    } else {
      return null;
    }
  }
  return file !== null && logsExit !== null ? { file, logsExit } : null;
}

function main(argv: string[]): number {
  const args = parseGoogleTimingsArgs(argv);
  if (!args) {
    console.error("usage: google-timings.ts <file holding logs.ts --lines stdout> --logs-exit <logs.ts exit code>");
    return GOOGLE_TIMINGS_EXIT.refused;
  }
  const r = summariseGoogleTimings(readFileSync(args.file, "utf8"), args.logsExit);
  if (r.kind === "refused") {
    console.error(`REFUSED: ${r.why}`);
    return r.exit;
  }
  for (const line of formatGoogleTimingsReport(r)) console.log(line);
  return r.exit;
}

if (isEntryPoint(import.meta.url)) process.exit(main(process.argv.slice(2)));
