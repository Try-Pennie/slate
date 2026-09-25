// The runtime tree write tripwire for scripts/run-tests.ts (#2733).
//
// `pnpm test` runs the node suites concurrently and many of them walk `scripts/`
// or `src/`, so a suite that writes into that tree (even a file it removes again)
// hands every concurrent walker a file it can list and then fail to open. The
// static scan in test-no-tree-writes.ts (#2712) catches that shape in a suite's
// own source, and is blind to a write made by a child process the suite starts
// (`tsc`, `pnpm`, a shell script) or by a helper handed a repo path. This watches
// the tree itself for the length of the run, which sees every writer alike.
//
// WHEN IT IS ARMED. Only where nobody is editing: GitHub Actions, and the pre-push
// gate's isolated checkout (which sets SLATE_TREE_TRIPWIRE=pre-push on the one
// command it runs there). In a developer's own `pnpm test` it is off, because the
// developer's editor saving a file mid run would trip it, and it SAYS it is off on
// the first line and in the summary, so an unwatched pass never reads as a clean
// one (L98). Each source is something that ESTABLISHES the context rather than a
// guess at it (L319): the runner process sets GITHUB_ACTIONS=true, and the hook
// sets its own marker. A bare CI=true is deliberately not enough, since any tool
// may set it.
//
// Measured 2026-09-25 on macOS: a full `pnpm test` and a full `pnpm cf:build`
// (which the pre-push gate runs alongside the tests) wrote nothing at all into
// scripts/, src/ or worker/, so the allowed set is only the tripwire's own probe.
// A write that genuinely has to land in the tree gets an entry in
// ALLOWED_TREE_WRITES with its reason, never a looser pattern.
//
// WHAT IT CANNOT SEE, so a clean run is never read as more than it is (L400):
// the vitest suites (`pnpm test` runs them after this runner has exited), and
// writes anywhere outside scripts/, src/ and worker/.
import { watch, writeFileSync, rmSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

export const TRIPWIRE_WATCHED_DIRS = ["scripts", "src", "worker"] as const;

export type TripwireMode =
  | { kind: "on"; why: string }
  | { kind: "off"; why: string }
  | { kind: "refused"; why: string };

/** Decide whether this run is watched, from what established the context. */
export function resolveTripwireMode(env: Record<string, string | undefined>): TripwireMode {
  const set = env.SLATE_TREE_TRIPWIRE?.trim();
  if (set) {
    switch (set) {
      case "pre-push":
        return { kind: "on", why: "armed by the pre-push gate's isolated checkout" };
      case "on":
        return { kind: "on", why: "armed by SLATE_TREE_TRIPWIRE=on" };
      case "nested":
        return {
          kind: "off",
          why: "this runner was started by a suite, and the outer run's tripwire covers the tree",
        };
      case "off":
        return { kind: "off", why: "turned off by SLATE_TREE_TRIPWIRE=off" };
      default:
        return {
          kind: "refused",
          why: `SLATE_TREE_TRIPWIRE="${set}" is not a value this runner knows (pre-push, on, off, nested)`,
        };
    }
  }
  if (env.GITHUB_ACTIONS === "true") return { kind: "on", why: "armed by GitHub Actions" };
  return {
    kind: "off",
    why:
      "this is neither CI nor the pre-push gate's isolated checkout, and your own edits would trip it. " +
      "Arm it with SLATE_TREE_TRIPWIRE=on when nothing else is writing",
  };
}

/** The file the tripwire writes to prove a watcher is live, at the top of a watched dir. */
export function probeName(pid: number, n: number): string {
  return `.tree-write-tripwire-probe-${pid}-${n}`;
}
const PROBE_AT_TOP = /^[^/]+\/\.tree-write-tripwire-probe-\d+-\d+$/;

// Paths (relative to the repo root, forward slashes) a suite may write. Empty on
// purpose: nothing wrote into the tree when this was measured.
const ALLOWED_TREE_WRITES: ReadonlyArray<{ path: string; why: string }> = [];

export function isAllowedTreeWrite(rel: string): boolean {
  if (PROBE_AT_TOP.test(rel)) return true;
  return ALLOWED_TREE_WRITES.some((a) => a.path === rel);
}

export interface TreeWrite {
  path: string;
  /** Suites running or just finished when the event arrived: suspects, not a verdict. */
  suspects: string[];
}

export interface TreeWatch {
  /**
   * Wait until every event raised before this call has been delivered, then stop
   * watching and return the writes seen. Resolves to an error string when a
   * watcher never reported its own probe, since that watcher saw nothing.
   */
  stop(): Promise<{ writes: TreeWrite[] } | { error: string }>;
}

const FENCE_TIMEOUT_MS = 15_000;
const PROBE_RETOUCH_MS = 50;

/**
 * Watch each dir under root, recursively. Resolves once every watcher has
 * reported a probe written after it started, so a watcher that is not live on
 * this platform refuses the run instead of passing it unwatched (L1, L98), and
 * nothing a suite writes can land before the watch is actually listening.
 */
export async function startTreeWatch(
  root: string,
  suspects: () => string[],
): Promise<{ watch: TreeWatch } | { error: string }> {
  const writes: TreeWrite[] = [];
  const seen = new Set<string>();
  const waiting = new Map<string, () => void>();
  const watchers: FSWatcher[] = [];
  let probes = 0;

  const onEvent = (dir: string, filename: string | Buffer | null) => {
    const name = filename === null ? null : String(filename).split("\\").join("/");
    const rel = name === null ? `${dir}/<a path the platform did not name>` : `${dir}/${name}`;
    const wake = waiting.get(rel);
    if (wake) wake();
    if (isAllowedTreeWrite(rel) || seen.has(rel)) return;
    seen.add(rel);
    writes.push({ path: rel, suspects: suspects() });
  };

  for (const dir of TRIPWIRE_WATCHED_DIRS) {
    try {
      const w = watch(join(root, dir), { recursive: true }, (_ev, f) => onEvent(dir, f));
      w.on("error", (err) => writes.push({ path: `${dir}/<watcher error: ${err.message}>`, suspects: suspects() }));
      watchers.push(w);
    } catch (err) {
      for (const w of watchers) w.close();
      return { error: `could not watch ${dir}/ (${(err as Error).message}), so the tree would go unwatched` };
    }
  }

  // Write a probe at the top of every watched dir and wait until each watcher
  // reports its own. Events on one watcher arrive in order, so once the probe is
  // seen every write raised before it has been delivered too.
  const fence = async (): Promise<string | null> => {
    const results = await Promise.all(
      TRIPWIRE_WATCHED_DIRS.map(async (dir) => {
        const name = probeName(process.pid, probes++);
        const rel = `${dir}/${name}`;
        const path = join(root, dir, name);
        // Re-written until it is seen, not written once: on macOS the FSEvents
        // stream behind a fresh watch goes live a moment after watch() returns,
        // and a write in that moment is never reported at all. Measured: a
        // single probe written straight after watch() was missed on two of
        // three dirs. The wait is on the event itself, never a fixed sleep.
        let touches = 0;
        const arrived = new Promise<boolean>((res) => {
          const retouch = setInterval(() => writeFileSync(path, String(++touches)), PROBE_RETOUCH_MS);
          const timer = setTimeout(() => {
            clearInterval(retouch);
            res(false);
          }, FENCE_TIMEOUT_MS);
          waiting.set(rel, () => {
            clearInterval(retouch);
            clearTimeout(timer);
            res(true);
          });
        });
        writeFileSync(path, "");
        const ok = await arrived;
        waiting.delete(rel);
        rmSync(path, { force: true });
        return ok ? null : dir;
      }),
    );
    const deaf = results.filter((d): d is string => d !== null);
    return deaf.length === 0
      ? null
      : `the watcher on ${deaf.map((d) => `${d}/`).join(", ")} never reported the tripwire's own probe within ${FENCE_TIMEOUT_MS / 1000}s, so it saw nothing`;
  };

  const startErr = await fence();
  if (startErr) {
    for (const w of watchers) w.close();
    return { error: startErr };
  }

  return {
    watch: {
      async stop() {
        const endErr = await fence();
        for (const w of watchers) w.close();
        return endErr ? { error: endErr } : { writes };
      },
    },
  };
}
