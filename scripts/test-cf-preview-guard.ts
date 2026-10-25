// A local Workers preview refuses a checkout holding live settings (#3694).
//
// `pnpm cf:preview` builds the app and runs it on workerd, where the user agent is
// `Cloudflare-Workers`, so `mayWriteAlerts` (`src/lib/notify/dispatch.ts`) lets
// alerts through as if it were production. The adapter bakes every `.env*` file's
// values into the bundle and wrangler also loads `.dev.vars`, so in a checkout
// holding `.env.local` any alert the preview raised would post to the real Slack
// channel and write production's alert state.
//
// The rule for which files are live settings is ONE rule, shared with the browser
// checks runner (`e2e/env.ts`, #3079), in `scripts/lib/live-env-files.ts`. This
// drives the rule, the real guard script in a child process against temporary
// directories (never this checkout), and the package.json wiring.
//
// Run: node --experimental-strip-types scripts/test-cf-preview-guard.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, eq, finish } from "./lib/harness.ts";
import { cfPreviewRefusal, liveEnvFiles } from "./lib/live-env-files.ts";
import { envFileRefusal } from "../e2e/env.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUARD = join(ROOT, "scripts", "cf-preview-guard.ts");

// --- the one rule --------------------------------------------------------------------

eq(liveEnvFiles([".env.example", "package.json", "README.md"]), [], "the committed template and ordinary files are not live settings");
eq(
  liveEnvFiles([".env", ".env.local", ".env.production", ".env.production.local", ".dev.vars", ".dev.vars.loadtest"]),
  [".env", ".env.local", ".env.production", ".env.production.local", ".dev.vars", ".dev.vars.loadtest"],
  "every .env* and .dev.vars* file is a live setting file",
);
eq(liveEnvFiles(["env.local", "my.env", "dev.vars", ".envrc"]), [], "names that merely resemble one are not");

// Both callers read the same rule: each refuses every file the other does.
for (const f of [".env.local", ".dev.vars", ".dev.vars.production"]) {
  assert(cfPreviewRefusal([f]) !== null, `${f} refuses the local Workers preview`);
  assert(envFileRefusal([f]) !== null, `${f} refuses the browser checks too, by the same rule`);
}
assert(cfPreviewRefusal([".env.example"]) === null, "the committed template does not refuse the preview");
assert(envFileRefusal([".env.example"]) === null, "the committed template does not refuse the browser checks");

const message = cfPreviewRefusal([".env.local", ".dev.vars", "package.json"]) ?? "";
assert(message.includes(".env.local") && message.includes(".dev.vars"), "the refusal names every file it found");
assert(!message.includes("package.json"), "the refusal names only the files that caused it");
assert(/Slack/.test(message) && /production/.test(message), "the refusal says why: a real Slack post and production's state");
assert(/worktree/.test(message), "the refusal says where it can run instead");

// --- the real guard script -------------------------------------------------------------

function runGuardIn(files: string[]): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "slate-cf-preview-guard-"));
  try {
    for (const f of files) writeFileSync(join(dir, f), "PLACEHOLDER=1\n");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", GUARD], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
    });
    return { status: r.status, stderr: `${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const dirty = runGuardIn([".env.local", ".dev.vars", ".env.example", "package.json"]);
eq(dirty.status, 1, "the guard exits 1 in a directory holding .env.local and .dev.vars");
assert(
  dirty.stderr.includes(".env.local") && dirty.stderr.includes(".dev.vars"),
  `the guard prints the files it found (got: ${dirty.stderr.slice(0, 300)})`,
);

const onlyDevVars = runGuardIn([".dev.vars"]);
eq(onlyDevVars.status, 1, "a .dev.vars file alone refuses the preview");

const clean = runGuardIn([".env.example", "package.json"]);
eq(clean.status, 0, `the guard passes a directory with only the committed template (stderr: ${clean.stderr.slice(0, 300)})`);

// --- the wiring ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
const PREVIEW_COMMAND = /opennextjs-cloudflare\s+preview|wrangler\s+dev\b/;
const previewScripts = Object.entries(pkg.scripts).filter(([, cmd]) => PREVIEW_COMMAND.test(cmd));
assert(previewScripts.some(([name]) => name === "cf:preview"), "the scan sees cf:preview as a local Workers preview");
for (const [name, cmd] of previewScripts) {
  const guardAt = cmd.indexOf("scripts/cf-preview-guard.ts");
  const buildAt = cmd.search(/opennextjs-cloudflare\s+build|next\s+build/);
  const previewAt = cmd.search(PREVIEW_COMMAND);
  assert(guardAt !== -1, `package.json script "${name}" runs the live settings guard`);
  assert(
    guardAt !== -1 && guardAt < previewAt && (buildAt === -1 || guardAt < buildAt),
    `package.json script "${name}" runs the guard before it builds or starts anything`,
  );
  assert(!/;|\|\|/.test(cmd.slice(guardAt, previewAt)), `package.json script "${name}" stops when the guard refuses (joined with &&)`);
}

finish();
