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
//      changed, not that the clock moved: neither the preview NOR the builders it
//      calls may read the clock, and since #2502 the scan covers both.
//
// It deliberately does NOT try to judge whether the wording is good. That is what
// the rendered output is for, read by a person. This only guarantees there is
// something to read, and that it is not obviously broken.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-alert-preview-coverage.ts
import { ALERT_CATALOG } from "../src/lib/notify/alert-catalog.ts";
import {
  ALERT_PREVIEWS,
  HANDOFF_NOTICE_PREVIEWS,
  INVITE_MOVE_DM_PREVIEWS,
  OWNER_NOTICE_PREVIEWS,
  previewsByKey,
} from "../src/lib/notify/alert-preview.ts";
import { HANDOFF_KINDS } from "../src/lib/handoffs/kinds.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ALERT_PREVIEW, scanAlertCopyClockReads } from "./lib/scan-alert-copy-modules.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = resolve(import.meta.dirname, "..");

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

// #2372: the owner reassign notice, the other thing posted to the handoff channel.
// It is one message rather than a family of kinds, so what is held here is that it
// renders in every state that reads differently: the reason it needs previewing at
// all is that whether to give a SECOND clock is a judgement about a sentence.
assert(
  OWNER_NOTICE_PREVIEWS.length >= 5,
  `the owner reassign notice previews every state that reads differently ` +
    `(expected at least 5, got ${OWNER_NOTICE_PREVIEWS.length}). The advisor in another ` +
    `zone, the advisor already on Eastern, an advisor Slate holds no zone for, another ` +
    `calendar day, and a redacted lead are all different sentences`,
);
for (const n of OWNER_NOTICE_PREVIEWS) {
  for (const { pattern, why } of BROKEN) {
    assert(
      !pattern.test(n.text),
      `owner reassign notice (${n.state}) renders ${why}: ${JSON.stringify(n.text.slice(0, 160))}`,
    );
  }
  assert(n.text.trim().length > 0, `owner reassign notice (${n.state}) renders a non-empty message`);
  assert(!/^\s*Slate\b/i.test(n.text), `owner reassign notice (${n.state}) opens with the word "Slate"`);
  // The manage token is the lead's own key to their call and it can reschedule or
  // cancel it (#1340). A channel is not the lead, and this notice is the one thing
  // in Slate that names a booking to a room full of people.
  assert(
    !n.text.includes("/booking/manage"),
    `owner reassign notice (${n.state}) carries a manage link: ${JSON.stringify(n.text.slice(0, 160))}`,
  );
}

// #3919: the DMs about a moved invite, to the advisor and to their manager. Each
// reads differently for a put back move, a second move and one inside 30 minutes,
// and the advisor's must say where times change and who to ask.
for (const to of ["advisor", "manager"] as const) {
  assert(
    INVITE_MOVE_DM_PREVIEWS.some((n) => n.to === to),
    `the moved invite DM to the ${to} has a rendered state`,
  );
}
for (const n of INVITE_MOVE_DM_PREVIEWS) {
  for (const { pattern, why } of BROKEN) {
    assert(!pattern.test(n.text), `moved invite DM to the ${n.to} (${n.state}) renders ${why}: ${JSON.stringify(n.text.slice(0, 160))}`);
  }
  assert(n.text.trim().length > 0, `moved invite DM to the ${n.to} (${n.state}) renders a non-empty message`);
  assert(!/^\s*Slate\b/i.test(n.text), `moved invite DM to the ${n.to} (${n.state}) opens with the word "Slate"`);
  assert(!n.text.includes("/booking/manage"), `moved invite DM (${n.state}) carries the lead's manage link`);
  if (n.to === "advisor") {
    assert(/not in Google Calendar/.test(n.text), `the advisor's DM (${n.state}) says times change in Slate, not Google`);
    assert(/ask your manager/.test(n.text), `the advisor's DM (${n.state}) says to ask their manager`);
  }
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
    ...OWNER_NOTICE_PREVIEWS.map((n) => `owner-notice|${n.state}|${n.text}`),
    ...INVITE_MOVE_DM_PREVIEWS.map((n) => `invite-dm|${n.to}|${n.state}|${n.text}`),
  ].join("\n");
  const second = [
    ...again.map((p: { key: string; state: string; text: string }) => `${p.key}|${p.state}|${p.text}`),
    ...(bust.HANDOFF_NOTICE_PREVIEWS as { kind: string; state: string; text: string }[]).map(
      (n) => `${n.kind}|${n.state}|${n.text}`,
    ),
    ...(bust.OWNER_NOTICE_PREVIEWS as { state: string; text: string }[]).map(
      (n) => `owner-notice|${n.state}|${n.text}`,
    ),
    ...(bust.INVITE_MOVE_DM_PREVIEWS as { to: string; state: string; text: string }[]).map(
      (n) => `invite-dm|${n.to}|${n.state}|${n.text}`,
    ),
  ].join("\n");
  assert(first === second, "rendering twice produces identical copy (no wall-clock in the fixtures)");
}

