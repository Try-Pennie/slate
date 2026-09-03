// Nobody hand-rolls the console page header again (#1838).
//
// `AdminPageHeader` exists BECAUSE this duplication had already happened once:
// its own docstring says "thirteen copies of it is how the widths in #1745 ended
// up disagreeing". Ten pages then went on writing the band out by hand anyway,
// so changing the component fixed its thirteen pages and left ten navy bands
// standing. A half converted console is worse than either state.
//
// A rule that lives only in a docstring is a hope (L27), so this is the check.
// It scans for the BAND, meaning a navy fill on a rounded container, rather than
// for the exact class string that happened to be copied: a copy with the classes
// in a different order, or with the padding changed, is the same defect and an
// exact string match would sail past it (L63, assert the quantity not a proxy).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-no-handrolled-page-band.ts
import { readFileSync, readdirSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";

/**
 * The navy surfaces that are DELIBERATE, each with the reason it is not a page
 * header. An entry with no reason is evidence nobody reasoned about it (L233),
 * so the shape forces one.
 *
 * The exception is scoped to the LINE, not to the file. `admin/ooo/page.tsx`
 * holds both a page header (which converts) and a deliberate navy stat grid
 * (which stays), and a whole file exception would have excused the header on the
 * strength of the grid: a guard that matches over a whole file is satisfied by
 * any occurrence in it, while the region it was written about stays broken
 * (L135). `only` is what the matching line must ALSO contain to be excused.
 */
const ALLOWED: { file: string; why: string; only?: RegExp }[] = [
  {
    file: "src/app/login/page.tsx",
    why: "the signed out brand panel, a dark surface by design and not a page header",
  },
  {
    file: "src/app/admin/ooo/page.tsx",
    why: "the stat grid is a deliberate navy figures band, which the design record allows for figures; the page header in the same file is converted and is NOT excused",
    only: /divide-/,
  },
  {
    file: "src/components/AppHeader.tsx",
    why: "the impersonation banner, a full bleed alert bar that must not read as page furniture",
  },
  {
    file: "src/components/ImpersonationDropNotice.tsx",
    why: "the dropped session notice, the same alert bar treatment as the banner above",
  },
  { file: "src/components/AccountMenu.tsx", why: "an avatar circle, not a band at all" },
  { file: "src/components/admin/RosterTable.tsx", why: "an avatar circle, not a band at all" },
  { file: "src/components/ui/Pill.tsx", why: "the navy pill fills for the elevated roles" },
];

for (const a of ALLOWED) {
  assert(a.why.trim().length > 20, `${a.file} states why it keeps a navy surface`);
}
const allowedBy = new Map(ALLOWED.map((a) => [a.file, a]));

const files = readdirSync("src", { recursive: true, encoding: "utf8" })
  .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))
  .map((f) => `src/${f}`);
assert(files.length > 50, `the sweep really walked src (${files.length} files)`);

/**
 * A page header band: a navy fill on a container that also rounds its corners.
 * Matched on the class list rather than on the exact string ten pages happened
 * to copy, so the same band with its classes reordered or its padding changed is
 * still caught, which a string compare would miss (L63).
 *
 * The avatar circles carry a navy fill and `rounded-full`, so they are excused by
 * name above rather than by a cleverer pattern: a pattern narrow enough to skip
 * them would also excuse a real band that used a different radius.
 */
const BAND =
  /\bbg-pennie-navy\b[^"`]*\brounded-(?:xl|lg|md)\b|\brounded-(?:xl|lg|md)\b[^"`]*\bbg-pennie-navy\b/;

/** Every line of `text` that draws a band and is not excused for that file. */
function bandLines(file: string, text: string): string[] {
  const rule = allowedBy.get(file);
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (!BAND.test(line)) return;
    if (rule && (rule.only === undefined || rule.only.test(line))) return;
    hits.push(`${file}:${i + 1}`);
  });
  return hits;
}

const offenders = files.flatMap((f) => bandLines(f, readFileSync(f, "utf8")));
eq(
  offenders.join(", "),
  "",
  "no page outside the declared exceptions hand-rolls a navy band; use AdminPageHeader",
);

// POSITIVE CONTROLS. Without these an expression that matched nothing would pass
// as a clean tree, which is the exact false green this guard exists to prevent
// (L98, L1).
assert(
  BAND.test('<section className="rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface">'),
  "the pattern still matches the band exactly as it was written on ten pages",
);
assert(
  BAND.test('<section className="bg-pennie-navy rounded-md p-6">'),
  "and matches it with the classes the other way round, which a string compare would miss",
);
assert(
  !BAND.test("<section className={cardCls}>"),
  "and does not match the card the header became, or every converted page would fail",
);
// The narrow exception really is narrow: the grid line is excused, a header line
// in the same file is not. Proven on synthetic lines, so it keeps holding after
// the real header on that page is converted and the file no longer carries one.
{
  const OOO = "src/app/admin/ooo/page.tsx";
  eq(
    bandLines(OOO, '<div className="grid divide-x divide-y rounded-xl bg-pennie-navy">').join(""),
    "",
    "the ooo stat grid is excused",
  );
  eq(
    bandLines(OOO, '<section className="rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface">').join(""),
    `${OOO}:1`,
    "but a page header in the same file is NOT, which a whole-file exception would have excused",
  );
}
{
  const stillNavy = ALLOWED.filter((a) => BAND.test(readFileSync(a.file, "utf8"))).length;
  assert(stillNavy > 0, `the allow list is load bearing: ${stillNavy} entries really hold a navy surface`);
}

finish();
