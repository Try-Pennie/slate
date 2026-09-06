// #2007: text that flips with the theme, on a background that does not.
//
// Found live on 2026-09-06 while screenshotting the hours panel for #1997. The
// save confirmation drew `text-fg` on `--pennie-green-wash`. The wash is the
// same pale green in both themes on purpose, so a status colour does not change
// meaning; `--fg` is a near white in dark. The sentence was present in the DOM,
// correctly announced to a screen reader, and invisible on screen. It had
// shipped on every save confirmation on every admin page.
//
// `scripts/test-contrast.ts` could not have caught it and says so about an
// earlier instance on the navy Pill: it checks token PAIRINGS, and each of these
// is a CALL SITE composing two individually correct tokens (L213). So this reads
// call sites, and reads them as a CLASS rather than one by one, because fixing
// the instance and not the class is how the next one ships (L30).
//
// Run: node --experimental-strip-types scripts/test-theme-pairs.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  RAW_SURFACES,
  exemptionAbove,
  findReasonlessExemptions,
  findThemePairs,
  type ThemePairFinding,
} from "./lib/scan-theme-pairs.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const files = [...walk("src")];
assert(files.length > 100, `the scanner found the app to judge (${files.length} files)`);

const findings: ThemePairFinding[] = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  findings.push(...findThemePairs(f, src));
  findings.push(...findReasonlessExemptions(f, src));
}

if (findings.length) {
  for (const x of findings) fail(`${x.file}:${x.line} ${x.why}\n    ${x.text}`);
} else {
  assert(true, "no text flips with the theme on a background that does not");
}

// THE RULE HAS SUBJECTS. Every assertion above is vacuous if nothing in the app
// paints a raw surface at all, and the run would read exactly the same.
{
  let painted = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (RAW_SURFACES.some((t) => src.includes(`bg-${t}`) || src.includes(`bg-[var(--${t})]`))) {
      painted++;
    }
  }
  assert(painted >= 5, `the app really paints raw surfaces (${painted} files)`);
}

// ---------------------------------------------------------------------------
// Positive controls: the scan is shown catching each thing it exists to catch.
// ---------------------------------------------------------------------------
{
  const bad = `<div className="rounded-md bg-[var(--pennie-green-wash)] px-5 py-4 text-sm text-fg">`;
  eq(findThemePairs("f.tsx", bad).length, 1, "the exact defect that shipped is caught");

  // Both spellings of the same token, because a call site can use either and a
  // scanner that knew one would report the other as clean.
  eq(
    findThemePairs("f.tsx", `<p className="bg-pennie-green-wash text-fg">`).length,
    1,
    "and the bare class spelling too",
  );

  // The two compliant shapes, in both directions. Either half may be the one
  // that varies; what is refused is one fixed and the other flipping.
  eq(
    findThemePairs("f.tsx", `<p className="bg-pennie-sky-soft text-fg dark:bg-accent/15">`).length,
    0,
    "a per theme BACKGROUND is compliant",
  );
  eq(
    findThemePairs("f.tsx", `<p className="bg-pennie-sky-soft text-fg dark:text-pennie-beige">`).length,
    0,
    "and so is a per theme TEXT",
  );
  eq(
    findThemePairs("f.tsx", `<p className="bg-pennie-green-wash text-pennie-graphite">`).length,
    0,
    "a fixed text on a fixed background is the fix, not a finding",
  );

  // A raw surface with no text colour at all inherits, which this cannot judge
  // and must not accuse: the parent decides, and guessing would make the rule
  // noise on the commonest shape.
  eq(
    findThemePairs("f.tsx", `<div className="rounded-xl bg-pennie-sky-soft px-6 py-5">`).length,
    0,
    "a background with no text colour is left alone",
  );

  // The escape hatch, and only with a reason.
  const exempt = `// theme-pair-ok: the light half of a palette whose dark half swaps the wash\n<p className="bg-pennie-sky-soft text-fg">`;
  eq(findThemePairs("f.tsx", exempt).length, 0, "an exemption with a reason is honoured");
  eq(
    findReasonlessExemptions("f.tsx", "// theme-pair-ok: ok\n<p/>").length,
    1,
    "and one without a real reason is caught (L233)",
  );

  // An exemption must not be inherited by the next line down, which is how one
  // considered decision silently covers a second nobody looked at.
  const inherited = [
    "// theme-pair-ok: the light half of a palette whose dark half swaps the wash",
    `<p className="bg-pennie-sky-soft text-fg">`,
    "",
    `<p className="bg-pennie-green-wash text-fg">`,
  ].join("\n");
  eq(findThemePairs("f.tsx", inherited).length, 1, "the exemption covers only the line it sits above");
  eq(
    exemptionAbove(inherited.split("\n"), 3),
    null,
    "and the helper says so directly",
  );
}

// A control over the REAL tree: revert the #1997 fix in memory and require it
// caught. A synthetic fixture agrees with my assumption about the shape by
// construction (L52); this asserts the guard would have caught the real one.
{
  const path = join("src", "app", "admin", "settings", "SettingsSaveNotice.tsx");
  const real = readFileSync(path, "utf8");
  const reverted = real.replace("text-sm text-pennie-graphite", "text-sm text-fg");
  assert(reverted !== real, "the overlay actually changed the real source");
  const caught = findThemePairs(path, reverted);
  eq(caught.length, 1, `the guard catches the real defect it was written for (${caught.length})`);
}

finish();
