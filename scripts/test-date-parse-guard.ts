// Repo invariant (#1171): guard against a raw `Date.parse` on a timestamp in the
// paths where an unparseable value lands SILENTLY on the permissive side.
//
// The bug class (#1169, PR #1170): `Date.parse` returns NaN for anything it
// cannot read, every comparison with NaN is false, and so the check quietly
// lands on the healthy / permissive branch: not stale, not due, inside cooldown,
// not due for retry, does not overlap. Ten monitoring sites had it. The fix was
// `parseStampMs` (src/lib/date/stamp.ts), which returns a number or null and
// forces each caller to map null to its own fail-safe side. Nothing stopped new
// code from reintroducing the raw form, and while writing this guard the same
// class turned up live on the verify-on-book path: an unreadable busy interval
// from Google compared false against BOTH slot boundaries, so it read as free
// time on the last check before a booking (fixed in the same change).
//
// A site is COMPLIANT when it does ONE of:
//   - goes through `parseStampMs`, which never returns NaN;
//   - is immediately judged by `Number.isFinite(...)` / `Number.isNaN(...)` /
//     `isNaN(...)` on the same line, so the NaN case is handled explicitly;
//   - carries a `// parse-ok:` opt-out on, or in the `//` block directly above,
//     the line, stating why NaN is impossible or safe there.
//
// SCOPE (deliberate, honest boundary). The guard covers the surface where an
// unreadable stamp is INDISTINGUISHABLE FROM HEALTHY: monitoring, alerting, the
// cron lanes, the health endpoint, the Google boundary (external data we do not
// control), and the booking core that decides whether a slot is free.
//
// It does NOT cover the wider booking / availability domain, where ~40 parses
// read our own NOT NULL `timestamptz` columns and a NaN would surface as an
// obviously broken time rather than as a silent pass. Blanket-annotating those
// would trade real thought for ~40 mechanical comments, the same call made for
// the table-aware capped-read guard. That boundary is stated here so this is
// never read as broader coverage than it has.
// Run: node --experimental-strip-types scripts/test-date-parse-guard.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanRawDateParse } from "./lib/scan-date-parse.ts";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");

// --- positive control: flag the bad shape, allow the safe ones ----------------

interface Fixture {
  name: string;
  flagged: boolean;
  src: string;
}

const FIXTURES: Fixture[] = [
  // FLAGGED: a raw parse whose NaN would pass unnoticed ------------------------
  {
    name: "staleness comparison against a threshold",
    flagged: true,
    src: `const age = nowMs - Date.parse(row.last_run_at);\nif (age > STALE_MS) alert();`,
  },
  {
    name: "expiry comparison",
    flagged: true,
    src: `if (Date.parse(cal.watch_expiration) < nowMs + RENEW_WINDOW_MS) renew();`,
  },
  {
    name: "overlap test on an external busy interval",
    flagged: true,
    src: `return busy.some((b) => Date.parse(b.start) < endMs && Date.parse(b.end) > startMs);`,
  },
  {
    name: "plain assignment with no guard anywhere",
    flagged: true,
    src: `const startMs = Date.parse(row.starts_at);\nreturn { startMs };`,
  },

  // NOT FLAGGED: the NaN case is handled ---------------------------------------
  {
    name: "routed through parseStampMs",
    flagged: false,
    src: `const ms = parseStampMs(row.last_run_at);\nif (ms === null || nowMs - ms > STALE_MS) alert();`,
  },
  {
    name: "Number.isFinite on the same line",
    flagged: false,
    src: `return Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end));`,
  },
  {
    name: "Number.isNaN rejection",
    flagged: false,
    src: `if (Number.isNaN(Date.parse(fromIso))) return { ok: false, error: "Invalid start date." };`,
  },
  {
    name: "bare isNaN rejection",
    flagged: false,
    src: `if (isNaN(Date.parse(input))) throw new Error("bad date");`,
  },

  // NOT FLAGGED: documented escape hatch ---------------------------------------
  {
    name: "parse-ok opt-out on the line above",
    flagged: false,
    src: `// parse-ok: both ends were proven readable by isReadableInterval on the line above\nconst start = Date.parse(b.start);`,
  },
  {
    name: "parse-ok opt-out inside a multi-line comment block",
    flagged: false,
    src: `// starts_at is NOT NULL timestamptz written by us,\n// parse-ok: so it always parses; a NaN here would be a schema break, not input\nconst startMs = Date.parse(row.starts_at);`,
  },

  // NOT FLAGGED: not a Date.parse ----------------------------------------------
  {
    name: "new Date() construction is out of scope",
    flagged: false,
    src: `const d = new Date(iso);\nreturn d.toISOString();`,
  },
];

