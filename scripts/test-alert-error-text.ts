// Repo invariant (#1135): an alert never carries a raw error body.
//
// A page is read on a phone, mid-incident, by someone deciding whether to act. The
// 2026-07-28 sync page (#1133) was eight lines of Google's pretty-printed JSON cut
// off mid-word at `"mess`, and told the reader to re-authenticate an account it
// had itself labelled self-healing. #1133 fixed that one alert; the sweep found
// the same shape in seven more places, worst of all in the chokepoint that reports
// every unexpected server fault, where whatever any library throws goes straight
// to Slack.
//
// The detector lives in scripts/lib/scan-alert-error-text.ts so it is unit
// testable. This file exercises it three ways, which together stop it rotting into
// a no-op: against fixtures (it flags the bad shape and leaves the good ones
// alone), against the real source tree (which must be clean), and against a
// MUTATION of the real files with the formatter calls stripped out (which must be
// caught, proving the scan really reaches production code).
//
// Run: node --experimental-strip-types scripts/test-alert-error-text.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { scanAlertErrorText } from "./lib/scan-alert-error-text.ts";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");
const SRC = join(ROOT, "src");

// --- positive control: the bad shapes are caught -----------------------------

interface Fixture {
  name: string;
  flagged: boolean;
  src: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "a bare .message interpolation",
    flagged: true,
    src: 'await sendThrottledAlert("k", MS, `Slate: insert failed (${error.message}).`);',
  },
  {
    name: "the stringify-then-slice idiom that truncates mid-word",
    flagged: true,
    src: 'await sendThrottledAlert("k", MS, `Slate: send failed: ${String(e).slice(0, 200)}`);',
  },
  {
    name: "a bare error binding",
    flagged: true,
    src: 'await sendThrottledAlert("k", MS, `Slate: it broke (${err}).`);',
  },
  {
    name: "an external system's stored error field",
    flagged: true,
    src: 'await sendThrottledAlert("k", MS, `Slate: check failed. ${health.error ?? "no detail"}.`);',
  },
  {
    name: "an info-channel notice is held to the same rule",
    flagged: true,
    src: 'await sendThrottledInfo("k", MS, `Slate: heads up (${error.message}).`);',
  },
  {
    name: "a recovery notice is held to the same rule",
    flagged: true,
    src: 'await resolveAlert("k", `Slate: recovered after (${e.message}).`);',
  },
  {
    // The shape a first cut of this scanner MISSED, on the worst call site in the
    // tree: reportInternalError built the detail one line earlier and interpolated
    // the name. Follows one hop so the chokepoint for every unexpected fault is
    // not the one place with a blind spot.
    name: "an error-shaped value bound to a local one line earlier",
    flagged: true,
    src: [
      "const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);",
      'await sendThrottledAlert("k", MS, `Slate: server error on ${context} (${detail}).`);',
    ].join("\n"),
  },
  // NOT flagged ---------------------------------------------------------------
  {
    name: "a local bound through the formatter",
    flagged: false,
    src: [
      "const detail = shortErrorReason(err);",
      'await sendThrottledAlert("k", MS, `Slate: server error on ${context} (${detail}).`);',
    ].join("\n"),
  },
  {
    name: "routed through shortFailureReason",
    flagged: false,
    src: 'await sendThrottledAlert("k", MS, `Slate: insert failed (${shortFailureReason(error.message)}).`);',
  },
  {
    name: "routed through shortErrorReason",
    flagged: false,
    src: 'await sendThrottledAlert("k", MS, `Slate: send failed: ${shortErrorReason(e)}`);',
  },
  {
    name: "an alert carrying no error at all",
    flagged: false,
    src: 'await sendThrottledAlert("k", MS, `Slate: ${count} lanes are stale.`);',
  },
  {
    name: "pointing at the column that holds the detail, rather than pasting it",
    flagged: false,
    src: 'await sendThrottledAlert("k", MS, `Slate: ${n} rows stuck. Diagnose via booking_outbox.last_error.`);',
  },
  {
    name: "an error logged rather than alerted",
    flagged: false,
    src: 'log.error("api", { msg: "boom" }, err); const x = `${err.message}`;',
  },
  {
    name: "the escape hatch on the line above",
    flagged: false,
    src: [
      "// alert-text-ok: `reasons` is our own short list, built in this file.",
      'await sendThrottledAlert("k", MS, `Slate: drifted. ${result.error}.`);',
    ].join("\n"),
  },
];

for (const f of FIXTURES) {
  const hits = scanAlertErrorText(f.src, "fixture.ts");
  assert(
    f.flagged ? hits.length > 0 : hits.length === 0,
    `${f.flagged ? "flags" : "allows"}: ${f.name}`,
  );
}

// --- the real source tree must be clean --------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const files = walk(SRC);
assert(files.length > 0, `found source files to scan (${files.length})`);

let clean = true;
for (const path of files) {
  for (const hit of scanAlertErrorText(readFileSync(path, "utf8"), path)) {
    clean = false;
    console.error(
      `FAIL: ${relative(ROOT, path)}:${hit.line} puts a raw error in alert copy ` +
        `(\`${hit.text}\`). Route it through shortFailureReason/shortErrorReason ` +
        `(src/lib/notify/error-text.ts) and leave the full text to log.error, or ` +
        `add "// alert-text-ok: <why>" if it is already short and human.`,
    );
  }
}
assert(clean, "no alert in src/ carries a raw error body");

// --- real-file mutation control ----------------------------------------------
//
// Fixtures prove the detector reads text correctly; this proves it reaches the
// real tree. Strip the formatter calls out of a real file's alerts and the guard
// must catch it, so a green run means something about production code.

// #1153 moved most alert wording into copy builders, so the control moved with
// it: booking/alert-copy.ts is where the booking layer's error text now lives.
const REAL = join(SRC, "lib", "booking", "alert-copy.ts");
const realSrc = readFileSync(REAL, "utf8");
assert(scanAlertErrorText(realSrc, REAL).length === 0, "the real booking/alert-copy.ts is clean");
const reintroduced =
  realSrc +
  "\nexport function _regression(err: Error): string {\n" +
  "  return `Slate: something failed (${err.message}). Check health.`;\n}\n";
assert(
  scanAlertErrorText(reintroduced, REAL).length > 0,
  "mutation control: a raw error interpolated in a copy builder is caught",
);

// And the send sites themselves stay clean.
const SERVICE = join(SRC, "lib", "booking", "service.ts");
const serviceSrc = readFileSync(SERVICE, "utf8");
assert(
  scanAlertErrorText(serviceSrc, SERVICE).length === 0,
  "the real booking/service.ts is clean",
);

finish();
