// #3109: `rate_limits` is pruned, and the prune can only ever reach a LIMITER row
// that has outlived every limiter window.
//
// The table had no cleanup at all: one row per key for ever, and since #1033 the
// keys include a lead's normalized email and phone. The same table also holds the
// streak counters the cron lanes page from (`recordConsecutiveStreak`) and the
// boundary counts, whose windows run to hours. Deleting one of those mid streak
// would reset the count and hold back a page, so the prune is scoped by PREFIX to
// the limiter rules, never by age alone.
//
// What is pinned here, each with a control:
//   1. The prune's prefix list is DERIVED from every exported limiter rule set,
//      so a rule added later is pruned by construction rather than left to grow (L41).
//   2. Its age bound clears every limiter window by a margin, so a row whose
//      window is still open is never touched.
//   3. No literal key anywhere else in src starts with a limiter prefix, which is
//      the only way a streak or boundary key could fall inside the prune's scope.
//   4. The SQL function deletes by prefix plus a colon and by the database's own
//      clock, under the pinned search_path every Slate function carries.
//
// The route wiring is driven in src/app/api/cron/prune-regal-calls/route.test.ts.
// Run: node --experimental-strip-types scripts/test-rate-limit-prune.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as core from "../src/lib/rate-limit-core.ts";
import {
  pruneRateLimits,
  rateLimitPrunePlan,
  RATE_LIMIT_PRUNE_MARGIN_SECONDS,
  type RateLimitRule,
} from "../src/lib/rate-limit-core.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");

function isRuleSet(value: unknown): value is RateLimitRule[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (r) =>
        r !== null &&
        typeof r === "object" &&
        typeof (r as RateLimitRule).prefix === "string" &&
        typeof (r as RateLimitRule).windowSeconds === "number",
    )
  );
}

// 1. Derived from every exported rule set, read off the module itself.
const exportedRules = Object.values(core).filter(isRuleSet).flat();
assert(exportedRules.length >= 10, `found the exported limiter rules (${exportedRules.length})`);
const plan = rateLimitPrunePlan();
eq(
  [...plan.prefixes].sort(),
  [...new Set(exportedRules.map((r) => r.prefix))].sort(),
  "the prune covers exactly the prefixes of every exported limiter rule",
);
assert(
  plan.prefixes.includes("book:contact:h"),
  "the per contact rule, whose keys are a lead's email and phone, is in scope",
);
assert(plan.prefixes.every((p) => p.length > 0), "no prefix is empty (an empty one would match every key)");

// 2. The age bound clears every window by the margin.
assert(RATE_LIMIT_PRUNE_MARGIN_SECONDS >= 600, "the margin is at least ten minutes");
const longest = Math.max(...exportedRules.map((r) => r.windowSeconds));
eq(plan.olderThanSeconds, longest + RATE_LIMIT_PRUNE_MARGIN_SECONDS, "older than the longest window plus the margin");
for (const rule of exportedRules) {
  assert(
    plan.olderThanSeconds >= rule.windowSeconds + RATE_LIMIT_PRUNE_MARGIN_SECONDS,
    `${rule.prefix}: a row inside its ${rule.windowSeconds}s window is never old enough to prune`,
  );
}

// A rule set declared outside the core module would be invisible to the
// derivation above, so the derivation is only complete while none exists.
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}
const srcFiles = walk(join(root, "src")).filter((f) => !f.endsWith(join("lib", "rate-limit-core.ts")));

const RULE_LITERAL = /RateLimitRule\[\]\s*=\s*\[/;
const outsideRuleSets = srcFiles.filter((f) => RULE_LITERAL.test(readFileSync(f, "utf8")));
eq(
  outsideRuleSets.map((f) => relative(root, f)),
  [],
  "every limiter rule set lives in rate-limit-core.ts, where the prune derives from",
);
assert(
  RULE_LITERAL.test("export const X: RateLimitRule[] = [{ prefix: 'x:h', windowSeconds: 3600, max: 1 }];"),
  "CONTROL: the rule set detector recognises a declared rule set",
);

// 3. Nothing else writes a key the prune would reach.
function collidingLiterals(text: string, prefixes: string[]): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
    const literal = m[1]!;
    if (prefixes.some((p) => literal.startsWith(`${p}:`))) hits.push(literal);
  }
  return hits;
}
const collisions = srcFiles.flatMap((f) =>
  collidingLiterals(readFileSync(f, "utf8"), plan.prefixes).map((hit) => `${relative(root, f)}: ${hit}`),
);
eq(collisions, [], "no streak, boundary or other literal key falls inside a limiter prefix");
eq(
  collidingLiterals(`const STREAK = "book:h:monitor_streak";`, plan.prefixes),
  ["book:h:monitor_streak"],
  "CONTROL: a streak key named inside a limiter prefix is caught",
);
eq(
  collidingLiterals(`const STREAK = "streak:booker_empty_reason";`, plan.prefixes),
  [],
  "CONTROL: an ordinary streak key is not",
);

// The orchestration: the plan reaches the delete, and a failed delete is a
// failure rather than a quiet zero (#1165).
{
  const seen: Array<[string[], number]> = [];
  const result = await pruneRateLimits({
    prune: async (prefixes, olderThanSeconds) => {
      seen.push([prefixes, olderThanSeconds]);
      return 42;
    },
  });
  eq(result.deleted, 42, "reports what the delete removed");
  eq(seen.length, 1, "one delete statement per run");
  eq(seen[0]?.[1], plan.olderThanSeconds, "the delete is given the planned age bound");
  eq([...(seen[0]?.[0] ?? [])].sort(), [...plan.prefixes].sort(), "the delete is given the planned prefixes");

  let threw = "";
  try {
    await pruneRateLimits({
      prune: async () => {
        throw new Error("permission denied for function prune_rate_limits");
      },
    });
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(/permission denied/.test(threw), "a refused delete propagates rather than reading as zero deleted");
}

// 4. The SQL function.
const migDir = join(root, "supabase", "migrations");
const migFile = readdirSync(migDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .reverse()
  .find((f) => /function\s+prune_rate_limits\s*\(/i.test(readFileSync(join(migDir, f), "utf8")));
assert(migFile !== undefined, "a migration defines prune_rate_limits(...)");
const code = (migFile ? readFileSync(join(migDir, migFile), "utf8") : "")
  .toLowerCase()
  .replace(/--.*$/gm, "")
  .replace(/\s+/g, " ");
const fn = code.match(/function prune_rate_limits\s*\([\s\S]*?\$\$([\s\S]*?)\$\$/)?.[1] ?? "";
assert(fn.length > 0, "prune_rate_limits has a body");
assert(/security definer/.test(code) && /set search_path = public/.test(code), "SECURITY DEFINER under the pinned search_path");
assert(/delete from rate_limits/.test(fn), "deletes from rate_limits");
assert(
  /starts_with\s*\(\s*key\s*,\s*\w+(\.\w+)?\s*\|\|\s*':'\s*\)/.test(fn),
  "matches a key by its prefix PLUS the colon, so book:h never reaches book:contact:h or a streak key",
);
assert(/window_start\s*<\s*now\(\)\s*-/.test(fn), "ages a row on the database clock that stamped it (L736)");
assert(!/\blike\b/.test(fn), "no LIKE, whose _ and % would turn a prefix into a pattern");
assert(/raise exception/.test(fn), "refuses a bad argument rather than deleting on it");
assert(
  /revoke (all|execute) on function prune_rate_limits\(text\[\], ?int(eger)?\) from public, anon, authenticated/.test(code),
  "denied to the API roles",
);

finish();
