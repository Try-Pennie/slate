// One button in the booker, and one place its class string lives (#2562).
//
// The booker wrote `inline-flex min-h-{11,12,14} items-center justify-center
// rounded-lg px-{4,5} text-sm font-semibold ...` by hand at twelve sites,
// differing only in the trailing colour classes. Every spacing, radius or target
// size change to the lead facing buttons was a file wide find and replace, and a
// missed site is a visible inconsistency on the surface a customer sees.
//
// `BookerButton` (`src/components/booker-button.ts` for the classes,
// `BookerButton.tsx` for the element) owns that string now. A shared component
// that converts the site in front of you and leaves the next one to be hand
// written is not consolidation, so this is the other half of the change (L613):
// it fails on the next hand written copy anywhere on the booker surface.
//
// THE SURFACE IS DERIVED, not listed. It is every file reachable from
// `Booker.tsx` by an import that resolves inside `src/`, so a booker component
// added tomorrow is covered by construction rather than by somebody remembering
// to add it to a registry (L96). `/login` and the manage page carry the same
// shape and are deliberately NOT in reach here: they are separate surfaces with
// their own theming, and the booker's palette object is what this component
// takes.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-booker-button-single-source.ts
import { readFileSync, existsSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  bookerSurfaceFiles,
  handWrittenBookerButtons,
  isButtonClassString,
  type BookerFilesIo,
} from "./lib/scan-booker-buttons.ts";
import { bookerButtonClass } from "../src/components/booker-button.ts";

const ENTRY = "src/components/Booker.tsx";

const realIo: BookerFilesIo = {
  readFile: (p) => readFileSync(p, "utf8"),
  exists: (p) => existsSync(p),
};

// --- the predicate knows the shape, and only that shape ---------------------
//
// Fixtures first, because a predicate that answered true to everything would
// make every assertion below pass while measuring nothing.
assert(
  isButtonClassString(
    "inline-flex min-h-12 items-center justify-center rounded-lg px-5 text-sm font-semibold",
  ),
  "the shape the booker hand wrote is recognised",
);
assert(
  isButtonClassString(
    "group inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold",
  ),
  "so is the tall primary, which differs in every measurement but the shape",
);
assert(
  !isButtonClassString(
    "mt-1 inline-flex min-h-9 items-center text-sm font-semibold underline underline-offset-2",
  ),
  "a text trigger with no box is not a button class string",
);
assert(
  !isButtonClassString(
    "inline-flex min-h-9 items-center rounded-md border px-3 text-sm",
  ),
  "nor is the small chip retry inside the times panel",
);
assert(
  !isButtonClassString("inline-flex shrink-0 rounded-md border"),
  "nor is a container that merely lays its children out in a row",
);

// The control that matters most: the predicate must still recognise what the
// component ACTUALLY ships, not a sentence somebody wrote about it (L63). Every
// variant and size, composed the way a call site composes it.
for (const variant of ["primary", "secondary", "danger", "quiet"] as const) {
  for (const size of ["sm", "md", "lg"] as const) {
    assert(
      isButtonClassString(
        bookerButtonClass({
          palette: {
            toggleBorder: "border-border",
            body: "text-fg",
            navHover: "hover:bg-fg/10",
            confirm: "bg-accent text-fg-on-sky hover:bg-accent-hover",
            muted: "text-fg-muted",
          },
          variant,
          size,
        }),
      ),
      `the scan recognises what BookerButton ships for ${variant}/${size}`,
    );
  }
}

// --- the walk really reaches the booker's own components --------------------
const files = bookerSurfaceFiles(ENTRY, realIo);
assert(files.includes(ENTRY), "the walk starts at the booker itself");
for (const expected of [
  "src/components/BookerStrip.tsx",
  "src/components/SlotTimes.tsx",
  "src/components/NearestTimes.tsx",
  "src/components/ReasonPicker.tsx",
]) {
  assert(
    files.includes(expected),
    `the walk reaches ${expected}, so it is not stopping at the entry`,
  );
}
assert(
  files.length > 10,
  `the walk covers the booker surface (${files.length} files)`,
);

// --- and the tree is clean ---------------------------------------------------
const offenders = handWrittenBookerButtons(files, realIo);
eq(
  offenders.map((o) => `${o.file}: ${o.classes}`).join("\n"),
  "",
  "no hand written booker button class string; use BookerButton",
);

// --- the positive control, planted in memory rather than on disk ------------
//
// A scan that read nothing, or whose expression stopped matching, reports the
// same empty list a clean tree does (L98). So put a hand written copy back and
// require it to be caught, blamed on the right file, and quoted back.
const planted =
  'className="inline-flex min-h-12 items-center justify-center rounded-lg px-5 text-sm font-semibold text-white"';
const overlayIo: BookerFilesIo = {
  exists: realIo.exists,
  readFile: (p) =>
    p === ENTRY ? `${realIo.readFile(p)}\n// planted\nconst x = <button ${planted} />;\n` : realIo.readFile(p),
};
const caught = handWrittenBookerButtons(files, overlayIo);
eq(caught.length, 1, "the planted copy is the only thing found");
eq(caught[0]?.file, ENTRY, "and it is blamed on the file it was planted in");
assert(
  caught[0]?.classes.includes("min-h-12"),
  `and the finding quotes the class string (${caught[0]?.classes})`,
);

// A file it could not READ must be a loud failure, never a silent pass. A
// skipped file is a file exempt from the guard, and an exempt one reports
// exactly as a clean one does (L98).
let threw = false;
try {
  handWrittenBookerButtons(files, {
    exists: realIo.exists,
    readFile: (p) => {
      if (p === ENTRY) throw new Error("unreadable");
      return realIo.readFile(p);
    },
  });
} catch {
  threw = true;
}
assert(threw, "an unreadable file fails the scan rather than being skipped");

finish();
