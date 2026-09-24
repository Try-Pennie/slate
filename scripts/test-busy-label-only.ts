// Guard (#2636): the moving cue inside a BUTTON is drawn only by BusyLabel.
//
// Safari lays a button's children out inside an anonymous box that does not
// carry the button's `gap`, so a cue placed straight into a button sits against
// its label: on Dan's iPhone the third dot touched the "M" of "Moving your
// call…". BusyLabel puts the dots and the words in a span that carries the
// spacing. The in-button form of the cue is `tone="current"`, so that spelling
// anywhere else is a hand rolled copy of the thing BusyLabel exists to own.
// Run: node --experimental-strip-types scripts/test-busy-label-only.ts
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/source-files.ts";
import { assert, finish } from "./lib/harness.ts";

const OWNER = "src/components/BusyLabel.tsx";
const IN_BUTTON_CUE = /<BobbingDots\s+tone=["']current["']/;

/** Files, other than the owner, that draw the in-button cue themselves. */
function handRolled(files: { path: string; text: string }[]): string[] {
  return files
    .filter((f) => f.path !== OWNER && !/\.test\.tsx?$/.test(f.path))
    .filter((f) => IN_BUTTON_CUE.test(f.text))
    .map((f) => f.path);
}

// Positive control: the scan must catch a hand rolled cue, and must not blame
// the owner for its own.
assert(
  handRolled([
    { path: "src/components/Stray.tsx", text: `{busy && <BobbingDots tone="current" />}` },
    { path: OWNER, text: `<BobbingDots tone="current" />` },
  ]).join() === "src/components/Stray.tsx",
  "the scan catches a hand rolled in-button cue and leaves the owner alone",
);

const files = sourceFiles({ match: /^src\/.*\.tsx$/ })
  .map((path) => ({ path, text: readFileSync(path, "utf8") }));
assert(files.length > 0, "the scan read the source tree, so a pass is not an empty read");
assert(
  files.some((f) => f.path === OWNER && IN_BUTTON_CUE.test(f.text)),
  "BusyLabel itself draws the in-button cue, so the rule names a real owner",
);

const stray = handRolled(files);
assert(stray.length === 0, `no file but BusyLabel draws the in-button cue (found: ${stray.join(", ") || "none"})`);

finish();
