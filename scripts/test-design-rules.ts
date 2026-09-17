// The design record's mechanically checkable rules, held up by something (#1813).
//
// DESIGN.md records Slate's visual system as a set of named rules and almost
// none of them were enforced. Exactly two had a guard: the colour pairings
// (`scripts/test-contrast.ts`) and the focus ring recipe
// (`scripts/test-focus-ring-recipe.ts`). Every other rule rested on whoever
// happened to read the file, which is L27: a rule that lives only in a document
// is a hope. On the day the record was merged, a tier coverage glyph shipped
// breaking two of its principles at once.
//
// Three rules move from hope to enforcement here: the 600 Ceiling, Pills Are
// Badges, and the One Pen Rule. Which three, and which rules are deliberately
// left advisory, is argued in the scanner's own header, and each of the three is
// named in DESIGN.md beside the rule it holds, so the record says which of its
// own rules are held up by something and which are aspirations. A record where
// enforced and aspirational look identical cannot be trusted in either
// direction.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-design-rules.ts
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/source-files.ts";
import { enclosingTag, scanDesignRules } from "./lib/scan-design-rules.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

// --- the tree ---------------------------------------------------------------
//
// Through the shared enumeration (#2421), which refuses a listing it cannot
// believe rather than reporting a clean tree over zero files.
{
  const offenders = sourceFiles({
    match: /\.(tsx?|css)$/,
    exclude: (f) => /\.test\.tsx?$/.test(f),
  }).flatMap((f) => scanDesignRules(f, readFileSync(f, "utf8")));

  if (offenders.length === 0) {
    assert(true, "no surface in src breaks the 600 ceiling, the pill rule or the one pen rule");
  } else {
    for (const o of offenders) fail(`${o.file}:${o.line} [${o.rule}] ${o.found}: ${o.why}`);
  }
}

// --- the record says which of its rules are held up -------------------------
//
// An enforced rule and an aspiration read identically in a design record, so the
// three that now have a guard NAME it. This also fails if a guard is renamed or
// deleted and the record goes on claiming it, which is the direction that turns
// a record into a false reassurance.
{
  const design = readFileSync("DESIGN.md", "utf8");
  for (const [rule, guard] of [
    ["The 600 Ceiling Rule", "scripts/test-design-rules.ts"],
    ["The Pills Are Badges Rule", "scripts/test-design-rules.ts"],
    ["The One Pen Rule", "scripts/test-design-rules.ts"],
    ["The Measured Pairing Rule", "scripts/test-contrast.ts"],
    ["The Prose Width Rule", "scripts/test-prose-width.ts"],
  ] as const) {
    const at = design.indexOf(`**${rule}.**`);
    assert(at >= 0, `DESIGN.md still carries ${rule}`);
    if (at < 0) continue;
    const body = design.slice(at, design.indexOf("\n\n", at) === -1 ? undefined : design.indexOf("\n\n", at));
    assert(body.includes(guard), `${rule} names the guard that holds it up (${guard})`);
  }

  // And the rules that are NOT enforced say so, rather than looking the same as
  // the ones that are. Tabular numerals is the one this issue decided about.
  const ledger = design.indexOf("**The Ledger Numerals Rule.**");
  assert(ledger >= 0, "DESIGN.md still carries The Ledger Numerals Rule");
  const ledgerBody = design.slice(ledger, design.indexOf("\n\n", ledger));
  assert(
    /advisory/i.test(ledgerBody),
    "the numerals rule says it is advisory, so its silence is not read as enforcement",
  );
}

// --- the font really is capped at 600 ---------------------------------------
//
// The tree scan above is satisfied by a tree that ships no weight at all, and it
// rests entirely on the claim that 700 renders as 600. That claim lives in the
// font config, so it is read rather than assumed (L98).
{
  const font = readFileSync("src/app/fonts/pp-mori.ts", "utf8");
  assert(/weight:\s*"700"/.test(font), "the font config declares a 700 face");
  assert(
    /SemiBold/i.test(font),
    "and points it at SemiBold, which is why a stray font-bold is invisible on screen",
  );
  const css = readFileSync("src/app/globals.css", "utf8");
  assert(
    /font-synthesis:\s*none/.test(css),
    "and font-synthesis is none, so the browser cannot fake a heavier face either",
  );
}

