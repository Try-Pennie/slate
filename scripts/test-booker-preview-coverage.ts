// Repo invariant (#1343): the lead-facing copy preview stays worth reading.
//
// `pnpm preview:booker` exists because the copy that reaches customers had no way
// to be READ before it shipped. The 2026-08-07 design session found a policy
// sentence that made the panel about us, a message that said "pick another"
// without saying another what, dates in British order, a pronoun we cannot know,
// and two sentences running together, all by clicking through a mockup.
//
// A preview is only worth having if it cannot lie, so this checks the properties
// that would make it lie:
//
//   1. every screen and state renders a real, non-empty string;
//   2. nothing renders `undefined`, `NaN`, `[object Object]`, a leaked null, or a
//      raw JSON blob, which is how a builder given the wrong shape fails;
//   3. the render is DETERMINISTIC, so a diff means the copy changed rather than
//      the clock moving (the preview must never read `Date.now`);
//   4. the copy obeys the repo's own writing rules, since these strings are the
//      ones a customer reads: no em or en dashes, no emoji;
//   5. every state label is distinct within its screen, so two rows cannot
//      silently describe themselves the same way while showing different text;
//   6. an anti-vacuity floor, because a broken import returning an empty list
//      would make every check above pass over nothing.
//
// The SEPARATE question, whether the preview shows what the components actually
// render, is answered in src/components/copy-preview-parity.test.tsx: a static
// check cannot mount React, and asserting the two agree is the whole reason the
// copy was moved out of the components in the first place (L41).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booker-preview-coverage.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bookerCopyScreens } from "../src/lib/booking/copy-preview.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

/** Built from escapes, so this file holds no literal dash to trip the copy lint. */
const DASHES = new RegExp("[\\u2013\\u2014]");
const EMOJI = new RegExp("[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]", "u");
const LEAKS = /undefined|NaN|\[object Object\]|\bnull\b|\{"/;

const screens = bookerCopyScreens();

// --- 6. anti-vacuity ----------------------------------------------------------
// A broken import or a renamed export would return nothing, and every assertion
// below would pass by default over an empty list. That is the exact
// false-confidence shape these guards exist to prevent.
assert(
  screens.length >= 10,
  `the preview still enumerates the lead-facing screens (expected at least 10, got ${screens.length})`,
);
const totalLines = screens.reduce((n, s) => n + s.lines.length, 0);
assert(
  totalLines >= 50,
  `and their states (expected at least 50 lines, got ${totalLines})`,
);
for (const required of ["Booker: confirmed", "Manage: confirming a cancel"]) {
  assert(
    screens.some((s) => s.screen === required),
    `"${required}" is previewed`,
  );
}
// Both surfaces, or the preview could cover one and claim the pair.
assert(
  screens.some((s) => s.screen.startsWith("Booker:")) &&
    screens.some((s) => s.screen.startsWith("Manage:")),
  "both lead-facing surfaces are covered, not just one",
);

// --- 1, 2, 4. every line is a real, clean, readable string ---------------------
for (const screen of screens) {
  assert(screen.purpose.trim().length > 20, `${screen.screen} says what the screen is for`);
  assert(screen.lines.length > 0, `${screen.screen} has at least one state`);

  for (const line of screen.lines) {
    const where = `${screen.screen} / ${line.state}`;
    assert(line.text.trim().length > 0, `${where} renders a non-empty string`);
    assert(!LEAKS.test(line.text), `${where} renders no placeholder leak (${line.text})`);
    assert(!DASHES.test(line.text), `${where} uses no em or en dash`);
    assert(!EMOJI.test(line.text), `${where} carries no emoji`);
    // A state label that does not describe a state is the row nobody can act on.
    assert(line.state.trim().length > 3, `${where} names the state that produces it`);
  }

  // --- 5. distinct labels within a screen -------------------------------------
  const labels = screen.lines.map((l) => l.state);
  eq(
    new Set(labels).size,
    labels.length,
    `${screen.screen}'s states are each described differently (${labels.join(" | ")})`,
  );
}

// --- 3. deterministic ---------------------------------------------------------
{
  const once = JSON.stringify(bookerCopyScreens());
  const twice = JSON.stringify(bookerCopyScreens());
  eq(once, twice, "two renders of the preview are identical");

  // And structurally so: a builder reading the clock would drift a day at
  // midnight and read as a copy change in every diff taken after it.
  const src = readFileSync(join(ROOT, "src", "lib", "booking", "copy-preview.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["Date.now(", "new Date()", "DateTime.now(", "DateTime.local("]) {
    assert(
      !src.includes(forbidden),
      `the preview does not read the clock (${forbidden}), so a diff means the copy changed`,
    );
  }
}

// --- the preview holds no wording of its own ----------------------------------
// THE rule (L41). A preview carrying its own copy of the text would drift from
// what ships the first time somebody edited one and not the other, and it would be
// believed while wrong, which is worse than having no preview at all. Every `text`
// must come from a builder, so no string literal may be assigned to one here.
{
  const src = readFileSync(join(ROOT, "src", "lib", "booking", "copy-preview.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const inlineText = [...src.matchAll(/\btext:\s*(["'`])/g)];
  eq(
    inlineText.length,
    0,
    "no line's text is a literal in the preview: every one calls the real copy builder",
  );
  // Positive control, or a regex regression would report zero forever.
  const sabotaged = `${src}\n  { state: "x", text: "invented wording" },`;
  eq(
    [...sabotaged.matchAll(/\btext:\s*(["'`])/g)].length,
    1,
    "a literal added to the preview IS caught",
  );
}

finish();
