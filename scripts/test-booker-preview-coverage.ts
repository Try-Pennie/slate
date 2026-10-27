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
//      the clock moving: neither the preview NOR the builders it prints may read
//      the clock, and since #2497 the scan covers both;
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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  bookerCopyScreens,
  inviteCopyScreens,
  reminderCopyScreens,
} from "../src/lib/booking/copy-preview.ts";
import { scanCopyClockReads } from "./lib/scan-copy-clock-reads.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

/** Built from escapes, so this file holds no literal dash to trip the copy lint. */
const DASHES = new RegExp("[\\u2013\\u2014]");
const EMOJI = new RegExp("[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]", "u");
const LEAKS = /undefined|NaN|\[object Object\]|\bnull\b|\{"/;

const screens = bookerCopyScreens();

/**
 * Every group `pnpm preview:booker` prints, not only the screens.
 *
 * The per line checks below used to run over `bookerCopyScreens()` alone, so the
 * calendar invite's wording (#1421) and the 24 hour reminder email's (#2495) were
 * printed by the preview and checked by nothing: a guard's NAME is not a statement
 * of its coverage (L400). The embed's block is deliberately still out, because it
 * is read out of the shipping `widget.js` by the preview script and has its own
 * guard there.
 */
const allScreens = [...screens, ...inviteCopyScreens(), ...reminderCopyScreens()];

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
for (const required of [
  "Booker: confirmed",
  "Manage: confirming a cancel",
  // #2660: the test line every test booking surface carries, previewed as its
  // own screen so a reader sees the sentence a tester and a stray lead will.
  "Booker and manage: a test booking",
  // #2754: the booker's error boundary shipped with the staff wording because this
  // state was never previewed, so nobody read it cold (L21).
  "Booker: the page could not load",
]) {
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

// The lead-facing surfaces that are NOT screens are each named, so one of them
// dropping out of the preview fails here rather than quietly shrinking the set the
// checks below run over (L98).
for (const required of ["Calendar invite: the appointment", "Reminder email: the call is tomorrow"]) {
  assert(
    allScreens.some((s) => s.screen === required),
    `"${required}" is previewed`,
  );
}
// #2660: the invite for a TEST booking opens with the test line, so the tester's
// own calendar says what the event is. Previewed as a state of the invite, and
// the state is named so a reader can find it.
{
  const invite = allScreens.find((s) => s.screen === "Calendar invite: the appointment");
  assert(
    invite?.lines.some((l) => /test booking/i.test(l.state)) === true,
    "the invite preview carries the state for a test booking",
  );
}

// --- 1, 2, 4. every line is a real, clean, readable string ---------------------
for (const screen of allScreens) {
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
  const render = () =>
    JSON.stringify([...bookerCopyScreens(), ...inviteCopyScreens(), ...reminderCopyScreens()]);
  eq(render(), render(), "two renders of the preview are identical");

  // And structurally so: a builder reading the clock would drift a day at
  // midnight and read as a copy change in every diff taken after it.
  //
  // This scans the BUILDERS as well as the preview, which it did not until #2497
  // (L63: the preview file alone is a proxy for the quantity being protected).
  // `reminder.ts` decided "today" against "tomorrow" from `DateTime.now()` while
  // its test pinned the other end of that relationship, so the suite went red at
  // midnight on 2026-09-17 with nobody having touched the code, and took main's
  // deploy down with it. Two renders a millisecond apart cannot see that: the
  // clock does not move between them, which is why the STATIC read is the check
  // that matters and the pair above is only the cheap half.
  //
  // The list is a GLOB, never a hand written registry, so a copy module added
  // tomorrow is covered by construction rather than exempt from the guard meant
  // to catch it (L96). `reminder.ts` is named alongside it because it builds an
  // email rather than a screen and so carries no `-copy` in its name.
  const copyModules = [
    ...readdirSync(join(ROOT, "src", "lib", "booking"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f.includes("copy"))
      .map((f) => join("src", "lib", "booking", f)),
    join("src", "lib", "booking", "reminder.ts"),
  ];
  // The floor is the anti-vacuity one (L98): a glob that matched nothing, or a
  // renamed directory, would pass every assertion below over an empty list.
  assert(copyModules.length >= 5, `the copy modules were found (got ${copyModules.length})`);

  for (const rel of copyModules) {
    const findings = scanCopyClockReads(readFileSync(join(ROOT, rel), "utf8"), rel);
    eq(
      findings.length,
      0,
      `${rel} takes its clock as an argument rather than reading it` +
        (findings.length ? ` (${findings.map((f) => `${f.line}: ${f.read}`).join(", ")})` : ""),
    );
  }

  // Controls. Without these a path typo, or a scanner that matched nothing,
  // would report every module clean for ever (L1, L98).
  {
    eq(
      scanCopyClockReads("export function f(){ return DateTime.now().toISO(); }").length,
      1,
      "a builder that DID read the clock is caught",
    );
    eq(
      scanCopyClockReads("// this deliberately avoids DateTime.now()\nexport const x = 1;").length,
      0,
      "while a comment merely naming the clock is not a finding",
    );

    // The escape hatch, which every other convention guard in this repo carries
    // (`cap-safe`, `error-ok`, `parse-ok`, `write-ok`). Without one, the next
    // person with a legitimate reason has to edit the guard to get past it, and
    // a guard whose routine remedy is to switch it off is one nobody trusts (L36).
    eq(
      scanCopyClockReads(
        "// clock-ok: this builder is the preview's own fixture seed, never lead facing\n" +
          "export const seed = Date.now();",
      ).length,
      0,
      "a hatch carrying a reason suppresses the finding",
    );
    eq(
      scanCopyClockReads("export const seed = Date.now(); // clock-ok: seeded by the caller").length,
      0,
      "and it may sit on the line itself, not only above it",
    );

    // A hatch with NO reason is REFUSED, so it cannot be taken by writing the
    // token alone (L675). It is still a finding, and it says which kind it is.
    const unreasoned = scanCopyClockReads("// clock-ok:\nexport const seed = Date.now();");
    eq(unreasoned.length, 1, "a hatch with no reason does not suppress anything");
    assert(
      unreasoned[0]!.unreasonedOptOut,
      "and it is reported as an unreasoned hatch rather than as a plain clock read",
    );
    eq(
      scanCopyClockReads("// clock-ok: {}\nexport const seed = Date.now();").length,
      1,
      "nor does one whose reason is punctuation rather than words",
    );

    // A DIFFERENT convention's opt-out must not suppress this one, or adding a
    // rule behind an existing token silently widens every use of it (L448).
    eq(
      scanCopyClockReads("// error-ok: the read is best effort\nexport const seed = Date.now();").length,
      1,
      "another convention's opt-out does not reach this rule",
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

// #4282: the 1 hour email's wording is read in the preview like the 24 hour one's,
// for a routed call and for one on the placeholder.
{
  const texts = reminderCopyScreens().flatMap((screen) => screen.lines.map((line) => line.text));
  assert(texts.some((t) => /in about an hour/.test(t) && /reply to this email/.test(t)), "the preview carries the 1 hour email");
  assert(
    texts.some((t) => /in about an hour/.test(t) && /reply to one of our texts/.test(t)),
    "and the placeholder's 1 hour email",
  );
}

finish();
