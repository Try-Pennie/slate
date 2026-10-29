/**
 * The coordinator page's live transfer offer against its settled design (#4380, claude-config#1364).
 *
 * Built the way the coordinator booking score is (62-coordinator-booking-design.spec.ts): the
 * seeded scheduling coordinator signs in, and the shared web adapter (scripts/design-score) draws
 * each frame of docs/design/coordinator-call-me-now.html beside the page drawing the same fixtures
 * (`?frame=`, the offer over the booking design's "Sam found", honoured only under
 * SLATE_DESIGN_FIXTURES on this machine, and only for somebody who may use the desk), in one
 * browser, and scores them. The adapter's exit code is the verdict: 0 matched, 1 a difference, 2
 * no score.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, signIn, seed } from "../fixtures.ts";
import { E2E_APP_ORIGIN } from "../env.ts";

// The runner starts Playwright from the repository root (e2e/run.ts).
const ROOT = process.cwd();
const OUT = join(ROOT, "e2e", ".artifacts", "design-score", "coordinator-call-me-now");
// The page's title, which arrives with the page's content (#3947).
const CONTENT_READY = "main h1";

// The sign in browser and the adapter's are the same kind: Playwright's own in CI, Chrome on a Mac,
// which may not have Playwright's installed.
test.use(process.env.CI ? {} : { channel: "chrome" });

test("The coordinator page live transfer offer matches its settled design on both halves", async ({ page }, info) => {
  test.setTimeout(420_000);
  expect(existsSync(join(ROOT, "docs/design/coordinator-call-me-now.html")), `the settled design is not under ${ROOT}`).toBe(true);
  const landed = await signIn(page, seed.users.coordinator.email);
  // The coordinator lands on their one page, which is the positive control that the seeded role
  // signs in at all.
  expect(landed.pathname).toBe("/coordinator");
  const dir = mkdtempSync(join(tmpdir(), "cmn-design-score-"));
  const state = join(dir, "state.json");
  await page.context().storageState({ path: state });
  mkdirSync(OUT, { recursive: true });

  const run = spawnSync(
    process.execPath,
    [
      "scripts/design-score/capture-web.mjs",
      "--design",
      "docs/design/coordinator-call-me-now.html",
      "--build",
      `${E2E_APP_ORIGIN}/coordinator`,
      "--out",
      OUT,
      "--fixture",
      "docs/design/fixtures/coordinator-call-me-now.json",
      "--storage",
      state,
      "--ready",
      CONTENT_READY,
      "--repo",
      ROOT,
      // CI has Playwright's own browser and no Chrome; a Mac has Chrome and may not have the other.
      "--channel",
      process.env.CI ? "bundled" : "chrome",
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 400_000 },
  );
  const report = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  writeFileSync(join(dir, "report.txt"), report);
  await info.attach("design score report", { path: join(dir, "report.txt"), contentType: "text/plain" });
  // On a difference, both pictures of every frame and the score's own diff pictures go with the
  // report, so a run on another machine shows what differed rather than only that something did.
  if (run.status !== 0) {
    for (const name of existsSync(OUT) ? readdirSync(OUT).filter((n) => n.endsWith(".png")) : []) {
      await info.attach(name, { path: join(OUT, name), contentType: "image/png" });
    }
  }
  expect(run.error, report).toBeUndefined();
  expect(run.status, report).toBe(0);
});
