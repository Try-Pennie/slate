// Every lane lock says what happens when two runs overlap (#3120).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-lock-overlap-reasons.ts
//
// The rule and its reasoning live in scripts/lib/scan-lock-overlap.ts. This drives
// the scanner against planted fixtures in both directions, so a scanner that
// matched nothing cannot pass (L1, L98), then holds the real tree to it.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { lockCallSiteLines, scanLockOverlap, unreasonedLockSites } from "./lib/scan-lock-overlap.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- positive controls: an unexplained lock is caught -------------------------
{
  const bare = `const lock = await acquireLock("cron_x", TTL);`;
  eq(unreasonedLockSites("a.ts", bare).length, 1, "a lock with no reason is caught");

  const lease = `const lease = await acquireLease("cron_x", TTL);`;
  eq(unreasonedLockSites("a.ts", lease).length, 1, "a lease with no reason is caught too");

  const empty = `// lock-overlap:\nconst lock = await acquireLock("cron_x", TTL);`;
  eq(unreasonedLockSites("a.ts", empty).length, 1, "a marker that says nothing does not count");

  const claim = `const claim = await claimSyncLock("k", TTL);`;
  eq(unreasonedLockSites("a.ts", claim).length, 1, "#4261: a three way claimSyncLock with no reason is caught too");

  const inline = `x = (await acquireLock(\`k:\${c}\`, W)) !== null;`;
  eq(unreasonedLockSites("a.ts", inline).length, 1, "a call inside an expression is still a subject");
}

// --- negative controls: what is not a subject, and what satisfies the rule -----
{
  const reasoned = `// lock-overlap: idempotent deletes of past rows, so a second run deletes nothing new.\nconst lock = await acquireLock("cron_x", TTL);`;
  eq(unreasonedLockSites("a.ts", reasoned).length, 0, "a reasoned marker directly above satisfies it");

  const wrapped = `// lock-overlap: fenced. The lease renews before\n// each batch and stops once another run holds it.\nconst lease = await acquireLease("cron_x", TTL);`;
  eq(unreasonedLockSites("a.ts", wrapped).length, 0, "a reason that wraps over two comment lines counts");

  const seam = `acquireDispatchLock: () => w.acquireLock(cfg.lock, cfg.cooldownMs),`;
  eq(unreasonedLockSites("a.ts", seam).length, 0, "a call through an injected seam is not a subject");

  const definition = `export async function acquireLock(\n  key: string,`;
  eq(unreasonedLockSites("a.ts", definition).length, 0, "the definition is not a call site");
  const claimDefinition = `export async function claimSyncLock(key: string, ttlMs: number): Promise<LockClaim> {`;
  eq(unreasonedLockSites("a.ts", claimDefinition).length, 0, "nor is claimSyncLock's");

  const prose = ` * \`acquireLock\` (src/lib/locks.ts) is a lease; acquireLock(k, ttl) returns a token.`;
  eq(unreasonedLockSites("a.ts", prose).length, 0, "a doc comment naming the call is not a call site");
}

// --- the count and the findings judge a line the same way -----------------------
// The coverage count used to re-implement the call site test and skipped `//` and
// `*` lines but not `/*`, so a block comment naming the call counted as a site the
// findings never judged.
{
  const block = `/* acquireLock("k", T) is a lease */\nconst lock = await acquireLock("k", T);`;
  eq(lockCallSiteLines(block), [1], "a block comment opening line naming the call is not a site");
  eq(unreasonedLockSites("a.ts", block).map((f) => f.line), [2], "and the findings agree on the one real site");
}

// --- the real tree -------------------------------------------------------------
{
  const { findings, sites } = scanLockOverlap(repoRoot);
  // A scan that found no sites at all is a broken scan, not a clean tree.
  assert(sites >= 20, `the scan reached the tree's lock call sites (found ${sites})`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.text}`);
  }
  eq(
    findings.length,
    0,
    "every acquireLock / acquireLease call says what overlap does (`// lock-overlap: <reason>`, fenced or why a repeat write is safe)",
  );
}

finish();
