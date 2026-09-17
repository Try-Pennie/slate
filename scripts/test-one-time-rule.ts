// One time rule, in one module, and no component may carry its own (#1765).
//
// Slate had two time pickers. Each held its own `pad`, its own character for
// character copy of `to24`, and its own quarter hour snapping, and the snapping
// DISAGREED: the time off form rounded a minute in isolation, so `ceil(50 / 15)`
// gave 60, which is not a minute, and it answered 45 with the hour left alone. A
// typed 5:50pm END became 5:45pm, fourteen minutes shorter than asked for, in the
// one direction its own comment said rounding must never take.
//
// Nothing caught it because each implementation was tested against itself. Two
// spellings of one rule, each locally consistent, is why the disagreement
// survived, and it is why this guard is about the CODE rather than about the
// answers: a second implementation is the defect, whether or not it currently
// agrees.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-one-time-rule.ts
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/source-files.ts";
import { scanTimeRules } from "./lib/scan-time-rules.ts";
import { assert, fail, finish } from "./lib/harness.ts";

/** The one module allowed to hold these rules. */
const HOME = "src/lib/date/parse.ts";

/**
 * ALL of `src`, not components only (#2221).
 *
 * It was components only while the rules were about time, which was exactly what
 * #1765 asked and no more. The long DATE rule cannot live inside that boundary:
 * two of the nine copies of the long date format were in `src/lib`
 * (`booker-copy.ts`) and `src/app`, so a components only scan would have reported
 * a clean tree over the very files the issue was about (L98).
 *
 * Widening was measured before it was done rather than assumed safe: across all
 * 537 files of `src`, the existing TIME rules trip exactly one further site,
 * `src/lib/webhooks/regal.ts`, which is a machine payload field pinned by
 * `scripts/test-regal.ts` and already carried its reason in prose. It now carries
 * the opt-out marker as well, which is the whole cost of the widening.
 */
function scannedFiles(): string[] {
  // Through the shared enumeration (#2421), which refuses a listing it cannot
  // believe. The floor below used to be this file's own; it stays, because it is
  // a tighter number than the shared one and it is the thing this suite reports.
  return sourceFiles({
    match: /\.tsx?$/,
    exclude: (f) => /\.test\.tsx?$/.test(f) || f === HOME,
  });
}


// --- the tree ---
{
  const files = scannedFiles();
  // A scan of nothing reports the same empty list a clean tree does (L98), so the
  // count is asserted before its result is read.
  assert(files.length > 100, `the scan really read the tree (${files.length} files)`);
  const offenders = files.flatMap((f) => scanTimeRules(f, readFileSync(f, "utf8")));
  if (offenders.length === 0) {
    assert(true, "nothing in src carries its own time or long date spelling");
  } else {
    for (const o of offenders) fail(`${o.file}:${o.line} ${o.why}`);
  }
}

