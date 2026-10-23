/**
 * What keeps a browser run testing the build THIS checkout made (#4018, L797).
 *
 * The run serves on a fixed port (`E2E_APP_PORT`, which the local auth server's
 * redirect list also names) against one local Supabase per machine (fixed project id
 * and ports, `e2e/supabase.config.toml`). Worktrees make two runs at once ordinary,
 * and before these guards the second one stopped the first one's stack, and its own
 * server died on a taken port while the readiness poll took the FIRST run's server
 * answering on that port as its own, so its specs ran against another checkout's build.
 *
 * Three guards, each pure or injected, so `scripts/test-e2e-run-guards.ts` drives them
 * without a stack:
 *
 *   1. `acquireRunLock`: one browser run per machine at a time. Per checkout ports
 *      would also need a Supabase stack per checkout (several gigabytes of containers
 *      each) and a rewritten auth redirect list, so the shared resources are taken in
 *      turn instead, and a second run is refused naming the one it waits on.
 *   2. `portHolders` / `portInUseRefusal`: nothing may already be listening on the
 *      port, on either loopback family, before our server starts. That is also a
 *      server orphaned by an earlier run that was killed, still serving its old build.
 *   3. `waitForOwnServer`: ready means OUR server printed that it is listening and is
 *      still running, never only that something answered on the port.
 */
import { connect } from "node:net";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------- the run lock

export interface RunLockOwner {
  pid: number;
  /** The checkout the run belongs to, so a refusal says which run to wait for. */
  checkout: string;
}

export type RunLock = { ok: true; release: () => void } | { ok: false; refusal: string };

/** Whether a process is running. EPERM means it exists under another user. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(path: string): RunLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunLockOwner>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return { pid: parsed.pid, checkout: typeof parsed.checkout === "string" ? parsed.checkout : "an unknown checkout" };
  } catch {
    return null;
  }
}

/**
 * Take the machine's browser run lock, created exclusively so two runs starting
 * together cannot both win. A lock whose holder is no longer running (a run killed
 * before its `finally`), or that cannot be read, is stale and taken over once; losing
 * that takeover to another run is a refusal like any other.
 */
export function acquireRunLock(
  path: string,
  owner: RunLockOwner,
  deps: { isAlive: (pid: number) => boolean } = { isAlive: processIsAlive },
): RunLock {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(owner), { flag: "wx" });
      return {
        ok: true,
        release: () => {
          // Only our own lock: a run that outlived its lock (taken over as stale)
          // must not remove the lock of the run that took it.
          if (readOwner(path)?.pid === owner.pid) rmSync(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = readOwner(path);
    if (holder && deps.isAlive(holder.pid)) {
      return {
        ok: false,
        refusal:
          `Another browser run is in progress (pid ${holder.pid}, from ${holder.checkout}). ` +
          "Runs share this machine's local Supabase and port, so they take turns: wait for it to finish, then run again.",
      };
    }
    rmSync(path, { force: true });
  }
  return { ok: false, refusal: `Another browser run took the lock at ${path} while this one was clearing a stale one. Run again once it finishes.` };
}

// ---------------------------------------------------------------- the port

/** The loopback addresses `localhost` can resolve to; a server on either answers `localhost`. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

function accepts(host: string, port: number, waitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (held: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(held);
    };
    // A loopback connect that neither connects nor refuses is something holding the
    // port badly, so it counts as held: the run refuses rather than guess.
    const timer = setTimeout(() => done(true), waitMs);
    socket.once("connect", () => done(true));
    // ECONNREFUSED is a free port; EADDRNOTAVAIL and the like are a family this
    // machine does not have, where nothing can be listening either.
    socket.once("error", () => done(false));
  });
}

/** Every loopback address on which something already accepts connections on `port`. */
export async function portHolders(port: number, hosts: readonly string[] = LOOPBACK_HOSTS, waitMs = 1_000): Promise<string[]> {
  const held = await Promise.all(hosts.map((h) => accepts(h, port, waitMs)));
  return hosts.filter((_, i) => held[i]);
}

export function portInUseRefusal(port: number, holders: readonly string[]): string | null {
  if (holders.length === 0) return null;
  return (
    `Something is already listening on port ${port} (${holders.join(", ")}), so the checks would run against whatever build it serves, ` +
    `not this checkout's. It is usually a server left behind by an earlier browser run that was killed, or a dev server. ` +
    `Stop it first (\`lsof -nP -iTCP:${port} -sTCP:LISTEN\` names the process), then run again.`
  );
}

// ---------------------------------------------------------------- readiness

/**
 * The line `next start` prints from its `listening` handler (Next 16,
 * `server/lib/start-server.js`), so it appears only once OUR server holds the port.
 * A Next upgrade that rewords it makes every run time out saying so, never pass.
 */
export const NEXT_READY_LINE = /\bReady in\b/;

export interface OwnServerDeps {
  /** Our server process's exit code, or null while it runs. */
  exitCode: () => number | null;
  /** Everything our server has printed so far. */
  output: () => string;
  /** Whether the app answers on its origin (any status under 500). */
  answers: () => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  origin: string;
}

export async function waitForOwnServer(deps: OwnServerDeps): Promise<void> {
  const deadline = deps.now() + deps.timeoutMs;
  while (deps.now() < deadline) {
    const code = deps.exitCode();
    if (code !== null) {
      const taken = /EADDRINUSE/.test(deps.output());
      throw new Error(
        taken
          ? `next start exited (${code}) with EADDRINUSE: another server already holds ${deps.origin}, so this run would have tested its build.`
          : `next start exited early (${code})`,
      );
    }
    if (NEXT_READY_LINE.test(deps.output()) && (await deps.answers()) && deps.exitCode() === null) return;
    await deps.sleep(500);
  }
  throw new Error(
    NEXT_READY_LINE.test(deps.output())
      ? `the app said it was listening but did not answer on ${deps.origin} within ${deps.timeoutMs / 1000}s`
      : `the app did not report listening on ${deps.origin} within ${deps.timeoutMs / 1000}s`,
  );
}
