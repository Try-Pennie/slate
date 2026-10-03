import { defineConfig, devices } from "@playwright/test";
import { E2E_APP_ORIGIN } from "./env.ts";

/**
 * Run through `pnpm test:e2e` (`e2e/run.ts`), which owns the stack, the build and
 * the server; this file only describes the browser half. Running `playwright test`
 * directly finds no server and no `E2E_STACK`, and every spec says so.
 *
 * One worker, in file order: the specs share one database and several of them
 * change org wide settings (the kill switch, the horizon), so running them side
 * by side would make each one's assertions depend on another's timing.
 */
export default defineConfig({
  testDir: "./tests",
  outputDir: "./.artifacts/results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "./.artifacts/report", open: "never" }]]
    : [["list"]],
  use: {
    baseURL: E2E_APP_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The entrance and pulse keyframes never settle (AGENTS.md, screenshotting);
    // the fixtures also inject a style that stops them outright.
    reducedMotion: "reduce",
    timezoneId: "America/New_York",
    locale: "en-US",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
