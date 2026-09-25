// The vitest arm of the runtime tree write tripwire (#2759).
//
// #2733 watched scripts/, src/ and worker/ around the node suites only. `pnpm test`
// runs vitest AFTER the node runner has exited, so a vitest file (or a process one
// starts) writing into the tree went unwatched, and the concurrent walkers #2712 is
// about are just as present in vitest: its workers collect and import from src/.
//
// This is a vitest global setup, declared in vitest.config.ts, so it runs once in
// vitest's main process around every way vitest is started here: `pnpm
// test:components`, a CI shard, `pnpm test:coverage`, a bare `npx vitest run`. It
// is the SAME library the node runner uses (scripts/lib/tree-write-tripwire.ts),
// armed by the same rule: on in GitHub Actions and in the pre-push gate's isolated
// checkout, off in a developer's own run, and it says which on its first line so an
// unwatched pass never reads as a watched one (L98).
//
// A finding fails the run by throwing from the teardown: vitest 3 reports a
// teardown error and exits 1 (measured, and pinned by
// scripts/test-vitest-tree-tripwire.ts, which plants a write and requires the exit).
// vitest prints that under a "Startup Error" banner, which is its label for any
// global setup error rather than a statement about when it happened, so the
// findings are printed in full above it and the thrown message says where they are.
import {
  formatTripwireFindings,
  resolveTripwireMode,
  startTreeWatch,
  tripwireFailed,
  tripwireWatchRoot,
} from "./lib/tree-write-tripwire.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The global setup is told nothing about which file a worker is running, so the
// suspect list says that rather than reading "none", which would claim a
// measurement nobody took (L11).
const suspects = () => ["a vitest file; this arm cannot tell which"];

export default async function setup(): Promise<void | (() => Promise<void>)> {
  const mode = resolveTripwireMode(process.env);
  if (mode.kind === "refused") {
    throw new Error(`tree write tripwire: ${mode.why}. Nothing was run.`);
  }
  if (mode.kind === "off") {
    console.log(`tree write tripwire OFF: ${mode.why}.`);
    return;
  }
  const started = await startTreeWatch(tripwireWatchRoot(process.env, repoRoot), suspects);
  if ("error" in started) {
    throw new Error(`tree write tripwire could not start: ${started.error}. Nothing was run.`);
  }
  console.log(`tree write tripwire ON (${mode.why}): any write into scripts/, src/ or worker/ fails this vitest run.`);

  return async () => {
    const result = await started.watch.stop();
    if (!tripwireFailed(result)) return;
    console.error("\n" + formatTripwireFindings(result).join("\n"));
    throw new Error(
      "the tree write tripwire failed this vitest run; the findings are printed above. " +
        "The tests themselves may all have passed.",
    );
  };
}
