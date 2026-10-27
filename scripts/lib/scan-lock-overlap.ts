// Every lane lock says what happens when two runs overlap (#3120).
//
// `acquireLock` is a TTL lease in `sync_locks`: once the TTL passes, the next
// invocation may take the key while the previous run is still working, and both
// then write at once with the older one unaware. Whether that is harmless depends
// entirely on what the lane writes, and nothing recorded the answer, so each new
// lane inherited the lock's shape without anybody asking the question.
//
// So every call site carries `// lock-overlap: <reason>`, on its line or in the
// comment block directly above, and the reason says one of two things: the lane is
// FENCED (it takes a lease through `acquireLease` and asks `stillHeld()` before
// each unit of work), or why a second run writing alongside it is safe. The marker
// is read by the shared reader (`opt-out.ts`), so a marker with no reason does not
// count.
//
// Subjects are found from the CALLS, not from a list of lanes, so a new lane is
// covered by construction (L96). A call reached through a property (`w.acquireLock`
// in an injected seam) is not a subject: the seam's real wiring is the call site.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { hasOptOut } from "./opt-out.ts";

export const LOCK_OVERLAP_TOKEN = "lock-overlap:";

/**
 * A direct call: not `x.acquireLock(`, not the definition, not a comment line.
 * `claimSyncLock` is the same TTL claim answering in three words (#4261), so it is a
 * subject too.
 */
const CALL = /(?<![.\w])(?:acquire(?:Lock|Lease)|claimSyncLock)\(/;

export interface LockSiteFinding {
  file: string;
  line: number;
  text: string;
}

/**
 * The ONE judgement of what a call site is, as line indexes. Both the findings and
 * the coverage count read it, so the two can never disagree about a line: a count
 * that skipped one comment form the findings did not would report coverage of
 * sites that are never judged.
 */
export function lockCallSiteLines(source: string): number[] {
  const out: number[] = [];
  source.split("\n").forEach((raw, i) => {
    const t = raw.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    if (/\bfunction\s+(?:acquire(?:Lock|Lease)|claimSyncLock)\b/.test(t)) return;
    if (CALL.test(raw)) out.push(i);
  });
  return out;
}

/** The call sites in one source that carry no reasoned `lock-overlap:` marker. */
export function unreasonedLockSites(file: string, source: string): LockSiteFinding[] {
  const lines = source.split("\n");
  return lockCallSiteLines(source)
    .filter((i) => !hasOptOut(lines, i, LOCK_OVERLAP_TOKEN))
    .map((i) => ({ file, line: i + 1, text: lines[i].trim() }));
}

function walk(dir: string, acc: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

/** Every unreasoned site under `src/`, the lock module itself excluded. */
export function scanLockOverlap(repoRoot: string): { findings: LockSiteFinding[]; sites: number } {
  const findings: LockSiteFinding[] = [];
  let sites = 0;
  for (const abs of walk(join(repoRoot, "src"), [])) {
    const file = relative(repoRoot, abs);
    if (file === join("src", "lib", "locks.ts")) continue;
    const source = readFileSync(abs, "utf8");
    sites += lockCallSiteLines(source).length;
    findings.push(...unreasonedLockSites(file, source));
  }
  return { findings, sites };
}
