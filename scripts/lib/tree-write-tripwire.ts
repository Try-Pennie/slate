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
// TWO ARMS, one library (#2759). scripts/run-tests.ts watches the node suites, and
// scripts/vitest-tree-tripwire.ts, a global setup vitest.config.ts declares, watches
// the vitest suites (`pnpm test` runs them after the node runner has exited, so the
// runner's watch cannot cover them). Both decide with resolveTripwireMode, so the
// two are armed and disarmed by one rule.
//
// THE WATCH CAN DROP WRITES ON macOS, SILENTLY (#3524). Under load fseventsd drops
// events and marks the batch with kFSEventStreamEventFlagUserDropped or KernelDropped,
// and libuv, which is what node's fs.watch is on macOS, skips every event carrying
// those flags (kFSEventsSystem in src/unix/fsevents.c), so node is never told. libuv
// also runs ONE FSEventStream per process for every watcher, so a stall takes all
// three dirs at once. A write in a dropped window was simply never reported, and the
// end fence, which re-touches its probe until it is seen, waits the stall out and
// passes: the run read clean. So the watch is backed by a BEFORE AND AFTER
// COMPARISON of every file's size, mtime and inode, taken when the run starts and
// when it stops. Any file that differs and the watch never named still fails the run,
// labelled as found by the comparison. The watch is still what sees a file made and
// removed again inside the run (the #2712 hazard itself) and what names suspects.
// The comparison also judges the opposite error: macOS can deliver an event for a
// write made just BEFORE the stream existed after the start fence, which read as a
// write in the run. A path the watch named that is identical at both ends was not
// touched during the run, so that event is dropped.
//
// WHAT IT CANNOT SEE, so a clean run is never read as more than it is (L400):
// writes anywhere outside scripts/, src/ and worker/; on macOS under load, a file
// created AND removed again inside a window the platform dropped (the comparison sees
// net changes only); and, in the vitest arm, WHICH vitest file made a write (the
// global setup runs in vitest's main process and is told nothing about the files its
// workers are running). A write the comparison alone found names nobody, since by
// then nothing says when it happened.
import { lstatSync, readdirSync, watch, writeFileSync, rmSync, type Dirent, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";

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

/**
 * The root both arms watch: the repository, unless SLATE_TREE_TRIPWIRE_ROOT points
 * elsewhere, which exists only so the tripwire's own tests can plant writes in a
 * throwaway tree rather than in this one.
 */
export function tripwireWatchRoot(env: Record<string, string | undefined>, repoRoot: string): string {
  const override = env.SLATE_TREE_TRIPWIRE_ROOT?.trim();
  return override ? resolve(override) : repoRoot;
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
  /** True when only the before and after comparison found it: the watch never reported it. */
  missedByWatch?: boolean;
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
      if (w.missedByWatch) {
        lines.push(
          `  ${w.path}  (found by the before and after comparison; the file watch never reported it, so nobody can be named)`,
        );
        continue;
      }
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
      `${WATCH_FAILED_HEADER}: the tripwire stopped watching part of the tree, so this run is unverified ===`,
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

/**
 * How long a fence waits for a watcher to report its own probe (#3524).
 *
 * It waits on the EVENT, so this bound costs a healthy machine nothing; it only says
 * how long a stalled stream is given before the run is refused. Measured 2026-10-12
 * on a loaded macOS developer machine (load 10 to 30): 52 fresh watches, 50 live
 * within 1.2s, one at 13.9s and one at 22.5s, every dir at the same instant, which is
 * the one shared stream stalling and recovering rather than a dead watcher. The old
 * 15s refused both, and refusing is what blocked pushes, so the bound is well over
 * twice the slowest start seen.
 */
export const TRIPWIRE_FENCE_TIMEOUT_MS = 60_000;
const FENCE_TIMEOUT_MS = TRIPWIRE_FENCE_TIMEOUT_MS;
const PROBE_RETOUCH_MS = 50;

/**
 * The words each arm uses when its watch could not start, and the heading of a
 * watch that broke mid run. One spelling, here, so the recogniser below cannot drift
 * from what the runner and the vitest arm actually print (L41).
 */
export const TRIPWIRE_COULD_NOT_START = "tree write tripwire could not start";
const WATCH_FAILED_HEADER = "=== TREE WATCH FAILED";

/**
 * Whether a run's output says it could not watch the tree, so it measured nothing
 * either way. A run that caught a write, or ran clean, is a measurement and is not.
 * The end to end tests use this to re-run an unmeasured run rather than read the
 * machine's file watching as the behaviour under test (L411).
 */
export function reportsWatchUnavailable(output: string): boolean {
  return output.includes(TRIPWIRE_COULD_NOT_START) || output.includes(WATCH_FAILED_HEADER);
}

/**
 * Every file under the watched dirs as `size:mtimeMs:ino`, every directory below them
 * as `mtimeMs:ino`, and any dir it could not read. Files are what the comparison
 * reports; directories are only ever used to judge whether a path the WATCH named was
 * touched during the run, since a dir's mtime moves whenever an entry in it does.
 */
interface TreeSnapshot {
  files: Map<string, string>;
  dirs: Map<string, string>;
  unreadable: string[];
}

/** Lists one directory's entries; the seam the snapshot reads through. */
export type ReadDir = (path: string) => Dirent[];
const realReadDir: ReadDir = (path) => readdirSync(path, { withFileTypes: true });

/**
 * Read every file under the watched dirs. Never throws, and tells two failures apart
 * (L11). A NESTED dir gone between its parent's listing and its own read is absent,
 * exactly as a file gone before its stat is: whatever was in it is reported as
 * removed, which is what happened. Any other failure, and a watched dir itself
 * missing, is listed as unreadable rather than treated as empty, because an empty
 * read on one side would report every file in it as removed or as new (L50).
 */
function snapshotTree(root: string, readDir: ReadDir): TreeSnapshot {
  const files = new Map<string, string>();
  const dirs = new Map<string, string>();
  const unreadable: string[] = [];
  const walk = (abs: string, rel: string, top: boolean) => {
    let entries: Dirent[];
    try {
      entries = readDir(abs);
    } catch (err) {
      const gone = (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
      if (gone && !top) return;
      unreadable.push(`${rel}/ (${reason(err)})`);
      return;
    }
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      const childAbs = join(abs, e.name);
      if (e.isDirectory()) {
        try {
          const s = lstatSync(childAbs);
          dirs.set(childRel, `${s.mtimeMs}:${s.ino}`);
        } catch {
          // Removed between the listing and the stat: absent, and the walk below says so.
        }
        walk(childAbs, childRel, false);
        continue;
      }
      if (isAllowedTreeWrite(childRel)) continue;
      try {
        const s = lstatSync(childAbs);
        files.set(childRel, `${s.size}:${s.mtimeMs}:${s.ino}`);
      } catch {
        // Removed between the listing and the stat: absent.
      }
    }
  };
  for (const dir of TRIPWIRE_WATCHED_DIRS) walk(join(root, dir), dir, true);
  return { files, dirs, unreadable };
}

/**
 * Whether a path the watch named is IDENTICAL at both ends of the run, so its event
 * was a late delivery of something done before the run began rather than a write in
 * it (#3524). A write always moves the file's mtime, and an entry made or removed in
 * a dir moves the dir's, so an identical signature at both ends means nothing touched
 * it during the run. A path absent from either end (a file made and removed again
 * inside the run, the #2712 hazard) is never judged stale, so it stays a write.
 */
function unchangedThroughout(path: string, before: TreeSnapshot, after: TreeSnapshot): boolean {
  for (const key of ["files", "dirs"] as const) {
    const b = before[key].get(path);
    if (b !== undefined) return after[key].get(path) === b;
  }
  return false;
}

/**
 * Who to name beside a write the watch saw: the suites running when the event
 * arrived, and those that ended within `graceMs` of it, since an event lands a little
 * after its write. Suspects for a person to read, never a verdict.
 *
 * An event that arrives after EVERY suite has ended and outside the grace names the
 * suite that ended last, and says how long before the event it ended (#3524). It used
 * to say "none", which claims nothing ran when the honest answer is that the event
 * was late: measured 2026-10-12 at load 15 to 20, three in twenty events for a
 * one-suite run arrived past the 2s grace. The grace is not widened instead, because
 * at the gate's concurrency every extra second names several more unrelated suites.
 */
export function nameSuspects(
  now: number,
  running: ReadonlySet<string>,
  endedAt: ReadonlyMap<string, number>,
  graceMs: number,
): string[] {
  const recent = [...endedAt].filter(([, t]) => now - t <= graceMs).map(([f]) => f);
  const named = [...new Set([...running, ...recent])];
  if (named.length > 0) return named;
  let last: [string, number] | null = null;
  for (const entry of endedAt) if (last === null || entry[1] > last[1]) last = entry;
  if (last === null) return [];
  const lateBy = ((now - last[1]) / 1000).toFixed(1);
  return [`none; it arrived ${lateBy}s after the last suite ended, which was ${last[0]}`];
}

/**
 * Whether a path is an event about a watched dir ITSELF. libuv names an event on the
 * watched path by its basename, so `src/` reports its own creation, or a change to
 * its entries, as "src", which reads as a file src/src. It identifies no written file:
 * a write inside the dir is reported under its own path, and a dir removed or replaced
 * breaks the end fence. Only when no such entry exists at either end, so a real
 * src/src is still judged; a src/src made and removed inside the run is the one thing
 * this cannot tell apart (#3524).
 */
function isWatchedDirSelfEvent(path: string, before: TreeSnapshot, after: TreeSnapshot): boolean {
  if (!TRIPWIRE_WATCHED_DIRS.some((d) => path === `${d}/${d}`)) return false;
  return ![before, after].some((s) => s.files.has(path) || s.dirs.has(path));
}

/** The paths that differ between two snapshots: new, changed or removed, sorted. */
function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [p, sig] of after) if (before.get(p) !== sig) changed.add(p);
  for (const p of before.keys()) if (!after.has(p)) changed.add(p);
  return [...changed].sort();
}

