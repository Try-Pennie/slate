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
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

const CLAIM = /^(\d+)\.json$/;

function checkoutOf(path: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { checkout?: unknown };
    return typeof parsed.checkout === "string" ? parsed.checkout : "an unknown checkout";
  } catch {
    return "an unknown checkout";
  }
}

/**
 * Take the machine's browser run lock, held in `dir` as one claim file per run, named
 * by its pid. A run writes its own claim FIRST and only then reads the others, so of
 * two runs starting together the later reader always sees the earlier one's claim:
 * both can be refused (each run again), but both can never proceed. Nothing ever
 * removes a LIVE run's claim but that run: a claim whose pid is not running (a run
 * killed before its `finally`) is deleted by whoever finds it, which takes nothing
 * from anybody alive. The pid comes from the file NAME, so a claim read mid write is
 * still judged by its holder.
 */
export function acquireRunLock(
  dir: string,
  owner: RunLockOwner,
  deps: { isAlive: (pid: number) => boolean } = { isAlive: processIsAlive },
): RunLock {
  mkdirSync(dir, { recursive: true });
  const mine = join(dir, `${owner.pid}.json`);
  writeFileSync(mine, JSON.stringify(owner));
  const release = () => rmSync(mine, { force: true });
  for (const name of readdirSync(dir)) {
    const pid = Number(CLAIM.exec(name)?.[1] ?? NaN);
    if (!Number.isInteger(pid) || pid <= 0 || pid === owner.pid) continue;
    const claim = join(dir, name);
    if (!deps.isAlive(pid)) {
      rmSync(claim, { force: true });
      continue;
    }
    const checkout = checkoutOf(claim);
    release();
    return {
      ok: false,
      refusal:
        `Another browser run is in progress (pid ${pid}, from ${checkout}). ` +
        "Runs share this machine's local Supabase and port, so they take turns: wait for it to finish, then run again. " +
        `If no such run exists, delete ${claim}.`,
    };
  }
  return { ok: true, release };
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
