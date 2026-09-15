// Repo invariant (#1153): every alert Slate can send can be READ before it fires.
//
// The 2026-07-28 sync-failure page dumped eight lines of raw Google JSON cut off
// mid-word, told the reader to re-authenticate an account it had itself labelled
// self-healing, and read "1 of 97 bookable agent". Every one of those defects was
// only visible once RENDERED, during an incident, at 7am. Unit tests assert
// substrings, so they cannot see that a whole message reads badly.
//
// src/lib/notify/alert-preview.ts renders every alert by CALLING the real copy
// builders, and `pnpm preview:alerts` (or the dev-only /dev/alerts page) prints
// them. This guard is what keeps that honest:
//
//   1. every key in the alert catalog has at least one rendered state, so a new
//      alert cannot ship unreadable;
//   2. every condition has a rendered RECOVERY state too, because the all-clear
//      is copy a human reads mid-incident just as much as the page is;
//   3. the previews carry no obvious copy defects (the specific ones that
//      shipped: an undefined/NaN/[object Object] left in a sentence, a raw JSON
//      blob, a value truncated mid-word);
//   4. the render is deterministic, so a preview diff in review means the COPY
//      changed, not that the clock moved.
//
// It deliberately does NOT try to judge whether the wording is good. That is what
// the rendered output is for, read by a person. This only guarantees there is
// something to read, and that it is not obviously broken.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-alert-preview-coverage.ts
import { ALERT_CATALOG } from "../src/lib/notify/alert-catalog.ts";
import { ALERT_PREVIEWS, HANDOFF_NOTICE_PREVIEWS, previewsByKey } from "../src/lib/notify/alert-preview.ts";
import { HANDOFF_KINDS } from "../src/lib/handoffs/kinds.ts";
import { assert, finish } from "./lib/harness.ts";

// --- anti-vacuity -------------------------------------------------------------
// An empty preview list would make every per-key check below pass by default.
assert(
  ALERT_PREVIEWS.length >= 25,
  `the preview set is populated (expected at least 25 rendered states, got ${ALERT_PREVIEWS.length})`,
);
assert(ALERT_CATALOG.length > 0, "the alert catalog is populated");

// --- 1: every alert has something to read -------------------------------------
for (const group of previewsByKey()) {
  assert(
    group.states.length > 0,
    `alert "${group.key}" has no rendered preview, so its wording cannot be read before it fires. ` +
      `Add a state to src/lib/notify/alert-preview.ts that CALLS the real copy builder ` +
      `(extract the text into one if it is still inline at the send site)`,
  );
}

// --- 2: an all-clear is copy too ----------------------------------------------
for (const group of previewsByKey().filter((g) => g.kind === "condition")) {
  if (group.states.length === 0) continue; // already reported above
  assert(
    group.states.some((s) => s.channel === "recovery"),
    `condition "${group.key}" previews its page but not its all-clear. The recovery notice is read ` +
      `by the same person in the same channel, so it needs reading before it ships too`,
  );
}

// --- 3: no obviously broken rendering -----------------------------------------
// Not a judgement about style: these are the exact shapes that have shipped.
const BROKEN: { pattern: RegExp; why: string }[] = [
  { pattern: /\bundefined\b/, why: "a missing value rendered as the word undefined" },
  { pattern: /\bNaN\b/, why: "a number that could not be computed" },
  { pattern: /\[object Object\]/, why: "an object interpolated into a sentence" },
  // "is null" is legitimate prose (naming a nullable column to query); a LEAKED
  // null reads as "for booking null", so only flag it where a value belongs.
  { pattern: /(?<!is )\bnull\b(?![_a-zA-Z])/, why: "a null where a value belongs" },
  { pattern: /\{"|"\}|^\s*\{/m, why: "a raw JSON blob in the body" },
  { pattern: /\bInfinity\b/, why: "an unbounded age rendered literally" },
];

// #2367: the booking handoff notices are read by the sales side and are not catalog
// keys, so they are held here in their own right: every kind has a rendered state,
// and each one is put through the same breakage checks as an alert.
for (const kind of HANDOFF_KINDS) {
  assert(
    HANDOFF_NOTICE_PREVIEWS.some((n) => n.kind === kind),
    `handoff kind "${kind}" has no rendered notice in src/lib/notify/alert-preview.ts, so the ` +
      `words the sales side acts on cannot be read before they ship`,
  );
}
for (const n of HANDOFF_NOTICE_PREVIEWS) {
  for (const { pattern, why } of BROKEN) {
    assert(
      !pattern.test(n.text),
      `handoff notice "${n.kind}" (${n.state}) renders ${why}: ${JSON.stringify(n.text.slice(0, 160))}`,
    );
  }
  assert(!/^\s*Slate\b/i.test(n.text), `handoff notice "${n.kind}" (${n.state}) opens with the word "Slate"`);
}

for (const p of ALERT_PREVIEWS) {
  for (const { pattern, why } of BROKEN) {
    assert(
      !pattern.test(p.text),
      `"${p.key}" (${p.state}) renders ${why}: ${JSON.stringify(p.text.slice(0, 160))}`,
    );
  }
  assert(p.text.trim().length > 0, `"${p.key}" (${p.state}) renders a non-empty message`);
  // No "Slate:" prefix. The reader does need to know instantly which system is
  // talking, and in Slack they already do: every one of these arrives under the
  // Slate app's own name and icon, so an opening "Slate:" repeats the header and
  // pushes the one fact worth having (what is wrong) further along the line, on a
  // surface read on a phone. Naming Slate INSIDE a sentence is fine and often
  // necessary ("an agent Slate still routes to"); only the label is banned.
  // Banned in every label shape it has taken, which is why this tests for the
  // WORD rather than for "Slate:": the copy also carried "Slate routing check:",
  // "Slate routing notice:", "Slate routing ALERT:" and "Slate booking volume is
  // low:", and a check tuned to the colon form would have called those clean.
  assert(
    !/^\s*Slate\b/i.test(p.text),
    `"${p.key}" (${p.state}) opens with the word "Slate"; the Slack app name and icon ` +
      `already say who is speaking, so start with what is wrong. Naming Slate inside a ` +
      `sentence is fine: ${JSON.stringify(p.text.slice(0, 90))}`,
  );
}

// --- 4: deterministic ----------------------------------------------------------
// A preview whose text moved with the wall clock would produce a diff on every
// run, and reviewers would stop reading it.
{
  // typecheck-ok: the ?bust=1 query is what defeats the module cache, which is the
  // whole point of this check; no resolver can follow it, and there is nothing to
  // resolve differently from the plain import at the top of this file.
  const bust = await import("../src/lib/notify/alert-preview.ts?bust=1");
  const again = bust.ALERT_PREVIEWS;
  const first = [
    ...ALERT_PREVIEWS.map((p) => `${p.key}|${p.state}|${p.text}`),
    ...HANDOFF_NOTICE_PREVIEWS.map((n) => `${n.kind}|${n.state}|${n.text}`),
  ].join("\n");
  const second = [
    ...again.map((p: { key: string; state: string; text: string }) => `${p.key}|${p.state}|${p.text}`),
    ...(bust.HANDOFF_NOTICE_PREVIEWS as { kind: string; state: string; text: string }[]).map(
      (n) => `${n.kind}|${n.state}|${n.text}`,
    ),
  ].join("\n");
  assert(first === second, "rendering twice produces identical copy (no wall-clock in the fixtures)");
}

console.log(
  `ok: ${ALERT_PREVIEWS.length} rendered states across ${ALERT_CATALOG.length} alerts`,
);
finish();
