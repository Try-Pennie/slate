/**
 * Coordinator booking against its settled design, every frame (#4264, claude-config#1364).
 *
 * Built the way the Team capacity score is (60-team-capacity-design.spec.ts): the seeded super
 * admin signs in, and the shared web adapter (scripts/design-score) draws each frame of
 * docs/design/coordinator-admin.html beside the page drawing the same fixture (`?frame=`, honoured
 * only under SLATE_DESIGN_FIXTURES on this machine and only for a super admin), in one browser, and
 * scores them. The adapter's exit code is the verdict: 0 matched, 1 a difference, 2 no score.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, signIn, seed } from "../fixtures.ts";
import { E2E_APP_ORIGIN } from "../env.ts";

// The runner starts Playwright from the repository root (e2e/run.ts).
const ROOT = process.cwd();
const OUT = join(ROOT, "e2e", ".artifacts", "design-score", "coordinator-admin");
// The card holding the switch and the list, which arrives with the page's content (#3947).
const CONTENT_READY = "main section h2";

// The sign in browser and the adapter's are the same kind: Playwright's own in CI, Chrome on a Mac,
// which may not have Playwright's installed.
test.use(process.env.CI ? {} : { channel: "chrome" });

test("Coordinator booking matches its settled design on both halves", async ({ page }, info) => {
  test.setTimeout(300_000);
  expect(existsSync(join(ROOT, "docs/design/coordinator-admin.html")), `the settled design is not under ${ROOT}`).toBe(true);
  await signIn(page, seed.users.admin.email);
  const dir = mkdtempSync(join(tmpdir(), "ca-design-score-"));
  const state = join(dir, "state.json");
  await page.context().storageState({ path: state });
  mkdirSync(OUT, { recursive: true });

  const run = spawnSync(
    process.execPath,
    [
      "scripts/design-score/capture-web.mjs",
      "--design",
      "docs/design/coordinator-admin.html",
      "--build",
      `${E2E_APP_ORIGIN}/admin/coordinator-booking`,
      "--out",
      OUT,
      "--fixture",
      "docs/design/fixtures/coordinator-admin.json",
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