// --- 5: and structurally so, by reading the builders' own source (#2502) --------
// The pair above is the cheap half and it is blind to the thing it is named for: the
// clock does not move between two renders a millisecond apart, so a builder reading
// it renders identically twice and differently tomorrow (L713). That is what shipped
// on the booker side as #2497, where `dayWord` read `DateTime.now()`, its test pinned
// the other end, and the suite went red at midnight with nobody having touched the
// code, taking main's deploy with it.
//
// The module list is DERIVED from what the preview imports rather than written out
// here, so a copy builder added tomorrow is covered by construction instead of being
// exempt from the guard meant to catch it (L96).
{
  const io = {
    readFile: (p: string) => readFileSync(p, "utf8"),
    exists: (p: string) => existsSync(p),
  };
  const scan = scanAlertCopyClockReads(ROOT, io);

  // The anti-vacuity floor, for the same reason every other check here has one: a
  // renamed preview, a changed import style or a resolver that found nothing would
  // make every assertion below pass over an empty list (L98).
  assert(
    scan.modules.length >= 30,
    `the preview's copy modules were found (expected at least 30, got ${scan.modules.length})`,
  );
  assert(
    scan.modules.includes(join("src", "lib", "booking", "alert-copy.ts")),
    "including the booking alert copy, so the list really is the preview's own imports",
  );
  eq(
    scan.unresolved.join(", "),
    "",
    "every module the preview imports resolves to a file, so none was silently dropped",
  );

  eq(
    scan.findings.length,
    0,
    "no alert copy builder reads the clock" +
      (scan.findings.length
        ? ` (${scan.findings.map((f) => `${f.file}:${f.line} ${f.read}`).join(", ")})`
        : ""),
  );

  // The controls, without which a path typo or a resolver that matched nothing would
  // report the whole set clean for ever (L1). They use an OVERLAY of the real tree,
  // one file's content replaced in memory, so the plant is never written to the repo.
  {
    const victim = scan.modules.find((m) => m.endsWith(join("ooo", "alert-copy.ts")));
    assert(victim !== undefined, "a real copy module was found to plant a clock read in");

    const overlay = (rel: string, source: string) => ({
      readFile: (p: string) => (p === join(ROOT, rel) ? source : readFileSync(p, "utf8")),
      exists: io.exists,
    });

    const planted = scanAlertCopyClockReads(
      ROOT,
      overlay(
        victim as string,
        `${readFileSync(join(ROOT, victim as string), "utf8")}\n` +
          "export const whenIsIt = () => DateTime.now().toISODate();\n",
      ),
    );
    eq(planted.findings.length, 1, "a builder that DID read the clock is caught");
    eq(
      planted.findings[0]?.file,
      victim,
      "and it is blamed on the module it was planted in, not on the preview",
    );

    // A comment merely naming the clock is not a finding, or the guard would fire on
    // its own explanation of itself and be annotated into silence.
    const talkedAbout = scanAlertCopyClockReads(
      ROOT,
      overlay(
        victim as string,
        `${readFileSync(join(ROOT, victim as string), "utf8")}\n` +
          "// This deliberately takes nowMs rather than calling DateTime.now().\n",
      ),
    );
    eq(talkedAbout.findings.length, 0, "while a comment merely naming the clock is not");

    // A clock read in the PREVIEW itself is caught too. It seeds every builder's
    // fixtures, so a date taken from the clock there moves every rendered message.
    const inPreview = scanAlertCopyClockReads(
      ROOT,
      overlay(
        ALERT_PREVIEW,
        `${readFileSync(join(ROOT, ALERT_PREVIEW), "utf8")}\nconst seededAt = Date.now();\n`,
      ),
    );
    eq(inPreview.findings.length, 1, "a clock read in the preview's own fixtures is caught");

    // An import the tree cannot answer is REPORTED rather than quietly shrinking the
    // scanned set, which is how a rename would leave everything reading as clean.
    const renamed = scanAlertCopyClockReads(
      ROOT,
      overlay(
        ALERT_PREVIEW,
        `import { nothing } from "@/lib/notify/no-such-module";\n${readFileSync(join(ROOT, ALERT_PREVIEW), "utf8")}`,
      ),
    );
    eq(
      renamed.unresolved.join(", "),
      "@/lib/notify/no-such-module",
      "an import that resolves to nothing is named rather than dropped",
    );
  }
}

console.log(
  `ok: ${ALERT_PREVIEWS.length} rendered states across ${ALERT_CATALOG.length} alerts`,
);
finish();
