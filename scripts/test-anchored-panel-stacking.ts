// A floating panel stacks above the header and below the skip link (#1843).
//
// Found in a browser, not by reasoning. The time off calendar flips upward when
// there is no room below it, which puts its top at the top of the window, and
// with an automatic z-index the sticky app header painted over its first two
// rows. On screen that reads as a clipped panel, which is the exact defect this
// change exists to remove, so it would have shipped looking like a failed fix.
//
// The two bounds are READ FROM THE SOURCE rather than restated here, because a
// test that hardcoded 30 and 60 would pass happily after somebody raised the
// header and would be asserting a world that no longer exists (L41, L63).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-anchored-panel-stacking.ts
import { readFileSync } from "node:fs";
import { assert, finish } from "./lib/harness.ts";
import { ANCHORED_PANEL_Z } from "../src/components/ui/anchored-position.ts";

const header = readFileSync("src/components/AppHeader.tsx", "utf8");
const css = readFileSync("src/app/globals.css", "utf8");

const headerZ = Number(/<header className="sticky top-0 z-(\d+)/.exec(header)?.[1]);
const skipZ = Number(/\.pn-skip-link\s*\{[^}]*?z-index:\s*(\d+)/s.exec(css)?.[1]);

// Positive controls on the two reads. A regex that stopped matching would give
// NaN, and every comparison with NaN is false, so the assertions below would
// pass while measuring nothing (L50, L98).
assert(Number.isFinite(headerZ), `the sticky header's z-index was read (got ${headerZ})`);
assert(Number.isFinite(skipZ), `the skip link's z-index was read (got ${skipZ})`);
assert(headerZ < skipZ, `the two bounds are the right way round (${headerZ} < ${skipZ})`);

assert(
  ANCHORED_PANEL_Z > headerZ,
  `a panel (${ANCHORED_PANEL_Z}) paints above the sticky header (${headerZ}), or a panel that flips upward is covered by it`,
);
assert(
  ANCHORED_PANEL_Z < skipZ,
  `a panel (${ANCHORED_PANEL_Z}) stays below the skip link (${skipZ}), which must stay reachable over everything`,
);

finish();
