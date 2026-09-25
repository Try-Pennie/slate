// Every booker entry point routes a blank code rather than refusing it (#1908).
// Run: node --experimental-strip-types scripts/test-booker-entry-catchall.ts
//
// WHY THIS EXISTS, and it is not hypothetical. The catch-all shipped fixing
// `/book` and left `/booking/[id]` refusing exactly as before, because the issue
// named one path and the fix was written against that one. Both are reached with
// an `xbc` that a Salesforce record may not have, so half the defect stayed live
// while the issue read as closed. This is the guard for the class rather than the
// instance (L30).
//
// It is a static scan on purpose. The alternative, a test per page, is the same
// omission in a different place: it can only cover the pages somebody remembered
// to write a test for, and the failure here was forgetting a page existed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const APP = "src/app";

/** Every file under src/app that renders the lead-facing Booker. */
function bookerEntryPoints(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!name.endsWith(".tsx")) continue;
      if (name.endsWith(".test.tsx")) continue;
      const src = readFileSync(path, "utf8");
      // The Booker element itself, not any component whose name starts with it:
      // the route error boundaries render `<BookerErrorBoundary` (#2732), which
      // takes no code at all and is not an entry point.
      if (/<Booker[\s/>]/.test(src)) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

const entries = bookerEntryPoints(APP);

// The scan finding nothing would pass every assertion below while checking
// nothing at all, which is the shape this whole file exists to prevent (L98).
assert(entries.length >= 2, `found the booker entry points to check (${entries.length}): ${entries.join(", ")}`);

for (const path of entries) {
  const src = readFileSync(path, "utf8");

  // Since #2638 the page resolves through `resolveLandingCode`, which runs the
  // shared catch-all (`resolveRequestedCode`) and, before falling back to it, the
  // lead's own Salesforce XBC. It is the ONE landing resolver, so a page calling
  // the bare catch-all would show the Low pool's times to a lead Salesforce
  // scores higher, and the confirm would then book them elsewhere.
  assert(
    src.includes("resolveLandingCode"),
    `${path} resolves the requested code through the shared landing resolver rather than trusting it`,
  );
  assert(
    !src.includes("resolveRequestedCode"),
    `${path} does not call the bare catch-all, which skips the Salesforce rescue (#2638)`,
  );

  // The specific refusal that was left behind. Named as a string because it is
  // what a lead actually saw, and because a page that still contains it has not
  // been converted whatever else it imports.
  assert(
    !src.includes("missing its configuration"),
    `${path} does not refuse a lead whose link carries no code`,
  );

  // The raw value has to reach the Booker, or the booking cannot be recorded as a
  // rescue and the rate the alert watches undercounts by that whole entry point.
  assert(
    src.includes("requestedCode={"),
    `${path} passes the raw code on, so a rescued booking through it is counted`,
  );
}

// --- positive controls -----------------------------------------------------------
// The scan has to actually catch each failure, or it is three assertions that
// cannot fail. Each control damages a REAL file's content in memory.
{
  const real = readFileSync(entries[0], "utf8");

  const unconverted = real
    .replace(/resolveLandingCode/g, "first")
    .replace(/requestedCode=\{/g, "somethingElse={");
  assert(!unconverted.includes("resolveLandingCode"), "control: a page that does not resolve is detectable");
  assert(!unconverted.includes("requestedCode={"), "control: a page that does not pass the raw code is detectable");

  const refusing = real + '\n// This booking link is missing its configuration\n';
  assert(refusing.includes("missing its configuration"), "control: the old refusal is detectable if it comes back");
}
{
  // And the walk itself: a root with no pages in it must not read as everything
  // being fine.
  const none = bookerEntryPoints("src/lib");
  eq(none.length, 0, "control: the walk finds no booker under src/lib, so it is really looking at file contents");
}

finish();
