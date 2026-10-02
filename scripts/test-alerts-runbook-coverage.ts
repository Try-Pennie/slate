// Repo invariant (#1047): every alert Slate can send has a procedure somebody can read.
//
// An alert with no procedure is one somebody will be paged by at 7am with nothing to
// read. There are 87 keys, and the reason this is a guard rather than a habit is that
// the keys nobody has ever been paged by are exactly the ones that would be forgotten,
// and those are the ones where a reader has no prior knowledge to fall back on.
//
// The runbook is organised by FAMILY, because the diagnosis clusters even though the
// keys do not: a stale lane is one procedure whichever lane it is. So the map lives in
// code (src/lib/notify/alert-runbook.ts) and this reads BOTH directions:
//
//   - every catalog key resolves to a family, so no alert is unwritten;
//   - every family has a section in the runbook, so the map cannot point at prose that
//     does not exist;
//   - every family claims at least one key, so a section cannot survive the last alert
//     that needed it (dead prose reads as a considered decision, L346).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-alerts-runbook-coverage.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALERT_CATALOG } from "../src/lib/notify/alert-catalog.ts";
import { ALERT_FAMILIES, alertFamily } from "../src/lib/notify/alert-runbook.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const DOC = "docs/alerts-runbook.md";
const markdown = readFileSync(join(ROOT, DOC), "utf8");

// The enumeration is the fragile half: a catalog that read as empty would report every
// direction clean (L98).
assert(ALERT_CATALOG.length > 50, `read the alert catalog (${ALERT_CATALOG.length} keys)`);
assert(markdown.length > 2000, `read ${DOC} (${markdown.length} chars)`);

// --- every key has a procedure ------------------------------------------------
{
  const unmapped = ALERT_CATALOG.map((e) => e.key).filter((k) => alertFamily(k) === null);
  assert(
    unmapped.length === 0,
    unmapped.length === 0
      ? `every one of the ${ALERT_CATALOG.length} alert keys has a runbook family`
      : `no runbook family for: ${unmapped.join(", ")}. Add it to src/lib/notify/alert-runbook.ts, and write the section first if none of the existing ones fits.`,
  );
}

// --- a real page's key resolves too, not just the catalog's pattern ----------
{
  // The catalog writes a prefixed family as `cron_lane_stale:*`; a real page carries the
  // instance. If only the pattern resolved, every actual page in a prefixed family would
  // land with no procedure, which is the half that matters.
  const samples = [
    "cron_lane_stale:outbox",
    "empty_tier:5",
    "webhook_dead:abc-123",
    "internal_error:admin/bookings/[id]/cancel",
    "bookable_blocked:agent@trypennie.com",
    "tier_fallback_deep:411",
    "retention_skipped:bookings",
  ];
  for (const key of samples) {
    assert(alertFamily(key) !== null, `a real page's key resolves: ${key}`);
  }
}

// --- every family exists as a section, with a stable anchor ------------------
{
  // The slug IS the anchor, so a reader following a family name lands somewhere. Derived
  // from the headings in the doc rather than trusted, because a renamed heading silently
  // breaks the link.
  const headingSlugs = [...markdown.matchAll(/^## (.+)$/gm)].map((m) =>
    m[1]!
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-"),
  );
  for (const family of ALERT_FAMILIES) {
    assert(
      headingSlugs.includes(family),
      `the runbook has a section for "${family}" (headings: ${headingSlugs.join(", ")})`,
    );
  }
}

// --- no family exists for nothing --------------------------------------------
{
  // Dead prose is worse than missing prose: a section for an alert that no longer exists
  // reads as a considered decision and the next reader argues with it (L346).
  const claimed = new Set(
    ALERT_CATALOG.map((e) => alertFamily(e.key)).filter((f): f is string => f !== null),
  );
  const orphans = ALERT_FAMILIES.filter((f) => !claimed.has(f));
  assert(
    orphans.length === 0,
    orphans.length === 0
      ? "every runbook family covers at least one live alert"
      : `these families cover no alert any more: ${orphans.join(", ")}`,
  );
}

// --- the families are distinguishable ----------------------------------------
{
  eq(new Set(ALERT_FAMILIES).size, ALERT_FAMILIES.length, "no duplicate family slugs");
  // A family that swallowed most of the catalog would pass every check above while
  // being a single page of prose covering everything, which is the same as no runbook.
  const counts = new Map<string, number>();
  for (const e of ALERT_CATALOG) {
    const f = alertFamily(e.key);
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const biggest = Math.max(...counts.values());
  assert(
    biggest <= Math.ceil(ALERT_CATALOG.length * 0.35),
    `no single family covers most of the catalog (biggest is ${biggest} of ${ALERT_CATALOG.length})`,
  );
}

// --- the doc says what to do before anything ---------------------------------
{
  // The steps that apply whatever fired: read the alert, check whether it measured
  // anything, check the site is up, look for an all-clear. A runbook that opens straight
  // into families sends a reader diagnosing a specific cause before establishing that
  // the site is even serving.
  for (const needle of ["/api/health", "all-clear", "wrangler tail"]) {
    assert(markdown.includes(needle), `the runbook's opening covers ${needle}`);
  }
}

finish();
