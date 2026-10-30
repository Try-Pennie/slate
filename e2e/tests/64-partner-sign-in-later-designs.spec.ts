/**
 * The partner sign in page against the designs settled after its first one: the photograph
 * panel's words (#4399, docs/design/partner-sign-in-panel.html) and the staff link below the
 * Microsoft button (#4411, docs/design/partner-sign-in-staff-link.html).
 *
 * Built the way the page's first score is (63-partner-sign-in-design.spec.ts), signed out: the
 * shared web adapter (scripts/design-score) draws each design's one frame beside the page
 * (`?frame=f1`, honoured only under SLATE_DESIGN_FIXTURES on this machine), in one browser, and
 * scores them. Each design's frame is the whole partner sign in page, captured live on
 * 2026-10-29, with only its own part drawn in. The adapter's exit code is the verdict: 0
 * matched, 1 a difference, 2 no score.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../fixtures.ts";
import { E2E_APP_ORIGIN } from "../env.ts";

// The runner starts Playwright from the repository root (e2e/run.ts).
const ROOT = process.cwd();
// The card's heading, which arrives with the page's content (#3947).
const CONTENT_READY = "main h1";

const DESIGNS = [
  { name: "partner-sign-in-panel", what: "photograph panel" },
  { name: "partner-sign-in-staff-link", what: "staff link" },
] as const;

for (const design of DESIGNS) {
  test(`The partner sign in page's ${design.what} matches its settled design on both halves`, async ({}, info) => {
    test.setTimeout(240_000);
    const file = `docs/design/${design.name}.html`;
    expect(existsSync(join(ROOT, file)), `the settled design is not under ${ROOT}`).toBe(true);
    const out = join(ROOT, "e2e", ".artifacts", "design-score", design.name);
    const dir = mkdtempSync(join(tmpdir(), `${design.name}-design-score-`));
    mkdirSync(out, { recursive: true });

    const run = spawnSync(
      process.execPath,
      [
        "scripts/design-score/capture-web.mjs",
        "--design",
        file,
        "--build",
        `${E2E_APP_ORIGIN}/partner/sign-in`,
        "--out",
        out,
        "--fixture",
        `docs/design/fixtures/${design.name}.json`,
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
      for (const name of existsSync(out) ? readdirSync(out).filter((n) => n.endsWith(".png")) : []) {
        await info.attach(name, { path: join(out, name), contentType: "image/png" });
      }
    }
    expect(run.error, report).toBeUndefined();
    expect(run.status, report).toBe(0);
  });
}