// --- positive controls ------------------------------------------------------
//
// Each of these three fails INVISIBLY: a synthesised 600 looks like a 600, a
// pill looks deliberate, and a yellow button is perfectly legible. So a green
// run above has to be worth something.
{
  const caught = (code: string, rule: string, what: string) => {
    const hits = scanDesignRules("src/x.tsx", code);
    assert(
      hits.some((h) => h.rule === rule),
      `caught: ${what}${hits.length ? ` (found ${hits.map((h) => h.rule).join(", ")})` : " (found nothing)"}`,
    );
  };
  const allowed = (code: string, what: string) => {
    const hits = scanDesignRules("src/x.tsx", code);
    assert(
      hits.length === 0,
      `allowed: ${what}${hits.length ? ` (wrongly flagged ${hits[0].rule}: ${hits[0].found})` : ""}`,
    );
  };

  // The 600 ceiling, in every spelling that reaches the DOM.
  caught('<p className="font-bold">x</p>', "600-ceiling", "font-bold");
  caught('<p className="text-lg font-extrabold">x</p>', "600-ceiling", "font-extrabold");
  caught('<p className="font-black">x</p>', "600-ceiling", "font-black");
  caught('<p className="font-medium">x</p>', "600-ceiling", "a weight the typeface does not ship at all");
  caught('<p className="font-[700]">x</p>', "600-ceiling", "an arbitrary numeric weight");
  caught("  font-weight: 700;", "600-ceiling", "a weight set in CSS");
  caught('style={{ fontWeight: 700 }}', "600-ceiling", "a weight set in a style object");
  caught('style={{ fontWeight: "bold" }}', "600-ceiling", "the keyword");
  allowed('<p className="font-semibold">x</p>', "the signature weight");
  allowed('<p className="font-normal">x</p>', "the body weight");
  allowed("  font-weight: 400;", "a body weight in CSS");
  allowed("  font-weight: 200;", "the light face, which the typeface ships");

  // Pills are badges. The shape that reads as a tag is the one with room for a
  // word, so a circular icon control and a day cell are left alone.
  caught(
    '<button type="button" className="rounded-full px-4 py-2 bg-accent">Book</button>',
    "pill-button",
    "a pill shaped button",
  );
  caught('<Link href="/x" className="rounded-full px-3">Go</Link>', "pill-button", "a pill shaped link");
  caught(
    '<button\n  type="button"\n  className="mt-2 w-full rounded-full text-sm"\n>Go</button>',
    "pill-button",
    "a full width pill whose tag opened three lines earlier",
  );
  allowed(
    '<button type="button" className="flex h-7 w-7 items-center justify-center rounded-full">+</button>',
    "a circular icon button",
  );
  allowed(
    '<button\n  type="button"\n  className="relative flex min-h-11 items-center justify-center rounded-full text-sm"\n>{d.day}</button>',
    "a calendar day cell, which is a circle rather than a tag",
  );
  allowed('<span className="rounded-full px-2.5 py-0.5 text-xs">Bookable</span>', "a status pill, which is what pills are for");
  allowed('<div className="h-2 w-2 rounded-full bg-pennie-green" />', "a status dot");
  allowed('<img className="h-8 w-8 rounded-full object-cover" />', "an avatar");

  // One pen. Yellow, mint and peach are illustration accents.
  caught(
    '<button type="submit" className="rounded-lg bg-pennie-yellow px-4">Save</button>',
    "one-pen",
    "a yellow call to action",
  );
  caught(
    '<a href="/x" className="rounded-lg bg-[var(--pennie-mint)] px-4">Go</a>',
    "one-pen",
    "a mint one reached through the variable",
  );
  allowed('<span className="h-2 w-2 rounded-full bg-[var(--pennie-yellow)]" />', "a yellow status dot");
  allowed(
    '<div className="bg-pennie-yellow px-4 py-2">You are viewing as somebody else</div>',
    "the impersonation marker, which is a band rather than a control",
  );
  allowed('<button type="button" className="rounded-lg bg-accent px-4">Book</button>', "a sky call to action");

  // A comment is not code: a file explaining a rule has to name what it forbids.
  allowed('// never write font-bold here\nconst x = 1;', "a rule quoted in a comment");
  allowed('{/* a pill shaped button reads as a tag */}\n<span />', "a rule quoted in JSX");

  // The opt-out, which must carry a reason.
  allowed(
    '// design-ok: the host brand demands it\n<button className="rounded-full px-4">x</button>',
    "an opt-out with a reason",
  );
  allowed(
    '<button className="rounded-full px-4">x</button> {/* design-ok: a reason */}',
    "an opt-out on the line",
  );
  caught(
    '// design-ok:\n<button className="rounded-full px-4">x</button>',
    "pill-button",
    "an opt-out carrying no reason",
  );
}

// --- the tag reader ---------------------------------------------------------
//
// Everything but the weight rule depends on knowing what kind of element a class
// is on, and a JSX element's attributes run over many lines with an arrow
// function's own `>` among them, so the opening tag cannot be matched whole.
{
  const src = '<div>\n  <button\n    onClick={() => go()}\n    className="rounded-full px-4"\n  >x</button>\n</div>';
  eq(
    enclosingTag(src, src.indexOf("rounded-full")),
    "button",
    "the tag is read backwards, past an onClick arrow carrying its own angle bracket",
  );
  eq(enclosingTag("<span className='x'", 10), "span", "and off a single line element");
  eq(enclosingTag("const a = 1;", 5), null, "with no tag at all, it says so rather than guessing");
}

// --- a control drawn from the real tree -------------------------------------
//
// The synthetic fixtures prove the patterns match. This proves the guard still
// catches the defect in a file that really ships, read from disk and changed in
// memory, so nothing is written to the repo.
{
  const path = "src/components/ui/CalendarMonth.tsx";
  const real = readFileSync(path, "utf8");
  eq(scanDesignRules(path, real).length, 0, "the real month picker is clean");

  // Its day cells are round on purpose and must stay allowed. Give one the
  // padding that turns a circle into a tag and the guard has to say so.
  const pilled = real.replace(
    "relative flex min-h-11 items-center justify-center rounded-full text-sm",
    "relative flex min-h-11 items-center justify-center rounded-full px-4 text-sm",
  );
  assert(pilled !== real, "the overlay really widened a day cell");
  const hits = scanDesignRules(path, pilled);
  eq(hits.filter((h) => h.rule === "pill-button").length, 1, "and the guard names it as a pill");

  // The other direction: a weight above the ceiling put into a file that has
  // none, which is the state the whole tree is in today.
  const heavy = real.replace('className={`relative', 'className={`font-bold relative');
  assert(heavy !== real, "the overlay really planted a heavy weight");
  assert(
    scanDesignRules(path, heavy).some((h) => h.rule === "600-ceiling"),
    "and the guard names the weight, which renders as 600 and is invisible on screen",
  );
}

finish();
