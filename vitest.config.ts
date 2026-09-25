import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest is the home for anything that imports from `@/` and needs module mocks:
// React components, route handlers, and lib code with injected fakes. The
// node-native scripts/test-*.ts suites stay the home for pure logic and
// repo-invariant guards. See AGENTS.md ("Where a new test goes").
//
// The default environment is `node` (#608). jsdom costs roughly a second per
// file, and only the ~20 component tests need a DOM, so a file that needs one
// opts in with a `@vitest-environment jsdom` docblock. scripts/test-vitest-
// environment.ts guards that boundary. esbuild handles the automatic JSX runtime.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // #1595: MEASURED, and left on forks. Worker threads were the experiment and
    // they are not a win on the two core runner. Five attempts of the vitest job
    // on one commit, so the runner was the only variable, came back 142s, 154s,
    // 148s, 146s and 147s (median 147s), against a forks baseline of 15 runs at
    // min 121s, median 150s, max 158s. Threads' own minimum (142s) is worse than
    // forks' (121s). All five passed, so the pool is safe, it simply buys
    // nothing: locally, with cores to spare, threads did win (8.2s against
    // 10.4s), because process start-up is what parallelises away there. On two
    // cores the run is bound by the test bodies and by jsdom setup, and a thread
    // does neither of those more cheaply.
    //
    // Named explicitly rather than left to the default, so changing it is a
    // decision somebody made and not a default drifting under us.
    //
    // `isolate` stays ON, and is deliberately absent so the default holds: each
    // file gets a fresh module registry, which is what makes the module mocks
    // these suites are built on independent. Turning it off is the one speed-up
    // #1595 rules out, and scripts/test-vitest-environment.ts fails the build if
    // it appears: every file here mocks modules, so a leaked registry makes one
    // file's mocks answer for another's, and the failures look like flakes rather
    // than like a configuration choice.
    pool: "forks",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    // The runtime tree write tripwire's vitest arm (#2759): watches scripts/, src/
    // and worker/ for the length of the run, armed only in CI and the pre-push
    // gate. The rules are in scripts/lib/tree-write-tripwire.ts, and
    // scripts/test-vitest-tree-tripwire.ts fails if this line goes.
    globalSetup: ["./scripts/vitest-tree-tripwire.ts"],
  },
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
