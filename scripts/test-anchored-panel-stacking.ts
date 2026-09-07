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
import {
  ANCHORED_PANEL_Z,
  MAX_ANCHORED_PANEL_NESTING,
  anchoredPanelZ,
} from "../src/components/ui/anchored-position.ts";

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

// #2046: panels stack against EACH OTHER now, so the bound above has to hold for
// the whole range rather than for the base alone. A nested panel takes one level
// per panel it sits inside, and the deepest one the design supports still has to
// stay under the skip link.
const deepest = anchoredPanelZ(MAX_ANCHORED_PANEL_NESTING);
assert(
  deepest < skipZ,
  `the deepest nested panel (${deepest}) stays below the skip link (${skipZ})`,
);

// The levels really do separate, which is the whole point: two panels one inside
// the other may never land on one number. Asserted as a walk over the range
// rather than on the formula, so a future level scheme that is not `base + depth`
// has to satisfy the same rule rather than restate it (L63).
for (let depth = 0; depth < MAX_ANCHORED_PANEL_NESTING; depth += 1) {
  assert(
    anchoredPanelZ(depth + 1) > anchoredPanelZ(depth),
    `a panel nested ${depth + 1} deep (${anchoredPanelZ(depth + 1)}) paints above one at ${depth} (${anchoredPanelZ(depth)})`,
  );
}

// And the base is still where an unnested panel sits, so the range starts where
// the two bounds above were measured against.
assert(
  anchoredPanelZ(0) === ANCHORED_PANEL_Z,
  `an unnested panel is on the base level (${anchoredPanelZ(0)} === ${ANCHORED_PANEL_Z})`,
);

// A positive control on the loop: it has to have actually run, since a maximum of
// zero would make every assertion above vacuous and report a clean pass (L98).
assert(
  MAX_ANCHORED_PANEL_NESTING >= 2,
  `the app nests two panels, so the supported depth (${MAX_ANCHORED_PANEL_NESTING}) has to reach at least that`,
);

finish();
