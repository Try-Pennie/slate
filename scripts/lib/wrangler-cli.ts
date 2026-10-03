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
