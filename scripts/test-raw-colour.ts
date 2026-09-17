// A colour in src comes from a token, never from a literal (#1903).
//
// CLAUDE.md has said "use CSS variables, never raw hex" since the redesign and
// nothing enforced it. Two colour guards existed and neither covers this:
// `test-contrast.ts` measures the token PAIRINGS, and `test-focus-ring-recipe.ts`
// covers one utility on one recipe.
//
// What a literal costs is not tidiness. It cannot follow the theme: the error
// panel on the business hours form was `bg-[rgba(196,61,61,0.12)]`, which is the
// LIGHT rose at 12% on a dark card too, while `var(--error)` is a deliberately
// lighter rose there. And it drifts silently, because each literal looks like a
// local styling decision where it is written: `#82D0FF` lived in two page files,
// each calling itself "Canonical --pennie-sky" when neither was the canonical
// anything.
//
// The scanner's own blind spots are written in its header rather than here, and
// they are real: a short pure decimal hex, and the Tailwind named palette. Read
// them before treating a green run as broader coverage than it has.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-raw-colour.ts
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/source-files.ts";
import { codeOnly, fileOptedOut, scanRawColour, TOKEN_HOME } from "./lib/scan-raw-colour.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

// --- the tree ---------------------------------------------------------------
//
// globals.css is where the palette is DECLARED, so it is the one file whose job
// is to hold the values. Everything else takes them from it, or says why not.
{
  const scanned = sourceFiles({
    match: /\.(tsx?|css)$/,
    exclude: (f) => f === TOKEN_HOME || /\.test\.tsx?$/.test(f),
  });
  const offenders = scanned.flatMap((f) => scanRawColour(f, readFileSync(f, "utf8")));

  if (offenders.length === 0) {
    assert(true, "no colour in src/ is written as a literal outside the tokens");
  } else {
    for (const o of offenders) fail(`${o.file}:${o.line} ${o.value}: ${o.why}`);
  }

  // A file this stood down on entirely is NAMED on every run, so a standing
  // exemption is listed somewhere visible rather than being silence (L523).
  const standing = scanned.filter((f) => fileOptedOut(readFileSync(f, "utf8")));
  assert(
    standing.length <= 1,
    `whole files exempted, each with its reason in its own header: ${standing.join(", ") || "none"}`,
  );
}

