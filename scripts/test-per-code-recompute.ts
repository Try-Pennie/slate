// Repo invariant (#2357): no sweep loops a whole pool compute per bucket CODE.
//
// The sync lane's post sync refresh and both self heal reconcile sweeps each looped
// `recomputeBucketSlotsForToday` over up to 20 or 25 codes, a whole pool compute
// apiece with no time bound, and on the load test Worker that took a minute tick
// to 119,137 ms of CPU against the 120,000 ms kill (run 34991614423). They now go
// through `refreshPoolsForAgents`. This guard keeps a fourth copy of the loop from
// arriving: every call site is on a named list with its reason.
//
// Run: node --experimental-strip-types scripts/test-per-code-recompute.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ALLOWED_PER_CODE_RECOMPUTE,
  perCodeRecomputeSites,
  unexpectedPerCodeRecomputes,
} from "./lib/scan-per-code-recompute.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

// --- positive controls: the detector must catch the shape it exists for ---------
{
  const loop = [
    "for (const code of touched) {",
    "  await recomputeBucketSlotsForToday(code, true).catch(() => {});",
    "}",
  ].join("\n");
  const sites = perCodeRecomputeSites("src/app/api/cron/sync/route.ts", loop);
  eq(sites.length, 1, "a per code recompute inside a sweep is found");
  const findings = unexpectedPerCodeRecomputes(sites);
  eq(findings.length, 1, "and a file not on the list is refused");
  assert(findings[0]!.includes("refreshPoolsForAgents"), "and the refusal names the remedy");

  // An allowed file going over its count is refused too: a second call in the
  // booking service is a new site, not the one whose reason is recorded.
  const twice = perCodeRecomputeSites(
    "src/lib/monitor-like.ts",
    "recomputeBucketSlotsForToday(a);\nrecomputeBucketSlotsForToday(b);",
  ).map((s) => ({ ...s, file: "src/app/api/cron/monitor/route.ts" }));
  eq(unexpectedPerCodeRecomputes(twice).length, 1, "an allowed file over its count is refused");

  eq(
    perCodeRecomputeSites("x.ts", "export async function recomputeBucketSlotsForToday(").length,
    0,
    "the definition itself is not a call",
  );
}

// --- the real tree ----------------------------------------------------------------
{
  const sites = sourceFiles(join(ROOT, "src")).flatMap((f) =>
    perCodeRecomputeSites(relative(ROOT, f), readFileSync(f, "utf8")),
  );
  // The scan must have SEEN the allowed sites, or a broken walk passes on nothing (L98).
  for (const [file, { count }] of Object.entries(ALLOWED_PER_CODE_RECOMPUTE)) {
    eq(
      sites.filter((s) => s.file === file).length,
      count,
      `${file} holds exactly its ${count} recorded per code recompute(s)`,
    );
  }
  const findings = unexpectedPerCodeRecomputes(sites);
  for (const f of findings) console.error(f);
  eq(findings.length, 0, "no unrecorded per code recompute in src/");
}

finish();
