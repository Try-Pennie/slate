// The impersonation marker's treatment appears in exactly ONE place (#2037).
//
// The whole value of it is that it looks like nothing else in Slate. Dan: "it
// should be jarring and obvious. Not anything that exists somewhere else in
// slate." A treatment reused anywhere else stops being a signal and becomes
// decoration, which is precisely what the navy bar it replaced had become.
//
// DESIGN.md's Hazard Rule says the same in words ("Do NOT extend this to a
// second surface"), and a rule stated only in prose is enforced by nothing
// (L27), so this is the enforcement.
//
// Run: node --experimental-strip-types scripts/test-impersonation-marker-unique.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk("src");
assert(files.length > 100, `the scanner found source to judge (${files.length})`);

// The paint itself: a repeating gradient in the marker's two colours. Anything
// drawing this is claiming to be a hazard surface.
const STRIPE = /repeating-linear-gradient/;
const stripeFiles = files.filter((f) => STRIPE.test(readFileSync(f, "utf8")));
eq(
  stripeFiles.join(", "),
  join("src", "app", "globals.css"),
  "the hazard stripe is painted in exactly one file",
);

const css = readFileSync(join("src", "app", "globals.css"), "utf8");
const stripeBlocks = css.match(/repeating-linear-gradient/g) ?? [];
eq(stripeBlocks.length, 1, "and exactly once within it");

// THE MUSTARD ITSELF IS DELIBERATELY NOT SCANNED, and saying so here is the
// point: yellow is a legitimate illustration and accent colour throughout the
// product (the roster's supply copy, the sync health panel and three other
// surfaces use it correctly today), so a check that counted it would fail on
// code that honours the design system exactly. What is unique to the marker is
// the hazard STRIPE above and the marker's own classes below, and those are what
// this file protects. The rule the mustard is under is "not a call to action",
// which is a judgement about a control rather than a pattern a scan can see.

// The marker's own classes are used by the marker and nowhere else.
for (const cls of ["pn-impersonation-strip", "pn-impersonation-edge", "pn-impersonation-exit"]) {
  const users = files.filter(
    (f) => !f.endsWith("globals.css") && readFileSync(f, "utf8").includes(cls),
  );
  const allowed = [
    join("src", "components", "ImpersonationFrame.tsx"),
    join("src", "components", "AppHeader.tsx"),
  ];
  const strays = users.filter((u) => !allowed.includes(u));
  eq(strays.join(", "), "", `${cls} is used by the marker alone`);
  assert(users.length > 0, `${cls} is actually used by something (not a dead class)`);
}

// A positive control on the stripe scan, since "exactly one file" is otherwise a
// claim a scanner that reads nothing would also satisfy (L98). It asserts the
// pattern really does match the paint the marker ships, read from the real file
// rather than restated here.
assert(
  STRIPE.test(css) && css.includes("--pennie-yellow") && css.includes("--pennie-navy"),
  "the stripe the scan found is the marker's own two-colour paint",
);

finish();
