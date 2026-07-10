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
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
