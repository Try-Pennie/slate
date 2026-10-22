// No native `<datalist>` anywhere in src (#2438).
//
// The Slack channel fields on /admin/alerts used one, and it failed twice. Chrome
// draws a datalist's suggestions as its own black popup that no Slate style can
// reach (L607), and an option's VALUE is what the browser writes into the box, so
// picking `#statuspage` put `C08A3BYMB29` in front of the person. A typeable list
// is `SlackChannelField` (or the TimeField pattern it follows): an editable box,
// a filtered list in `AnchoredPanel`, and a hidden input carrying the value.
//
// The guard is the other half of that replacement (L613): without it the next
// field needing suggestions reaches for the native element again.
//
// One pass per file, a plain substring test, no parse (L297).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-no-datalist.ts [root]
// The optional root exists so the guard can be shown to FAIL on a tree that still
// holds one (L1); the default is src.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

/** Whether a file's text opens a datalist element. Case insensitive, as HTML is. */
function holdsDatalist(text: string): boolean {
  return /<datalist\b/i.test(text);
}

// Positive controls: the scan must recognise the shape it hunts for, or a pattern
// that stopped matching would report a clean tree (L98).
assert(holdsDatalist(`<datalist id="x">`), "the scan sees a datalist");
assert(holdsDatalist(`  <DataList>`), "in any case");
assert(!holdsDatalist(`const list = data.list; // a datalist-free line`), "a word in a comment is not an element");

const root = process.argv[2] ?? "src";
const files = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((f) => /\.(tsx|ts|jsx|js|html)$/.test(f))
  // A test may NAME the element to assert it is gone.
  .filter((f) => !/\.test\.tsx?$/.test(f))
  .map((f) => join(root, f));
if (root === "src") {
  assert(files.length > 50, `the sweep really walked src (${files.length} files)`);
} else {
  assert(files.length > 0, `the sweep found files under ${root} (${files.length})`);
}

const offenders = files.filter((f) => holdsDatalist(readFileSync(f, "utf8")));
eq(
  offenders.join(", "),
  "",
  "no native <datalist> in src; use a Slate list (SlackChannelField, TimeField) instead",
);

finish();
