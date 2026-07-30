// Repo invariant (#1049): a bare `.catch(() => {})` may sit on a NOTIFICATION,
// never on real work.
//
// Slate deliberately swallows a failed alert send: a monitoring failure must not
// become a booking failure. That is ~56 of the 69 bare catches in src/ and it is
// correct. The other kind is a defect: a push-triggered sync, a time-off
// approval, an event-deletion enqueue, a slot recompute or a reservation cleanup
// that fails leaves ZERO trace anywhere, so there is nothing to search for when
// someone eventually notices the symptom three days later.
//
// The 2026-07-23 audit named five such sites and estimated ~30 bare catches. It
// was 69, and two real-work sites it missed were the worst of them: a Slack OOO
// approve/reject (an approval the requester was told about, silently vanishing)
// and enqueueEventDeletion (a Google calendar event orphaned forever).
//
// Fixing 13 instances would leave the class open (L30), so the boundary lives
// here. The escape hatch is `// swallow-ok: <why>` on, or in the `//` block
// directly above, the line.
//
// Run: node --experimental-strip-types scripts/test-bare-catch-boundary.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  scanBareCatches,
  offendingBareCatches,
  NOTIFIER_CALLS,
  OPT_OUT,
} from "./lib/scan-bare-catches.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

// --- unit coverage for the scanner, including the shapes that would false-pass -
const NOTIFIER_SRC = `
await sendThrottledAlert("k", 1, "t").catch(() => {});
`;
eq(offendingBareCatches(NOTIFIER_SRC).length, 0, "a notifier send is allowed");

// The shape the real codebase takes: the call opens several lines above and the
// `.catch` hangs off the closing paren, so a line-local check sees no callee.
const MULTILINE_NOTIFIER = `
  await sendThrottledAlert(
    "recompute_headroom",
    HEADROOM_ALERT_COOLDOWN_MS,
    recomputeHeadroomAlert(a, b),
  ).catch(() => {});
`;
eq(
  offendingBareCatches(MULTILINE_NOTIFIER).length,
  0,
  "a MULTI-LINE notifier send is allowed (the callee is found by walking back to the statement)",
);

const REAL_WORK = `
await recomputeBucketSlotsForToday(code, true).catch(() => {});
`;
eq(offendingBareCatches(REAL_WORK).length, 1, "real work with a bare catch is flagged");

const OPTED_OUT_SAME_LINE = `
await doTheThing().catch(() => {}); // swallow-ok: nothing downstream reads it
`;
eq(offendingBareCatches(OPTED_OUT_SAME_LINE).length, 0, "the same-line opt-out is honored");

const OPTED_OUT_ABOVE = `
// swallow-ok: the 1-min cron backstop reconverges this
await doTheThing().catch(() => {});
`;
eq(offendingBareCatches(OPTED_OUT_ABOVE).length, 0, "the opt-out in the block above is honored");

const IN_A_COMMENT = `
// Historically this was written as foo().catch(() => {}) which lost the error.
await realHandler().catch((err) => log.warn("x", {}, err));
`;
eq(
  offendingBareCatches(IN_A_COMMENT).length,
  0,
  "a mention inside a comment is not treated as a call site",
);

const INJECTED_NOTIFIER = `
  await deps
    .notify(KEY, deps.cooldownMs, formatNotice(x))
    .catch(() => {});
`;
eq(
  offendingBareCatches(INJECTED_NOTIFIER).length,
  0,
  "an injected notifier seam (deps.notify) is allowed",
);

// A real handler is not a bare catch at all, so it must not even be a finding.
const REAL_HANDLER = `
await deps.heal(orgIds).catch((err) => log.warn("schedule-coverage", { msg: "heal failed" }, err));
`;
eq(scanBareCatches(REAL_HANDLER).length, 0, "a catch WITH a handler is not a finding");

assert(NOTIFIER_CALLS.length > 0 && OPT_OUT.length > 0, "the scanner's config is non-empty");

// THE FALSE NEGATIVE THAT ALREADY BIT THIS SCANNER. The string-blanking pass has
// to skip comments BEFORE quotes: an apostrophe in ordinary prose used to open a
// fake string that ran until the next apostrophe, blanking the real code between
// them. Three genuine offenders vanished and the scan still printed a confident
// result. A scanner that silently stops finding things is worse than no scanner
// (the repo's most-repeated defect class), so this is pinned.
const APOSTROPHE_IN_PROSE = `
// This doesn't matter, and the agent's calendar isn't involved.
await realWork().catch(() => {});
`;
eq(
  offendingBareCatches(APOSTROPHE_IN_PROSE).length,
  1,
  "an apostrophe in a comment does not blank the code after it (false-negative guard)",
);

// The same shape via a block comment, and via an apostrophe inside a string.
const APOSTROPHE_IN_BLOCK_COMMENT = `
/* The agent's delegation isn't renewed here. */
await realWork().catch(() => {});
`;
eq(
  offendingBareCatches(APOSTROPHE_IN_BLOCK_COMMENT).length,
  1,
  "an apostrophe in a block comment does not blank the code after it",
);

// A real single-quoted string must still be blanked (that is the whole point):
// a brace inside alert copy must not truncate the callee walk-back.
const BRACE_IN_STRING = `
await sendThrottledAlert('key', 1, 'text with } a brace').catch(() => {});
`;
eq(
  offendingBareCatches(BRACE_IN_STRING).length,
  0,
  "a brace inside a string literal still does not hide the notifier callee",
);

// --- positive control: the guard must still catch the real defect -------------
// Re-introduce the exact shape #1049 was filed about and prove it is flagged.
const CONTROL = `
async function confirmBooking() {
  void recomputeBucketSlotsForToday(bucketCode).catch(() => {});
}
`;
const control = offendingBareCatches(CONTROL);
eq(control.length, 1, "positive control: a reintroduced silent recompute IS caught");
assert(
  control[0].statement.includes("recomputeBucketSlotsForToday"),
  "the finding names the call whose failure would be lost",
);

// --- the real scan over src/ --------------------------------------------------
const files = walk(SRC);
assert(files.length > 100, `the scan covers src/ (found ${files.length} files)`);

const offenders: string[] = [];
let bareTotal = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  bareTotal += scanBareCatches(src).length;
  for (const o of offendingBareCatches(src)) {
    offenders.push(`${relative(ROOT, f)}:${o.line}  ${o.statement}`);
  }
}

// The scan must actually be finding the deliberate notifier catches, or a
// silently-broken matcher would report "zero offenders" and read as compliance.
assert(
  bareTotal > 20,
  `the scanner really is matching bare catches in src/ (found ${bareTotal}); a zero here would make the pass below meaningless`,
);

if (offenders.length) {
  console.error(
    `\n${offenders.length} bare .catch(() => {}) on real work (not a notifier send):\n` +
      offenders.map((o) => `  ${o}`).join("\n") +
      `\n\nGive it a handler that logs — .catch((err) => log.warn("<tag>", { msg: "..." }, err)) —` +
      `\nor add "// ${OPT_OUT} <why losing this error is safe>" on or above the line.\n`,
  );
}
eq(offenders.length, 0, "no bare catch in src/ discards a real-work failure");

finish();
