// Running wrangler and the OpenNext adapter from the deploy and rollback scripts
// (#3095, #3094). I/O only; every decision about what to run lives in the pure
// modules beside it.
//
// Through `pnpm exec`, so the versions are the ones pinned in the lockfile rather than
// whatever a global install happens to be. Arguments are passed as an array (no shell)
// for wrangler. The adapter joins its own arguments through a shell when it calls
// wrangler, which is why `uploadArgs` never produces one that needs quoting.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { judgeTarget, retarget, type ResolvedWorker, type TargetJudgement } from "./wrangler-target.ts";

export const ROOT = join(import.meta.dirname, "..", "..");

/** `--env <name>` when a wrangler environment is targeted (the load test rehearsal). */
export function envArgs(env: string | undefined): string[] {
  const e = (env ?? "").trim();
  return e ? ["--env", e] : [];
}

/** Run a command, printing its output as it goes. True when it exited 0. */
export function runLoud(cmd: string, args: string[], extraEnv: Record<string, string> = {}): boolean {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...extraEnv } });
  return res.status === 0;
}

/** Run a command and capture its stdout (stderr still prints). Null when it failed. */
export function runCapture(cmd: string, args: string[]): string | null {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) return null;
  return res.stdout;
}

/** The JSON document in a `--json` command's stdout, tolerating a line printed before it. */
export function jsonPart(stdout: string | null): string {
  if (stdout === null) return "";
  const first = stdout.search(/[[{]/);
  return first === -1 ? "" : stdout.slice(first).trim();
}

/**
 * Resolve, print and judge the Worker this run targets (#3165), and refuse a mismatch
 * before anything is read or changed. From then on every line this process prints
 * names that Worker wherever it would have said "production" (`retarget`), so a
 * rehearsal's output can never read as a production run. Returns the judgement, or
 * exits with `refuseExit`.
 */
export function establishTarget(refuseExit: number): TargetJudgement & { ok: true } {
  // env-ok: WRANGLER_ENV (the load test rehearsal only; production is the top level)
  const env = process.env.WRANGLER_ENV;
  const out = runCapture("node", [join(ROOT, "scripts", "resolve-wrangler-target.mjs")]);
  let resolved: ResolvedWorker | null = null;
  try {
    const parsed = JSON.parse(out ?? "") as { name?: unknown; routes?: unknown };
    if (typeof parsed.name === "string" && Array.isArray(parsed.routes)) resolved = { name: parsed.name, routes: parsed.routes };
  } catch {
    resolved = null;
  }
  const target = judgeTarget(env, resolved);
  if (!target.ok) {
    console.error(`::error title=wrong target, nothing was touched::${target.reason}.`);
    process.exit(refuseExit);
  }
  console.log(`  target: ${target.label}${resolved ? `, routes ${JSON.stringify(resolved.routes)}` : ""}`);
  if (!target.production) {
    for (const method of ["log", "error", "warn"] as const) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) =>
        original(...args.map((a) => (typeof a === "string" ? retarget(a, target) : a)));
    }
  }
  return target;
}
