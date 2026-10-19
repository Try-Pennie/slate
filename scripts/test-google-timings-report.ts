// #3490: the report that turns a few days of `confirm answered` lines into the load test's
// `google_delay` value, the same way for whoever runs the delay off and delay on pair.
//
// It reads what `scripts/logs.ts --lines` printed, never the API, so every verdict here is
// driven by fixture text with no network and no clock. The fixtures are synthetic lines in
// the real line's shape, carrying no lead data.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-google-timings-report.ts
import { formatGoogleTimingsReport, parseGoogleTimingsArgs, summariseGoogleTimings, GOOGLE_TIMINGS_EXIT } from "./loadtest/google-timings.ts";
import { parseGoogleDelay } from "../src/lib/google/loadtest-google-delay.ts";
import { formatLine } from "./logs.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** One printed row, through logs.ts's own formatter, so the fixture is what the tool prints. */
const row = (i: number, fields: string) =>
  formatLine({
    id: null,
    timestampMs: Date.UTC(2026, 9, 20, 12, 0, i),
    level: "info",
    message: `slate tag=booking msg="confirm answered" confirm_kind="new" response_ms=1500 status=200${fields ? ` ${fields}` : ""}`,
  });

// The verdict exactly as logs.ts prints it, which echoes the needle unescaped, so the line
// itself holds `msg="confirm answered"` and must never be counted as a confirm.
const verdict = (n: number) =>
  [
    `PRESENT: "msg="confirm answered"" matched ${n} line(s) between 2026-10-20T00:00:00.000Z and 2026-10-22T00:00:00.000Z.`,
    `control ("tag=recompute") matched 2880: the control is present and recent.`,
  ].join("\n");

// Twenty single call reads at 100..2000ms, twenty single call writes at 300..6000ms.
const rows: string[] = [];
for (let i = 1; i <= 20; i++) {
  rows.push(row(i, `google_read_ms=${i * 100} google_read_calls=1 google_write_ms=${i * 300} google_write_calls=1 google_mint_ms=${i * 10} google_mint_calls=1`));
}
// Two multi call confirms, kept in the per confirm figure and out of the per call one.
rows.push(row(21, "google_read_ms=9000 google_read_calls=3"));
rows.push(row(22, "google_write_ms=7000 google_write_calls=2"));
// A dry run (books nothing) and a confirm with no Google call at all.
rows.push(row(23, "dry_run=true google_read_ms=50000 google_read_calls=1"));
rows.push(row(24, ""));

// --- a complete listing gives the delay string, from single call confirms ---------------
{
  const stdout = [...rows, verdict(rows.length)].join("\n");
  const r = summariseGoogleTimings(stdout, 0);
  assert(r.kind === "report", `complete: a report (got ${r.kind})`);
  if (r.kind === "report") {
    eq(r.listed, 24, "complete: every listed confirm line is counted");
    eq(r.counted, 24, "complete: the count logs.ts printed is read");
    eq(r.dryRuns, 1, "complete: the dry run is left out and said");
    eq(r.incomplete, false, "complete: not flagged incomplete");
    eq(r.groups.read.perConfirm?.n, 21, "read: every non dry run confirm that made a read");
    eq(r.groups.read.perCall?.n, 20, "read: only single call confirms give the per call figure");
    eq(r.groups.read.perCall?.p50, 1100, "read: nearest rank median of 100..2000");
    eq(r.groups.read.perCall?.p95, 2000, "read: nearest rank p95 of 100..2000");
    eq(r.groups.read.perConfirm?.max, 9000, "read: the multi call confirm counts per confirm");
    eq(r.groups.write.perCall?.p50, 3300, "write: median of the single call writes");
    eq(r.groups.write.perCall?.p95, 6000, "write: p95 of the single call writes");
    eq(r.groups.mint.perCall?.n, 20, "mint: reported too, though the delay has no mint");
    eq(r.googleDelay, "read=1100/2000,write=3300/6000", "the google_delay value, from the per call figures");
    // The value is one the Worker and the preflight accept.
    assert(parseGoogleDelay(r.googleDelay ?? "").unknown === null, "the value parses as a google_delay setting");
    eq(r.exit, GOOGLE_TIMINGS_EXIT.complete, "complete: exit 0");
    const text = formatGoogleTimingsReport(r).join("\n");
    assert(text.includes("listed 24 of 24 counted"), `complete: the report says what it read (got ${text})`);
    assert(text.includes("google_delay: read=1100/2000,write=3300/6000"), `complete: the value is printed (got ${text})`);
    assert(/mint[^\n]*not delayed/.test(text), `complete: says the delay does not stand in for the mint (got ${text})`);
  }
}

