// One shared way of putting a mark beside a word (#2112). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-marked-label-coverage.ts
//
// WHAT HAPPENED. The same construction, a small round mark and a word centred on
// each other, was written by hand on the account menu's three calendar states,
// both of the sync health panel's rows, the booker's slot times and the time off
// page's editing badge. Each was a pixel out for its own cause, so it arrived as
// seven bug reports from whichever screen somebody happened to be looking at.
//
// The fix is the component plus the guard, in one change (L613): a shared thing
// that converts every site, and a scan that fails the next hand rolled copy.
// Without the second half this is the shape L613 actually describes, where the
// cluster in front of whoever built it gets converted and the rest stand.
//
// The scan pays for itself in this same commit: it found a SEVENTH site the
// issue's own list of six did not have (the /admin health verdict badge), which
// is exempted with a reason and its own issue rather than converted, because it
// is an oval and belongs to `Pill`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanMarkedLabel } from "./lib/scan-marked-label.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const row = (mark: string, label = "Calendar connected") =>
  `<span className="inline-flex items-center gap-2 text-fg-muted">\n  ${mark}\n  ${label}\n</span>`;

// --- the scanner's own rules, over fixtures ------------------------------------

{
  const found = scanMarkedLabel("f.tsx", row(`<span className="h-2 w-2 rounded-full bg-pennie-green" />`));
  eq(found.length, 1, "a hand rolled mark beside a word is reported");
}
{
  const found = scanMarkedLabel(
    "f.tsx",
    `<MarkedLabel className="gap-2 text-fg-muted" mark={<span className="h-2 w-2 rounded-full bg-pennie-green" />}>\n  Calendar connected\n</MarkedLabel>`,
  );
  eq(found.length, 0, "the same row through the shared component is not");
}
{
  // The mark on its way IN to the shared component, written across lines as the
  // real call sites write it.
  const found = scanMarkedLabel(
    "f.tsx",
    `<MarkedLabel\n  className="gap-2"\n  mark={<span className="h-2 w-2 rounded-full bg-pennie-sky" />}\n>\n  Editing above\n</MarkedLabel>`,
  );
  eq(found.length, 0, "and neither is one whose mark prop spans lines");
}
{
  const found = scanMarkedLabel(
    "f.tsx",
    `{/* mark-ok: an oval, so Pill owns this alignment */}\n${row(`<span className="h-2 w-2 rounded-full bg-pennie-green" />`)}`,
  );
  eq(found.length, 0, "an opt out carrying a reason is honoured");
}
{
  const found = scanMarkedLabel("f.tsx", `{/* mark-ok: */}\n${row(`<span className="h-2 w-2 rounded-full bg-pennie-green" />`)}`);
  eq(found.length, 1, "an opt out with NO reason is not an opt out (L233)");
}
{
  const found = scanMarkedLabel(
    "src/components/ui/MarkedLabel.tsx",
    row(`<span className="h-2 w-2 rounded-full bg-pennie-green" />`),
  );
  eq(found.length, 0, "the shared component itself is not reported for containing the thing it owns");
}
{
  // Pill does this alignment the other way round, deliberately: it has an oval to
  // centre the pair in, so it moves the LABEL down rather than the mark up.
  const found = scanMarkedLabel("src/components/ui/Pill.tsx", row(`<span className="h-2 w-2 rounded-full bg-current" />`));
  eq(found.length, 0, "and neither is the pill, which owns the oval version of it");
}

// --- what is NOT a mark, each because it was reported as one --------------------

{
  // The booking outcomes page draws one of these per row. It is `h-2 rounded-full`
  // with no width of its own, because its width IS the measurement.
  const bar = `<span className="grid grid-cols-2 items-center gap-3 text-sm">\n  <span className="text-fg">{label}</span>\n  <span className="h-2 overflow-hidden rounded-full bg-bg-alt" aria-hidden="true" />\n</span>`;
  eq(scanMarkedLabel("f.tsx", bar).length, 0, "a progress bar is not a mark: it carries no width of its own");
}
{
  const avatar = row(`<span className="h-7 w-7 rounded-full bg-pennie-navy">{initials}</span>`);
  eq(scanMarkedLabel("f.tsx", avatar).length, 0, "and neither is an avatar, which reads as an object beside the line");
}
{
  // The account menu's alert badge and the calendar's today marker. Both are
  // positioned against an edge of the thing they belong to, so nothing centres
  // them and there is nothing to line up.
  const badge = `<span className="relative flex h-7 w-7 items-center justify-center rounded-full">\n  {initials}\n  <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--error)]" />\n</span>`;
  eq(scanMarkedLabel("f.tsx", badge).length, 0, "a mark taken out of the flow is in no row at all");
}
{
  const ornament = `<span className="inline-flex items-center">\n  <span className="h-2 w-2 rounded-full bg-pennie-green" />\n</span>`;
  eq(scanMarkedLabel("f.tsx", ornament).length, 0, "a mark with no word beside it has nothing to line up with");
}

// --- the real tree --------------------------------------------------------------

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...tsxFiles(path));
    } else if (path.endsWith(".tsx") && !path.includes(".test.")) {
      out.push(path);
    }
  }
  return out;
}

const files = tsxFiles("src");
assert(files.length > 50, `the tree was actually walked (found ${files.length} files)`);

const handRolled = files.flatMap((f) => scanMarkedLabel(f, readFileSync(f, "utf8")));
eq(
  handRolled.map((h) => `${h.file}:${h.line}`),
  [],
  "every mark beside a word is the shared component, or says why it is not",
);

// THE POSITIVE CONTROL. A scanner that matched nothing would report that same
// empty list, so it has to be seen catching a real instance (L1). This is the
// account menu's connected state exactly as it was written before this change,
// against the real file's path, so the owner list cannot be what excuses it.
{
  const planted = `      {calendar === "connected" && (
        <span className="inline-flex items-center gap-2 text-fg-muted">
          <span
            aria-hidden
            className="h-2 w-2 rounded-full bg-[var(--pennie-green-deep)]"
          />
          Calendar connected
        </span>
      )}`;
  const found = scanMarkedLabel("src/components/AccountMenu.tsx", planted);
  eq(found.length, 1, "the scanner catches the very row this issue was opened about");
}

// And the second control, because the first only proves it catches the shape it
// was written from. The booker's slot button is a different tag, a different mark
// size and a label that is an expression rather than a word.
{
  const planted = `<button
  onClick={() => setSelectedSlot(iso)}
  className="flex min-h-11 w-full items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm tabular-nums"
>
  <span className="h-1.5 w-1.5 rounded-full bg-pennie-green" style={dotStyle} />
  {fmtTime(iso)}
</button>`;
  eq(scanMarkedLabel("src/components/Booker.tsx", planted).length, 1, "and catches one on a button, with an expression for a label");
}

finish();
