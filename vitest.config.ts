import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Component tests for the React surfaces that carry real client logic (the
// node-native scripts/test-*.ts suites stay the home for pure/orchestration
// logic). jsdom + Testing Library; esbuild handles the automatic JSX runtime.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
