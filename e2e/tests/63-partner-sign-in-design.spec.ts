/**
 * The partner sign in page against its settled design (#4379, claude-config#1364).
 *
 * Built the way the coordinator booking page's score is (62-coordinator-booking-design.spec.ts),
 * signed out, since this is a sign in page: the shared web adapter (scripts/design-score) draws
 * the one frame of docs/design/partner-sign-in.html beside the page (`?frame=f1`, honoured only
 * under SLATE_DESIGN_FIXTURES on this machine), in one browser, and scores them. The adapter's
 * exit code is the verdict: 0 matched, 1 a difference, 2 no score.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../fixtures.ts";
import { E2E_APP_ORIGIN } from "../env.ts";

// The runner starts Playwright from the repository root (e2e/run.ts).
const ROOT = process.cwd();
const OUT = join(ROOT, "e2e", ".artifacts", "design-score", "partner-sign-in");
// The card's heading, which arrives with the page's content (#3947).
const CONTENT_READY = "main h1";

test("The partner sign in page matches its settled design on both halves", async ({}, info) => {
  test.setTimeout(240_000);
  expect(existsSync(join(ROOT, "docs/design/partner-sign-in.html")), `the settled design is not under ${ROOT}`).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "psi-design-score-"));
  mkdirSync(OUT, { recursive: true });

  const run = spawnSync(
    process.execPath,
    [
      "scripts/design-score/capture-web.mjs",
      "--design",
      "docs/design/partner-sign-in.html",
      "--build",
      `${E2E_APP_ORIGIN}/partner/sign-in`,
      "--out",
      OUT,
      "--fixture",
      "docs/design/fixtures/partner-sign-in.json",
      "--ready",
      CONTENT_READY,
      "--repo",
      ROOT,
      // CI has Playwright's own browser and no Chrome; a Mac has Chrome and may not have the other.
      "--channel",
      process.env.CI ? "bundled" : "chrome",
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 220_000 },
  );
  const report = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  writeFileSync(join(dir, "report.txt"), report);
  await info.attach("design score report", { path: join(dir, "report.txt"), contentType: "text/plain" });
  if (run.status !== 0) {
    for (const name of existsSync(OUT) ? readdirSync(OUT).filter((n) => n.endsWith(".png")) : []) {
      await info.attach(name, { path: join(OUT, name), contentType: "image/png" });
    }
  }
  expect(run.error, report).toBeUndefined();
  expect(run.status, report).toBe(0);
});