for (const f of FIXTURES) {
  const found = scanRawDateParse(f.src, "fixture").length > 0;
  assert(found === f.flagged, `${f.flagged ? "flags" : "allows"}: ${f.name}`);
}

// --- real-file mutation control ----------------------------------------------
// booking/core.ts carries `// parse-ok:` opt-outs on its deliberate parses.
// Strip them and those real sites must be flagged, proving the guard verifies
// something against the real code and cannot rot into a no-op.
const corePath = join(ROOT, "src", "lib", "booking", "core.ts");
const coreSrc = readFileSync(corePath, "utf8");
assert(scanRawDateParse(coreSrc, corePath).length === 0, "the real booking/core.ts is clean");
const stripped = coreSrc
  .split("\n")
  // opt-out-matcher-ok: this REMOVES the markers to plant the defect back, so it
  // is a mutation rather than a reading, and there is no exemption for the
  // shared reader to decide.
  .filter((l) => !/^\s*\/\/\s*parse-ok:/i.test(l))
  .join("\n");
assert(
  scanRawDateParse(stripped, corePath).length > 0,
  "positive control: stripping the // parse-ok: opt-outs is caught",
);

// A control on the monitoring surface, which is entirely free of raw parses
// today (that is what #1170 achieved): reintroducing the exact #1169 shape into
// the lane watchdog must be flagged, proving the scan actually reaches there.
const watchdogPath = join(ROOT, "src", "lib", "monitor", "lane-watchdog.ts");
const watchdogSrc = readFileSync(watchdogPath, "utf8");
assert(
  scanRawDateParse(watchdogSrc, watchdogPath).length === 0,
  "the real monitor/lane-watchdog.ts is clean",
);
const reintroduced =
  watchdogSrc +
  `\nfunction _regression(row: { last_seen_at: string }, nowMs: number) {\n  return nowMs - Date.parse(row.last_seen_at) > 600_000;\n}\n`;
assert(
  scanRawDateParse(reintroduced, watchdogPath).length > 0,
  "positive control: a reintroduced raw staleness parse is caught",
);

// --- repo invariant: the covered surface is clean -----------------------------

const SURFACE = [
  join("src", "lib", "monitor"),
  join("src", "lib", "notify"),
  join("src", "lib", "snowflake"),
  join("src", "lib", "google"),
  join("src", "app", "api", "cron"),
  join("src", "app", "api", "health"),
  join("src", "lib", "booking", "core.ts"),
];

function tsxFiles(target: string): string[] {
  if (statSync(target).isFile()) return [target];
  const out: string[] = [];
  for (const e of readdirSync(target, { withFileTypes: true })) {
    const p = join(target, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const surface = SURFACE.flatMap((rel) => tsxFiles(join(ROOT, rel)));
assert(surface.length > 0, `found source files to scan (got ${surface.length})`);

let siteCount = 0;
for (const file of surface) {
  const src = readFileSync(file, "utf8");
  const findings = scanRawDateParse(src, file.slice(ROOT.length + 1));
  siteCount += findings.length;
  for (const fnd of findings) {
    assert(
      false,
      `${fnd.file}:${fnd.line} raw Date.parse on a timestamp; an unparseable value becomes NaN and ` +
        `every comparison with NaN is false, so the check silently lands on the healthy/permissive side. ` +
        `Use parseStampMs (src/lib/date/stamp.ts) and map null to the fail-safe side, check the result with ` +
        `Number.isFinite, or annotate // parse-ok: <why NaN is impossible or safe here> [${fnd.snippet}]`,
    );
  }
}
if (siteCount === 0) {
  console.log(`ok: no unguarded Date.parse across ${surface.length} monitoring, google, and booking-core files`);
}

finish();