// --- logs.ts listed fewer rows than it counted (its exit 3): the percentile SAYS so --------
{
  const stdout = [...rows, verdict(30)].join("\n");
  const r = summariseGoogleTimings(stdout, 3);
  assert(r.kind === "report" && r.incomplete, "incomplete: still a report, flagged incomplete");
  if (r.kind === "report") {
    eq(r.exit, GOOGLE_TIMINGS_EXIT.incomplete, "incomplete: exit 3, like logs.ts");
    const text = formatGoogleTimingsReport(r).join("\n");
    assert(text.includes("INCOMPLETE") && text.includes("listed 24 of 30 counted"), `incomplete: the report names the shortfall (got ${text})`);
    assert(/percentiles are over the 24 listed/i.test(text), `incomplete: and says what the percentiles are over (got ${text})`);
  }
  // A shortfall the exit code did not report is still caught from the two numbers.
  const quiet = summariseGoogleTimings(stdout, 0);
  assert(quiet.kind === "report" && quiet.incomplete && quiet.exit === GOOGLE_TIMINGS_EXIT.incomplete, "incomplete: listed below counted is incomplete whatever the exit code");
}

// --- nothing it can stand on refuses rather than printing a delay -------------------------
{
  const stdout = [...rows, verdict(rows.length)].join("\n");
  for (const code of [1, 2, 4, 127]) {
    const r = summariseGoogleTimings(stdout, code);
    assert(r.kind === "refused" && r.exit === GOOGLE_TIMINGS_EXIT.refused, `logs.ts exit ${code}: refused (got ${r.kind})`);
  }
  const noVerdict = summariseGoogleTimings(rows.join("\n"), 0);
  assert(noVerdict.kind === "refused" && /matched/.test(noVerdict.why), "no verdict line: refused, since the count cannot be checked");
  const noFields = summariseGoogleTimings([row(1, ""), row(2, ""), verdict(2)].join("\n"), 0);
  assert(noFields.kind === "refused" && /google_read_ms|no confirm/i.test(noFields.why), "no Google fields at all: refused (the logging is not deployed yet)");
}

// --- one kind the setting cannot hold leaves the other in the value, and says why ----------
{
  const zeroRead = [
    ...Array.from({ length: 5 }, (_, i) => row(i + 1, `google_read_ms=0 google_read_calls=1 google_write_ms=${(i + 1) * 100} google_write_calls=1`)),
  ];
  const r = summariseGoogleTimings([...zeroRead, verdict(zeroRead.length)].join("\n"), 0);
  assert(r.kind === "report", "zero read: a report");
  if (r.kind === "report") {
    eq(r.googleDelay, "write=300/500", "zero read: the write survives without the read");
    assert(r.omitted.length === 1 && r.omitted[0]!.startsWith("read:"), `zero read: the read's omission is named (got ${JSON.stringify(r.omitted)})`);
    const text = formatGoogleTimingsReport(r).join("\n");
    assert(text.includes("left out of google_delay, read:"), `zero read: and printed (got ${text})`);
  }
}

// --- no usable value at all is not a success, however much was printed -------------------
{
  const multiOnly = [row(1, "google_read_ms=900 google_read_calls=2 google_write_ms=800 google_write_calls=2"), row(2, "google_read_ms=700 google_read_calls=3")];
  const r = summariseGoogleTimings([...multiOnly, verdict(multiOnly.length)].join("\n"), 0);
  assert(r.kind === "report" && r.googleDelay === null, "no single call confirm: a report with no value");
  if (r.kind === "report") {
    eq(r.exit, GOOGLE_TIMINGS_EXIT.refused, "no single call confirm: exits refused, never 0");
    eq(r.omitted.length, 2, "no single call confirm: both kinds say why they were left out");
  }
}

// --- the arguments, in either order, the flag's value never taken for the file ------------
{
  eq(parseGoogleTimingsArgs(["lines.txt", "--logs-exit", "3"]), { file: "lines.txt", logsExit: 3 }, "args: file first");
  eq(parseGoogleTimingsArgs(["--logs-exit", "3", "lines.txt"]), { file: "lines.txt", logsExit: 3 }, "args: flag first, its value is not the file");
  eq(parseGoogleTimingsArgs(["lines.txt"]), null, "args: no exit code refuses");
  eq(parseGoogleTimingsArgs(["lines.txt", "--logs-exit", ""]), null, "args: an empty exit code (a failed $(cat ...)) refuses");
  eq(parseGoogleTimingsArgs(["lines.txt", "--logs-exit", "x"]), null, "args: an unreadable exit code refuses");
  eq(parseGoogleTimingsArgs(["--logs-exit", "0"]), null, "args: no file refuses");
}

finish();