// --- the home module really does export what everything else must import ---
{
  const home = readFileSync(HOME, "utf8");
  for (const name of [
    "padTwo",
    "timeFrom12Hour",
    "twelveHourParts",
    "snapTimeOfDay",
    "formatTimeOfDay",
    "formatClockTime",
    "formatLongDate",
    "resolveTypedTime",
    "roundUpToQuarterHour",
    "roundDownToQuarterHour",
  ]) {
    assert(
      new RegExp(`export (?:function|const) ${name}\\b`).test(home),
      `${HOME} exports ${name}, so a component never needs its own`,
    );
  }
  // `snapTimeOfDay` must round the whole TIME. A rule that takes a bare minute is
  // the defect, whatever it is called.
  assert(
    /export function snapTimeOfDay\(\s*hhmm: string/.test(home),
    "snapTimeOfDay takes a time, not a minute: rounding a minute in isolation is the bug",
  );
}

// --- positive controls: the exact shapes the tree carried ---
{
  const caught = (code: string, what: string) => {
    assert(scanTimeRules("fixture.tsx", code).length > 0, `caught: ${what}`);
  };
  const allowed = (code: string, what: string) => {
    const hits = scanTimeRules("fixture.tsx", code);
    assert(hits.length === 0, `allowed: ${what}${hits.length ? ` (wrongly flagged: ${hits[0].why})` : ""}`);
  };

  caught('function to24(hour12: number, minute: number, ampm: "AM" | "PM"): string {', "a second to24");
  caught("function from24(hhmm: string) {", "a second from24");
  caught('const pad = (n: number) => String(n).padStart(2, "0");', "a local pad");
  caught("function snapMinute(m: number, dir: string) {", "a second snapMinute");
  caught("  const n = Math.ceil(m / 15) * 15;", "the snapping rule that produced the defect");
  caught("  return Math.floor(min / 15) * 15;", "the same rule rounding the other way");
  caught('return `${dt.toFormat("h:mm")}${dt.toFormat("a").toLowerCase()}`;', "a time spelled inline");
  caught('return dt.toFormat("ccc d LLL, h:mm a");', "a time spelled inside a longer format");
  caught('return start.toFormat("hh:mm a");', "the two digit hour spelling");

  // --- the long DATE spelling (#2221) ---
  caught('return d.toFormat("cccc d LLLL yyyy");', "the British order that shipped on the admin page");
  caught('return d.toFormat("cccc d LLLL");', "the same order without a year");
  caught('return d.toFormat("cccc, LLLL d, yyyy");', "the CORRECT order, still a second copy of it");
  caught('return d.toFormat("cccc, LLLL d");', "the correct order without a year, also a second copy");
  caught('return d.toFormat("LLLL d, cccc");', "the two tokens the other way round");
  caught(
    'const f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" });',
    "the same date built with Intl on one line",
  );
  caught(
    [
      'return new Intl.DateTimeFormat("en-US", {',
      "  timeZone,",
      '  weekday: "long",',
      '  month: "long",',
      '  day: "numeric",',
      "}).format(new Date(iso));",
    ].join("\n"),
    "the same date built with Intl across several lines, which a line scan cannot see",
  );

  caught(
    ['const dayLabel = DateTime.fromISO(day.iso, { zone }).toFormat(', '  "cccc d LLLL",', ");"].join("\n"),
    "a long date whose format string prettier wrapped onto its own line",
  );

  allowed('return dt.toFormat("ccc, LLL d yyyy");', "an ABBREVIATED date, a different format");
  allowed('return dt.toFormat("cccc");', "a bare weekday, which is not a date");
  allowed('return dt.toFormat("LLLL yyyy");', "a month and year, which carries no day");
  allowed(
    'return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(d);',
    "the abbreviated Intl date",
  );
  allowed(
    'return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(d);',
    "an Intl TIME, which names no weekday",
  );
  allowed(
    'return d.toFormat("cccc, LLLL d, yyyy"); // one-date-rule-ok: the shared formatter itself',
    "the long date opt-out with a reason",
  );
  caught(
    'return d.toFormat("cccc, LLLL d, yyyy"); // one-date-rule-ok:',
    "a long date opt-out carrying no reason",
  );
  // The two opt-outs are SEPARATE tokens, so a second rule does not silently widen
  // an exemption somebody wrote about the first (L448).
  caught(
    'return d.toFormat("cccc, LLLL d"); // one-time-rule-ok: a webhook payload field',
    "the TIME opt-out does not exempt a long date",
  );
  caught(
    'return start.toFormat("hh:mm a"); // one-date-rule-ok: a date reason',
    "the DATE opt-out does not exempt a time",
  );
  allowed('return dt.toFormat("HH:mm");', "the 24 hour spelling, which has only ever had one form");
  allowed("import { padTwo, snapTimeOfDay } from \"@/lib/date/parse\";", "importing the shared rules");
  allowed("const step = Math.floor(minutes / 60);", "arithmetic that is not the snapping rule");
  allowed(
    'return start.toFormat("hh:mm a"); // one-time-rule-ok: a webhook payload field, not display',
    "an opt-out with a reason",
  );
  caught(
    'return start.toFormat("hh:mm a"); // one-time-rule-ok:',
    "an opt-out carrying no reason",
  );

  // And the control that matters most: put the DELETED implementation back into
  // the real component and require this guard to catch it there. A scanner that
  // stopped matching and a clean tree produce the same empty list (L98).
  const real = readFileSync("src/components/ui/DateTimeField.tsx", "utf8");
  const reverted = real.replace(
    "const clamp =",
    'function snapMinute(m: number, dir: "down" | "up"): number {\n  if (dir === "up") {\n    const n = Math.ceil(m / 15) * 15;\n    return n >= 60 ? 45 : n;\n  }\n  return Math.floor(m / 15) * 15;\n}\nconst clamp =',
  );
  assert(
    reverted !== real,
    "the overlay found its anchor in the real component, so the control below is real",
  );
  const hits = scanTimeRules("src/components/ui/DateTimeField.tsx", reverted);
  assert(
    hits.length >= 2,
    `reverting the deleted snapMinute into the real component is caught (${hits.length} findings)`,
  );

  // The same control for the DATE rule, in the file the issue was reported
  // against: put the British order back and require this guard to catch it there.
  const exceptions = readFileSync("src/components/ui/BusinessHoursExceptions.tsx", "utf8");
  const britishBack = exceptions.replace(
    /formatLongDate\([^)]*\)/,
    'd.toFormat("cccc d LLLL yyyy")',
  );
  assert(
    britishBack !== exceptions,
    "the overlay found the shared formatter in the real component, so the control below is real",
  );
  assert(
    scanTimeRules("src/components/ui/BusinessHoursExceptions.tsx", britishBack).length > 0,
    "putting the British order back into the real component is caught",
  );
}

finish();
