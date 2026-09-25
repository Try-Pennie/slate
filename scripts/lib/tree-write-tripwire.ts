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

/**
 * What a finished watch saw. The two lists are separate outcomes on purpose:
 * a write is a suite's fault and has one remedy, a watch that broke is the
 * tripwire's own fault and has another, and filing one under the other sends
 * the reader to fix a thing that did not happen (L11). Either fails the run.
 */
export interface TripwireResult {
  writes: TreeWrite[];
  /** Watchers that errored, or an end probe that could not be written or was never seen. */
  watchFailures: string[];
}

export interface TreeWatch {
  /**
   * Wait until every event raised before this call has been delivered, then stop
   * watching and return what was seen. Never throws: anything that goes wrong
   * while stopping is itself a watch failure.
   */
  stop(): Promise<TripwireResult>;
}

/** Whether a finished watch fails the run: any write, or any sign it stopped seeing. */
export function tripwireFailed(r: TripwireResult): boolean {
  return r.writes.length > 0 || r.watchFailures.length > 0;
}

/** The lines the runner prints for a finished watch; empty when it saw nothing wrong. */
export function formatTripwireFindings(r: TripwireResult): string[] {
  const lines: string[] = [];
  if (r.writes.length > 0) {
    lines.push(
      `=== TREE WRITES: ${r.writes.length} path(s) under scripts/, src/ or worker/ were written during the run ===`,
    );
    for (const w of r.writes) {
      const who = w.suspects.length > 0 ? w.suspects.join(", ") : "none";
      lines.push(`  ${w.path}  (running or just finished when it was seen: ${who})`);
    }
    lines.push(
      "A suite that writes into the tree hands every concurrent suite walking it a file it can list and then fail to open (#2712).",
      "Write into a mkdtempSync(tmpdir()) directory instead. If the write must land in the tree, add it to",
      "ALLOWED_TREE_WRITES in scripts/lib/tree-write-tripwire.ts with the reason.",
    );
  }
  if (r.watchFailures.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `=== TREE WATCH FAILED: the tripwire stopped watching part of the tree, so this run is unverified ===`,
    );
    for (const f of r.watchFailures) lines.push(`  ${f}`);
    lines.push(
      "Nothing here says a suite wrote into the tree. A watcher that broke saw nothing after it broke,",
      "so the run cannot be called clean. Run it again; if it repeats, the error above is about the",
      "machine's file watching (a watch limit, a permission, a missing directory), not about a suite.",
    );
  }
  return lines;
}

const FENCE_TIMEOUT_MS = 15_000;
const PROBE_RETOUCH_MS = 50;

/** Seams for the tripwire's own failure paths; production passes none. */
export interface TreeWatchDeps {
  watch?: typeof watch;
  writeProbe?: (path: string, data: string) => void;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Watch each dir under root, recursively. Resolves once every watcher has
 * reported a probe written after it started, so a watcher that is not live on
 * this platform refuses the run instead of passing it unwatched (L1, L98), and
 * nothing a suite writes can land before the watch is actually listening.
 * Never throws: every way of failing to start resolves to `{ error }`.
 */
export async function startTreeWatch(
  root: string,
  suspects: () => string[],
  deps: TreeWatchDeps = {},
): Promise<{ watch: TreeWatch } | { error: string }> {
  const watchFn = deps.watch ?? watch;
  const writeProbe = deps.writeProbe ?? ((path: string, data: string) => writeFileSync(path, data));
  const writes: TreeWrite[] = [];
  const watchFailures: string[] = [];
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

  const closeAll = () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // Closing is best effort on the way out; the verdict is already decided.
      }
    }
  };

  for (const dir of TRIPWIRE_WATCHED_DIRS) {
    try {
      const w = watchFn(join(root, dir), { recursive: true }, (_ev, f) => onEvent(dir, f));
      w.on("error", (err) =>
        watchFailures.push(`the watcher on ${dir}/ failed (${reason(err)}) and saw nothing after that`),
      );
      watchers.push(w);
    } catch (err) {
      closeAll();
      return { error: `could not watch ${dir}/ (${reason(err)}), so the tree would go unwatched` };
    }
  }

  // Write a probe at the top of every watched dir and wait until each watcher
  // reports its own. Events on one watcher arrive in order, so once the probe is
  // seen every write raised before it has been delivered too. Resolves to one
  // reason per dir that could not be confirmed; never throws, because a throw
  // here would leave the runner with an unhandled rejection instead of a verdict.
  const fence = async (): Promise<string[]> => {
    const results = await Promise.all(
      TRIPWIRE_WATCHED_DIRS.map(async (dir): Promise<string | null> => {
        const name = probeName(process.pid, probes++);
        const rel = `${dir}/${name}`;
        const path = join(root, dir, name);
        // Re-written until it is seen, not written once: on macOS the FSEvents
        // stream behind a fresh watch goes live a moment after watch() returns,
        // and a write in that moment is never reported at all. Measured: a
        // single probe written straight after watch() was missed on two of
        // three dirs. The wait is on the event itself, never a fixed sleep.
        let touches = 0;
        let writeFailure: string | null = null;
        const arrived = new Promise<boolean>((res) => {
          let retouch: ReturnType<typeof setInterval> | undefined;
          const settle = (ok: boolean) => {
            if (retouch !== undefined) clearInterval(retouch);
            clearTimeout(timer);
            res(ok);
          };
          const timer = setTimeout(() => settle(false), FENCE_TIMEOUT_MS);
          const touch = () => {
            try {
              writeProbe(path, String(touches++));
            } catch (err) {
              writeFailure = `could not write the tripwire's probe ${rel} (${reason(err)})`;
              settle(false);
            }
          };
          waiting.set(rel, () => settle(true));
          touch();
          if (writeFailure === null) retouch = setInterval(touch, PROBE_RETOUCH_MS);
        });
        const ok = await arrived;
        waiting.delete(rel);
        try {
          rmSync(path, { force: true });
        } catch (err) {
          // A probe left behind is gitignored and harmless to the verdict; say so
          // rather than fail a run whose watch worked.
          console.error(`run-tests: could not remove the tripwire's probe ${rel} (${reason(err)}).`);
        }
        if (writeFailure !== null) return writeFailure;
        return ok
          ? null
          : `the watcher on ${dir}/ never reported the tripwire's own probe within ${FENCE_TIMEOUT_MS / 1000}s, so it saw nothing`;
      }),
    );
    return results.filter((r): r is string => r !== null);
  };

  const startFailures = await fence();
  if (startFailures.length > 0 || watchFailures.length > 0) {
    closeAll();
    return { error: [...startFailures, ...watchFailures].join("; ") };
  }
  // Anything reported before the start probes were seen was written BEFORE the
  // run: macOS delivers writes made a moment before the stream was created.
  // Measured: a root created just before the watch reported all six of its
  // entries as writes. The run starts here, so its record does too.
  writes.length = 0;
  seen.clear();

  return {
    watch: {
      async stop() {
        const endFailures = await fence();
        closeAll();
        return { writes, watchFailures: [...watchFailures, ...endFailures] };
      },
    },
  };
}