// --- the one literal that has to exist is pinned to the token ----------------
//
// The embed hands a host its brand fill as a STRING, which a CSS variable cannot
// travel as (D14), so one hex genuinely has to be written out. Being written
// once is not the same as being right: it is held to the token's own value here,
// so moving `--pennie-sky` and leaving this behind fails rather than shipping two
// different skies.
{
  const css = readFileSync(TOKEN_HOME, "utf8");
  const sky = css.match(/--pennie-sky:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  assert(sky !== null, "the sky token is declared as an rgb() triple");
  const asHex = sky
    ? "#" +
      [sky[1], sky[2], sky[3]]
        .map((n) => Number(n).toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()
    : "";

  const brand = readFileSync("src/lib/brand-label.ts", "utf8");
  const declared = brand.match(/DEFAULT_BRAND_COLOR\s*=\s*"(#[0-9a-fA-F]{6})"/);
  assert(declared !== null, "the embed's default brand colour is declared once, as a literal");
  eq(declared?.[1].toUpperCase(), asHex, "and it is the sky token's own value");

  // And it really is the only copy: two page files used to hold their own.
  const copies = sourceFiles({
    match: /\.tsx?$/,
    exclude: (f) => f === "src/lib/brand-label.ts" || /\.test\.tsx?$/.test(f),
  }).filter((f) => new RegExp(asHex, "i").test(readFileSync(f, "utf8")));
  eq(copies.join(", "), "", "nothing else in src spells the sky value out");
}

// --- positive controls ------------------------------------------------------
//
// Every failure this guard prevents is invisible on screen in the light theme,
// which is the theme it was written in, so a green run above has to be worth
// something. Each shape below is one the real tree carried.
{
  const caught = (code: string, what: string) => {
    const hits = scanRawColour("fixture.tsx", code);
    assert(hits.length > 0, `caught: ${what}`);
  };
  const allowed = (code: string, what: string) => {
    const hits = scanRawColour("fixture.tsx", code);
    assert(
      hits.length === 0,
      `allowed: ${what}${hits.length ? ` (wrongly flagged ${hits[0].value})` : ""}`,
    );
  };

  // The four sites #1903 was opened about, in both of their spellings.
  caught('<p className="text-[#C43D3D]" />', "a hex in an arbitrary value");
  caught('<p className="bg-[rgba(196,61,61,0.12)]" />', "the rgba half of the same pairing");
  caught('<p className="border-[rgba(196,61,61,0.35)]" />', "and its border");
  caught('const PENNIE_SKY = "#82D0FF";', "a hex assigned to a constant");
  caught('<div className="bg-[rgba(0,0,0,0.45)]" />', "a black scrim");
  caught("  --ground: rgb(249, 246, 240);", "a colour declared outside the token file");
  caught('<circle fill="#F9F6F0" />', "an SVG fill");
  caught('<p className="bg-[#333]" />', "a pure decimal hex sitting in a colour slot");
  caught("  color: #fff;", "a short hex with a letter");
  caught('style={{ color: "hsl(210, 50%, 40%)" }}', "an hsl() triple");
  caught('<p className="bg-[oklch(0.7_0.1_200)]" />', "a modern colour function");

  // A documented value is not a used one. The natural response to flagging the
  // documentation is to delete the sentence that explains the colour.
  allowed('/** Graphite #343434 - the on-sky label. */\nconst G = "var(--fg-on-sky)";', "a hex inside a block comment");
  allowed('// Beige is rgb(249, 246, 240) here.\nconst c = "var(--bg)";', "a colour named in a line comment");
  allowed('const c = "var(--error)";', "a token");
  allowed(
    '<p className="bg-[color-mix(in_srgb,var(--error)_12%,transparent)]" />',
    "a wash derived from a token",
  );

  // The issue references this repo is full of, which are spelled like short hex.
  allowed('const why = "the lead already has a call (#1337). Refund the slot";', "an issue reference");
  allowed('const why = "a phone number carrying an extension (#1425, #319)";', "two of them on one line");
  allowed("<span>&#9662;</span>", "a numeric character reference");

  // The opt-out, on the line and in the block above it, and refused with no reason.
  allowed(
    '<circle fill="#F9F6F0" /> // colour-ok: a drawn SVG with no CSS context',
    "an opt-out on the line",
  );
  allowed(
    '// colour-ok: the reason\n<circle fill="#F9F6F0" />',
    "an opt-out in the comment block above",
  );
  caught('// colour-ok:\n<circle fill="#F9F6F0" />', "an opt-out carrying no reason");
  allowed(
    '// colour-ok-file: this file renders its own document\nconst a = "rgb(1, 2, 3)";\nconst b = "#abcdef";',
    "a whole file that declares itself a declaration site",
  );
  caught(
    '// colour-ok-file:\nconst a = "#abcdef";',
    "a file level opt-out carrying no reason",
  );
  caught(
    "const pad = 1;\n".repeat(60) + '// colour-ok-file: too late to be the header\nconst a = "#abcdef";',
    "a file level opt-out buried below the header, where nobody reading the file would meet it",
  );
  caught(
    '// colour-ok: the reason\n\nconst gap = 1;\n<circle fill="#F9F6F0" />',
    "an opt-out separated from its line by real code",
  );
}

// --- the comment stripper keeps the file's shape ----------------------------
//
// Line numbers are what somebody navigates by, so blanking a comment must not
// move the line under it.
{
  const before = "const a = 1;\n/* two\n   lines */\nconst b = 2;\n";
  eq(codeOnly(before).split("\n").length, before.split("\n").length, "stripping preserves line count");
  assert(codeOnly(before).includes("const b = 2;"), "and leaves the code alone");
}

// --- a control drawn from the real tree -------------------------------------
//
// The synthetic fixtures above prove the patterns match. This proves the guard
// still catches the defect in the file it really shipped in, read from disk and
// put back in memory, so nothing is written to the repo (L1).
{
  const real = readFileSync("src/components/ui/BusinessHoursForm.tsx", "utf8");
  eq(scanRawColour("BusinessHoursForm.tsx", real).length, 0, "the fixed file is clean");

  const reverted = real.replace(
    /border-\[color-mix\(in_srgb,var\(--error\)_35%,transparent\)\] bg-\[color-mix\(in_srgb,var\(--error\)_12%,transparent\)\] px-4 py-3 text-sm text-error/,
    "border-[rgba(196,61,61,0.35)] bg-[rgba(196,61,61,0.12)] px-4 py-3 text-sm text-[#C43D3D]",
  );
  assert(reverted !== real, "the overlay really put the old declaration back");
  const caught = scanRawColour("BusinessHoursForm.tsx", reverted);
  eq(caught.length, 3, "and all THREE halves of the pairing are named, not only the hex one");
}

finish();
