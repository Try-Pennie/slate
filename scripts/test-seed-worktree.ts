// Regression + behavior lock for scripts/seed-worktree-node-modules.sh (#852), the
// helper that seeds a parallel-dispatch Agent worktree's node_modules from the main
// checkout via an APFS clonefile clone instead of a slow sandboxed network install.
//
// Drives the real bash helper against throwaway temp dirs with a tiny fake
// node_modules, so it exercises the decision logic (seed / skip / refuse) end to end
// without a 1G copy or a network install. Run:
//   node --experimental-strip-types scripts/test-seed-worktree.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const SCRIPT = join(import.meta.dirname, "seed-worktree-node-modules.sh");

/** Run the helper with an explicit target + source; return {code, out}. */
function seed(target: string, source: string): { code: number; out: string } {
  const r = spawnSync("bash", [SCRIPT, target, source], { encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** A fake checkout dir with a lockfile and (optionally) a populated node_modules. */
function makeCheckout(prefix: string, lock: string, withModules: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "pnpm-lock.yaml"), lock);
  if (withModules) {
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "MARKER"), "seeded-from-source");
  }
  return dir;
}

const created: string[] = [];
function tmp(prefix: string, lock: string, withModules: boolean): string {
  const d = makeCheckout(prefix, lock, withModules);
  created.push(d);
  return d;
}

async function main() {
  const LOCK = "lockfileVersion: '9.0'\npackages:\n  foo@1.0.0: {}\n";

  // 1. SEEDS: a fresh target with a matching lockfile gets node_modules cloned in.
  {
    const source = tmp("seed-src-", LOCK, true);
    const target = tmp("seed-tgt-", LOCK, false);
    const r = seed(target, source);
    assert(r.code === 0, `seed: exits 0 on success (got ${r.code}: ${r.out})`);
    assert(existsSync(join(target, "node_modules", "MARKER")), "seed: copies node_modules into the target");
  }

  // 2. IDEMPOTENT: a target that already has node_modules is left alone (no error, fast).
  {
    const source = tmp("seed-src2-", LOCK, true);
    const target = tmp("seed-tgt2-", LOCK, true); // already populated
    const r = seed(target, source);
    assert(r.code === 0, `idempotent: exits 0 when already seeded (got ${r.code})`);
    assert(/already|skip/i.test(r.out), `idempotent: says it skipped (got ${r.out})`);
  }

  // 3. FAILURE PATH (missing source node_modules): cannot seed, must refuse and instruct
  //    an install rather than silently leaving the target empty (fail loud).
  {
    const source = tmp("seed-src3-", LOCK, false); // no node_modules to clone
    const target = tmp("seed-tgt3-", LOCK, false);
    const r = seed(target, source);
    assert(r.code !== 0, `missing-source: exits non-zero (got ${r.code})`);
    assert(!existsSync(join(target, "node_modules")), "missing-source: does not create a bogus node_modules");
    assert(/install/i.test(r.out), `missing-source: points at pnpm install (got ${r.out})`);
  }

  // 4. FAILURE PATH (lockfile mismatch): the source deps would be stale for this target,
  //    so refuse the clone and instruct an install instead of seeding wrong dependencies.
  {
    const source = tmp("seed-src4-", LOCK, true);
    const target = tmp("seed-tgt4-", "lockfileVersion: '9.0'\npackages:\n  foo@2.0.0: {}\n", false);
    const r = seed(target, source);
    assert(r.code !== 0, `lock-mismatch: exits non-zero (got ${r.code})`);
    assert(!existsSync(join(target, "node_modules")), "lock-mismatch: does not seed stale deps");
    assert(/lock|install/i.test(r.out), `lock-mismatch: explains why (got ${r.out})`);
  }

  // 5. NO-OP when target IS the source (running it in the main checkout itself): it must
  //    not try to copy a dir onto itself; already-present node_modules just passes.
  {
    const both = tmp("seed-self-", LOCK, true);
    const r = seed(both, both);
    assert(r.code === 0, `self: exits 0 when target equals source (got ${r.code}: ${r.out})`);
    assert(existsSync(join(both, "node_modules", "MARKER")), "self: leaves the existing node_modules intact");
  }

  for (const d of created) rmSync(d, { recursive: true, force: true });
  finish();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