/** Seams for the tripwire's own failure paths; production passes none. */
export interface TreeWatchDeps {
  watch?: typeof watch;
  writeProbe?: (path: string, data: string) => void;
  /** How the before and after comparison lists a directory. */
  readDir?: ReadDir;
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
  const readDir = deps.readDir ?? realReadDir;
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
  // The comparison's baseline is taken at the same moment, so the two records start
  // together (#3524).
  const before = snapshotTree(root, readDir);

  return {
    watch: {
      async stop() {
        const endFailures = await fence();
        closeAll();
        const after = snapshotTree(root, readDir);
        const unread = [...new Set([...before.unreadable, ...after.unreadable])].map(
          (d) => `the before and after comparison could not read ${d}, so it checked nothing there`,
        );
        // A late event for something done before the run is dropped; everything the
        // watch named that the comparison cannot clear stays (#3524).
        const found = writes.filter(
          (w) => !unchangedThroughout(w.path, before, after) && !isWatchedDirSelfEvent(w.path, before, after),
        );
        const reported = new Set(found.map((w) => w.path));
        for (const path of changedPaths(before.files, after.files)) {
          if (!reported.has(path)) found.push({ path, suspects: [], missedByWatch: true });
        }
        return { writes: found, watchFailures: [...watchFailures, ...endFailures, ...unread] };
      },
    },
  };
}
