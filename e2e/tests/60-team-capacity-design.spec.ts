/**
 * Team capacity against its settled design, every frame (#3936, #3954, claude-config#1364).
 *
 * The milestone is done when the design match score reads 100% on both halves: every decision the
 * design's map verifies by a check met (docs/design/team-capacity.checks.js) and every frame's
 * picture matching. This signs the seeded admin in and hands that session to the shared web adapter
 * (scripts/design-score, copied from claude-config and checked against it), which draws each frame
 * of the design beside the page drawing the same fixture (`?frame=`, honoured only under
 * SLATE_DESIGN_FIXTURES on this machine), in one browser, and scores them. Both sides are drawn by
 * the same browser, so the score is the same on any machine.
 *
 * The adapter's exit code is the verdict: 0 matched, 1 a difference (the report names the frame and
 * the decision), 2 no score at all. Anything but 0 fails, with the report attached. The capture and
 * its score.json stay in e2e/.artifacts/design-score, where CI keeps them for posting.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, signIn, seed } from "../fixtures.ts";
import { E2E_APP_ORIGIN } from "../env.ts";

// The runner starts Playwright from the repository root (e2e/run.ts).
const ROOT = process.cwd();
const OUT = join(ROOT, "e2e", ".artifacts", "design-score", "team-capacity");
// What the page shows once its content is on screen, inside its main area: a streamed page fires
// load before its content arrives on a slow machine, and CI once pictured the loading placeholder
// in its place (#3947).
const CONTENT_READY = "main [data-tc]";

// The sign in browser and the adapter's are the same kind: Playwright's own in CI, Chrome on a Mac,
// which may not have Playwright's installed.
test.use(process.env.CI ? {} : { channel: "chrome" });

test("Team capacity matches its settled design on both halves", async ({ page }, info) => {
  test.setTimeout(300_000);
  expect(existsSync(join(ROOT, "docs/design/team-capacity.html")), `the settled design is not under ${ROOT}`).toBe(true);
  await signIn(page, seed.users.admin.email);
  const dir = mkdtempSync(join(tmpdir(), "tc-design-score-"));
  const state = join(dir, "state.json");
  await page.context().storageState({ path: state });
  mkdirSync(OUT, { recursive: true });

  const run = spawnSync(
    process.execPath,
    [
      "scripts/design-score/capture-web.mjs",
      "--design",
      "docs/design/team-capacity.html",
      "--build",
      `${E2E_APP_ORIGIN}/admin/team-capacity`,
      "--out",
      OUT,
      "--fixture",
      "docs/design/fixtures/team-capacity.json",
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
    { cwd: ROOT, encoding: "utf8", timeout: 280_000 },
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
