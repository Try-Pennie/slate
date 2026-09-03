// How a listbox moves and matches, as pure functions (#1849).
//
// The app has about 19 native `<select>` elements, each dropping the operating
// system's own grey menu on top of a Pennie page, and one of them (the agent's
// home timezone) offers every zone the runtime knows, so the menu fills the
// whole browser window top to bottom. A native select cannot be styled or
// bounded, so replacing it means owning the keyboard contract it was providing
// for free.
//
// That contract is what this file pins, away from the DOM: arrow keys with
// wrapping, Home and End, and type ahead. jsdom could exercise these through the
// component, but a keyboard model is logic and testing it as logic is both
// faster and clearer about what the rules ARE. The component test then only has
// to prove it is wired to these.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-listbox-navigation.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { nextIndex, typeAheadIndex, TYPE_AHEAD_RESET_MS } from "../src/lib/ui/listbox-navigation.ts";

const N = 5;

// --- arrows wrap, so the ends of the list are not dead ends -----------------
eq(nextIndex(0, "ArrowDown", N), 1, "down moves on");
eq(nextIndex(N - 1, "ArrowDown", N), 0, "down from the last wraps to the first");
eq(nextIndex(0, "ArrowUp", N), N - 1, "up from the first wraps to the last");
eq(nextIndex(2, "Home", N), 0, "Home goes to the first");
eq(nextIndex(2, "End", N), N - 1, "End goes to the last");
eq(nextIndex(2, "a", N), null, "a key with no meaning here moves nothing");

// --- nothing selected yet: the first move enters the list --------------------
eq(nextIndex(null, "ArrowDown", N), 0, "down with nothing active starts at the first");
eq(nextIndex(null, "ArrowUp", N), N - 1, "up with nothing active starts at the last");

// --- an empty list cannot be walked -----------------------------------------
for (const key of ["ArrowDown", "ArrowUp", "Home", "End"] as const) {
  eq(nextIndex(null, key, 0), null, `${key} on an empty list moves nothing`);
}

// --- type ahead --------------------------------------------------------------
const ZONES = ["Eastern", "Central", "Mountain", "Pacific", "Alaska", "Arizona"];
{
  eq(typeAheadIndex(ZONES, "c", 0), 1, "one letter jumps to the first match");
  eq(typeAheadIndex(ZONES, "pa", 0), 3, "more letters narrow it");
  eq(typeAheadIndex(ZONES, "A", 0), 4, "matching ignores case");
  eq(typeAheadIndex(ZONES, "zz", 0), null, "no match moves nothing, rather than jumping to the first");

  // Searching starts AFTER the current row, so repeating a letter cycles through
  // the options that share it rather than sticking on the first (the behaviour a
  // native select has, and the reason "a" twice reaches Arizona).
  eq(typeAheadIndex(ZONES, "a", 4), 5, "the same letter again moves to the NEXT match");
  eq(typeAheadIndex(ZONES, "a", 5), 4, "and wraps around the end of the list");

  // A multi-character buffer must NOT skip the current row: typing "pa" while
  // already on Pacific has to keep it, or every second keystroke jumps away.
  eq(typeAheadIndex(ZONES, "pa", 3), 3, "a multi letter buffer can match where it already is");
}

// --- the buffer resets, or a pause looks like one long word -----------------
assert(
  TYPE_AHEAD_RESET_MS >= 500 && TYPE_AHEAD_RESET_MS <= 1500,
  `the type ahead buffer clears after a human pause (${TYPE_AHEAD_RESET_MS}ms)`,
);

finish();
