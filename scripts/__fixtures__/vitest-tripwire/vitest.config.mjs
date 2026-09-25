// Fixture config for the vitest arm of the tree write tripwire (#2759). It runs
// the REAL global setup Slate's own vitest.config.ts declares over one fixture
// test, so scripts/test-vitest-tree-tripwire.ts can plant a write and watch the
// real arm catch it.
//
// The suite COPIES this directory into a temp directory and runs vitest there,
// never here: vitest writes its own results cache (node_modules/.vite) and a
// bundled config beside the root it runs in, and a root under scripts/ would be a
// write into the very tree the outer run's tripwire is watching. That is also why
// nothing here imports vitest (a temp directory has no node_modules to resolve it
// from): the config is a plain object, and the test uses vitest's globals.
const here = new URL(".", import.meta.url).pathname;

const config = {
  test: {
    root: here,
    environment: "node",
    pool: "forks",
    globals: true,
    include: ["*.test.mjs"],
    globalSetup: [process.env.TRIPWIRE_FIXTURE_GLOBAL_SETUP],
  },
};

export default config;
