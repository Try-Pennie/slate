// The alert dispatcher's seam type lives in one place (#2572).
//
// Every monitor check takes the dispatcher as an injected dependency so a test can
// hand it a fake, and 26 files spelled that dependency's function type by hand, two
// lines each. Three of the last forty commits on main added another copy, so the
// global duplication guard's whole tree scan named it. `src/lib/monitor/alert-deps.ts`
// owns the shape now; this is the other half of the consolidation (L613): it fails on
// the next hand written copy anywhere in `src/`.
//
// Whether the type has the RIGHT shape is `tsc`'s job (every consumer and the
// dispatcher itself are checked against it there); this asks whether it is the ONLY
// spelling of the shape.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-alert-deps-type.ts
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import { sourceFiles } from "./lib/source-files.ts";

const HOME = "src/lib/monitor/alert-deps.ts";

/** The two shapes the copies took, as they were written. A test file may hold its
 *  own alias (a fake's type), so tests are out of scope. */
const HAND_WRITTEN = [
  // #3801 added an optional fourth argument (what a condition names); a copy that
  // spells it out is still a copy.
  /\(key: string, cooldownMs: number, text: string(?:, repeat\?: AlertRepeat)?\) => Promise</,
  /\(key: string, text: string\) => Promise</,
];

export function handWrittenSeams(src: string): number[] {
  const lines: number[] = [];
  src.split("\n").forEach((line, i) => {
    if (HAND_WRITTEN.some((re) => re.test(line))) lines.push(i + 1);
  });
  return lines;
}

// --- the predicate sees the shape it exists to catch --------------------------
eq(
  handWrittenSeams(
    "interface Deps {\n  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;\n}",
  ).join(","),
  "2",
  "positive control: the three argument notify shape is caught, on its line",
);
eq(
  handWrittenSeams("  resolve: (key: string, text: string) => Promise<unknown>;").join(","),
  "1",
  "positive control: the two argument resolve shape is caught whatever it resolves to",
);
eq(
  handWrittenSeams("  notify: ThrottledNotify;\n  resolve: AlertResolve<unknown>;").length,
  0,
  "a site using the shared type is not a copy",
);

// --- the shared module exists and exports the two names -----------------------
let home = "";
try {
  home = readFileSync(HOME, "utf8");
} catch {
  home = "";
}
assert(home.length > 0, `${HOME} exists`);
assert(/export type ThrottledNotify\b/.test(home), `${HOME} exports ThrottledNotify, the notify seam`);
assert(/export type AlertResolve\b/.test(home), `${HOME} exports AlertResolve, the resolve seam`);
eq(
  handWrittenSeams(home).length,
  2,
  "the home spells each shape exactly once (the definition itself), so a helper added there is not a second copy",
);

// --- the real tree: no other spelling ---------------------------------------
const files = sourceFiles({
  match: /\.tsx?$/,
  exclude: (f) => f.includes(".test.") || f === HOME,
});
const offenders: string[] = [];
for (const file of files) {
  for (const line of handWrittenSeams(readFileSync(file, "utf8"))) offenders.push(`${file}:${line}`);
}
assert(
  offenders.length === 0,
  `every alert seam uses ThrottledNotify / AlertResolve from ${HOME}; hand written copies at:\n  ${offenders.join("\n  ")}`,
);

finish();
