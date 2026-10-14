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
import { scrubbedGitEnv } from "./lib/git-env.ts";
import { assert, finish } from "./lib/harness.ts";

const SCRIPT = join(import.meta.dirname, "seed-worktree-node-modules.sh");

/** Run the helper with an explicit target + source; return {code, out}. */
function seed(target: string, source: string): { code: number; out: string } {
  const r = spawnSync("bash", [SCRIPT, target, source], { encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/**
 * A fake checkout dir with a lockfile and (optionally) a populated node_modules.
 * pnpm records the lockfile an install was made from at node_modules/.pnpm/lock.yaml;
 * `installed` is that record, the same as the lockfile by default, null for none (#3734).
 */
function makeCheckout(prefix: string, lock: string, withModules: boolean, installed: string | null = lock): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "pnpm-lock.yaml"), lock);
  if (withModules) {
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "MARKER"), "seeded-from-source");
    if (installed !== null) {
      mkdirSync(join(dir, "node_modules", ".pnpm"), { recursive: true });
      writeFileSync(join(dir, "node_modules", ".pnpm", "lock.yaml"), installed);
    }
  }
  return dir;
}

const created: string[] = [];
function tmp(prefix: string, lock: string, withModules: boolean, installed: string | null = lock): string {
  const d = makeCheckout(prefix, lock, withModules, installed);
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

  // 6. A PATH WITH SPACES AND A CURLY APOSTROPHE (#3050): the source is resolved from
  //    `git worktree list`, not passed in. Slate lives under
  //    `Documents - Dan’s MacBook Pro`, and reading that listing a word at a time kept
  //    only `.../Documents`, so the clone never ran and every worktree paid an install.
  {
    const parent = mkdtempSync(join(tmpdir(), "seed spaced Dan’s MacBook Pro "));
    created.push(parent);
    const main = join(parent, "main checkout");
    const wt = join(parent, "agent worktree");
    mkdirSync(main);
    // A hook run exports GIT_DIR and friends; the throwaway repo must not inherit them.
    const env = scrubbedGitEnv();
    const git = (cwd: string, ...args: string[]) =>
      spawnSync("git", ["-c", "user.name=seed", "-c", "user.email=seed@example.invalid", ...args], { cwd, env, encoding: "utf8" });
    writeFileSync(join(main, "pnpm-lock.yaml"), LOCK);
    mkdirSync(join(main, "node_modules"));
    writeFileSync(join(main, "node_modules", "MARKER"), "seeded-from-source");
    mkdirSync(join(main, "node_modules", ".pnpm"));
    writeFileSync(join(main, "node_modules", ".pnpm", "lock.yaml"), LOCK);
    const setup = [git(main, "init", "-q"), git(main, "add", "pnpm-lock.yaml"), git(main, "commit", "-q", "-m", "seed"), git(main, "worktree", "add", "-q", "--detach", wt)];
    const broken = setup.find((r) => r.status !== 0);
    assert(broken === undefined, `spaced: the throwaway repo and worktree were set up (${broken?.stderr ?? "ok"})`);
    const r = spawnSync("bash", [SCRIPT, wt], { encoding: "utf8", env });
    const out = `${r.stdout}${r.stderr}`;
    assert(r.status === 0, `spaced: seeds a worktree under a path with spaces and a curly apostrophe (got ${r.status}: ${out})`);
    assert(existsSync(join(wt, "node_modules", "MARKER")), "spaced: the clone came from the main checkout git resolved");
  }

  // 6b. A WORKTREE LIST LONGER THAN A PIPE HOLDS (#3742): the source is the listing's
  //     first entry, and a reader that stopped there left git writing into a closed
  //     pipe. Under pipefail that is exit 141 with nothing printed, which on 2026-10-14
  //     (a 13.6KB listing) seeded no worktree at all. A stub git prints the real
  //     source first and then far more than any pipe buffer holds.
  {
    const parent = mkdtempSync(join(tmpdir(), "seed-long-list-"));
    created.push(parent);
    const main = join(parent, "main");
    const wt = join(parent, "wt");
    const bin = join(parent, "bin");
    mkdirSync(main);
    mkdirSync(wt);
    mkdirSync(bin);
    writeFileSync(join(main, "pnpm-lock.yaml"), LOCK);
    writeFileSync(join(wt, "pnpm-lock.yaml"), LOCK);
    mkdirSync(join(main, "node_modules", ".pnpm"), { recursive: true });
    writeFileSync(join(main, "node_modules", "MARKER"), "seeded-from-source");
    writeFileSync(join(main, "node_modules", ".pnpm", "lock.yaml"), LOCK);
    // 4,000 stanzas is about 400KB, many times any pipe buffer.
    writeFileSync(
      join(bin, "git"),
      `#!/bin/bash\nprintf 'worktree %s\\nHEAD 0\\n\\n' ${JSON.stringify(main)}\nfor i in $(seq 1 4000); do printf 'worktree /tmp/agent-worktree-%05d\\nHEAD 0\\ndetached\\n\\n' "$i"; done\n`,
      { mode: 0o755 },
    );
    const r = spawnSync("bash", [SCRIPT, wt], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } });
    const out = `${r.stdout}${r.stderr}`;
    assert(r.status === 0, `long-list: seeds from the first worktree however long the listing is (got ${r.status}: ${out})`);
    assert(existsSync(join(wt, "node_modules", "MARKER")), "long-list: the clone came from the listing's first entry");
  }

  // 7. A SOURCE WHOSE LOCKFILE WAS PULLED BUT NEVER INSTALLED (#3734): both lockfiles
  //    match, yet the source's node_modules was installed from an older one. On
  //    2026-10-14 that cloned an install from 2026-09-02 that lacked two packages main
  //    imports, the seed said it succeeded, and the load run's build failed later.
  {
    const OLD = "lockfileVersion: '9.0'\npackages:\n  foo@0.9.0: {}\n";
    const source = tmp("seed-src7-", LOCK, true, OLD);
    const target = tmp("seed-tgt7-", LOCK, false);
    const r = seed(target, source);
    assert(r.code === 4, `stale-install: refuses on the lockfile mismatch exit (got ${r.code}: ${r.out})`);
    assert(!existsSync(join(target, "node_modules")), "stale-install: does not seed the stale install");
    assert(/installed/i.test(r.out) && /pnpm install/.test(r.out), `stale-install: says the source's install is out of date and to install (got ${r.out})`);
  }

  // 8. A SOURCE WITH NO RECORD OF WHAT IT INSTALLED: nothing says which lockfile its
  //    node_modules came from, so it cannot be judged current and is not cloned.
  {
    const source = tmp("seed-src8-", LOCK, true, null);
    const target = tmp("seed-tgt8-", LOCK, false);
    const r = seed(target, source);
    assert(r.code === 4, `no-install-record: refuses (got ${r.code}: ${r.out})`);
    assert(!existsSync(join(target, "node_modules")), "no-install-record: does not seed");
    assert(/\.pnpm\/lock\.yaml/.test(r.out), `no-install-record: names the missing record (got ${r.out})`);
  }

  // tree-write-ok: `created` only ever holds makeCheckout's mkdtempSync(tmpdir()) dirs
  for (const d of created) rmSync(d, { recursive: true, force: true });
  finish();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
