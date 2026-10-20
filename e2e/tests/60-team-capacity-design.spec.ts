/**
 * Team capacity against its settled design, every frame (#3936, claude-config#1364).
 *
 * The milestone is done when the match score reads 100% on both halves: every on screen decision
 * met (docs/design/team-capacity.checks.js) and every frame's picture matching. This signs the
 * seeded admin in, hands that session to the scorer, and lets it render each frame of the design
 * beside the page drawing the same fixture (`?frame=`, honoured only under SLATE_DESIGN_FIXTURES on
 * this machine). Both sides are drawn by the same browser, so the score is the same on any machine.
 *
 * The scorer's exit code is the verdict: 0 matched, 1 a difference (the report names the frame and
 * the decision), 2 no score at all. Anything but 0 fails, with the report attached.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, signIn, seed } from "../fixtures.ts";
import { E2E_APP_ORIGIN } from "../env.ts";

// The runner starts Playwright from the repository root (e2e/run.ts).
const ROOT = process.cwd();

// The sign in browser and the scorer's are the same kind: Playwright's own in CI, Chrome on a Mac,
// which may not have Playwright's installed.
test.use(process.env.CI ? {} : { channel: "chrome" });

test("Team capacity matches its settled design on both halves", async ({ page }, info) => {
  test.setTimeout(300_000);
  expect(existsSync(join(ROOT, "docs/design/team-capacity.html")), `the settled design is not under ${ROOT}`).toBe(true);
  await signIn(page, seed.users.admin.email);
  const dir = mkdtempSync(join(tmpdir(), "tc-design-match-"));
  const state = join(dir, "state.json");
  await page.context().storageState({ path: state });

  const run = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      "./scripts/register-paths.mjs",
      "scripts/design-match/score.ts",
      "--design",
      "docs/design/team-capacity.html",
      "--build",
      `${E2E_APP_ORIGIN}/admin/team-capacity`,
      "--storage",
      state,
      // CI has Playwright's own browser and no Chrome; a Mac has Chrome and may not have the other.
      "--channel",
      process.env.CI ? "bundled" : "chrome",
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 280_000 },
  );
  const report = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  writeFileSync(join(dir, "report.txt"), report);
  await info.attach("design-match report", { path: join(dir, "report.txt"), contentType: "text/plain" });
  // On a difference, both pictures of every frame go with the report, so a run on another machine
  // shows what differed rather than only that something did.
  if (run.status !== 0) {
    const pics = join(ROOT, ".design-match", "team-capacity");
    for (const name of existsSync(pics) ? readdirSync(pics).filter((n) => n.endsWith(".png")) : []) {
      await info.attach(name, { path: join(pics, name), contentType: "image/png" });
    }
  }
  expect(run.error, report).toBeUndefined();
  expect(report, report).toContain("MATCHED: both halves are 100%");
  expect(run.status, report).toBe(0);
});
