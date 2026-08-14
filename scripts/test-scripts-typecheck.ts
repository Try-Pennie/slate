// The scripts tree is typechecked for the classes that break at RUNTIME (#1504).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-scripts-typecheck.ts
//
// `tsconfig.json` excludes `scripts`, so `pnpm build` and `npx tsc --noEmit`
// never look at ~280 node test suites or at the canary scripts that run against
// live prod every 30 minutes. Two things came out of that:
//
//   - `failureLogPath` was an undefined identifier in `scripts/smoke-booking-api.ts`
//     and tsc reported clean; it surfaced only when the script was run.
//   - in `scripts/test-reconcile-missing-busy-blocks.ts`, an undefined `calls`
//     inside a fake threw BEFORE the fake recorded anything, so the test guarding
//     "a block-lookup read error aborts with ZERO inserts" passed on its own
//     fixture's typo. Had the sweep ever regressed into mass-inserting busy
//     blocks, that test would still have reported success (L140, L1).
//
// The tree carries ~100 errors, almost all nullable and shape mismatches in test
// fakes, so this does NOT demand a clean typecheck. It fails on the two classes
// that ship broken and says which ones it is watching, so widening it later is a
// deliberate act rather than a silent no-op.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  BREAKING_CODES,
  breakingErrors,
  hasOptOut,
  parseTscErrors,
} from "./lib/scan-scripts-typecheck.ts";
import { assert, finish } from "./lib/harness.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const CONFIG = "tsconfig.scripts.json";

/** Run tsc over the scripts tree and return its stdout (errors go to stdout). */
function runTsc(): string {
  try {
    execFileSync("npx", ["tsc", "-p", CONFIG, "--noEmit"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "";
  } catch (err) {
    // A non-zero exit is expected: the tree has ~100 non-breaking errors.
    const e = err as { stdout?: string; stderr?: string; code?: string };
    // A missing `npx`/tsc must NOT read as "no errors found" (L98): finding
    // nothing to check is not a pass.
    if (e.code === "ENOENT") {
      throw new Error("could not run tsc (npx not found), so nothing was checked");
    }
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

const readSource = (file: string): string[] => {
  try {
    return readFileSync(join(repoRoot, file), "utf8").split("\n");
  } catch {
    return [];
  }
};

// --- the parse and the opt-out, on fixture lines -------------------------------
{
  const fixture = [
    "scripts/foo.ts(12,7): error TS2304: Cannot find name 'calls'.",
    "scripts/bar.ts(3,1): error TS2339: Property 'x' does not exist on type 'Y'.",
    "Found 2 errors in 2 files.",
  ].join("\n");
  const parsed = parseTscErrors(fixture);
  assert(parsed.length === 2, `both error lines parse (got ${parsed.length})`);
  assert(parsed[0].code === "TS2304" && parsed[0].line === 12, "code and line are read off the line");
  assert(
    breakingErrors(fixture, () => []).map((e) => e.code).join(",") === "TS2304",
    "only the runtime-breaking class fails the build; the shape mismatch does not",
  );

  // The opt-out, in both positions, and never on a bare marker with no reason.
  assert(
    hasOptOut(["const x = y; // typecheck-ok: generated at build time"], 1),
    "the opt-out is honoured on the line itself",
  );
  assert(
    hasOptOut(["// typecheck-ok: generated at build time", "const x = y;"], 2),
    "and in the comment block directly above",
  );
  assert(
    !hasOptOut(["// typecheck-ok:", "const x = y;"], 2),
    "a marker with no reason silences nothing",
  );
  assert(
    !hasOptOut(["const a = 1;", "", "const x = y;"], 3),
    "and an unrelated line above does not silence it",
  );
}

// --- the real tree ------------------------------------------------------------
const output = runTsc();
const breaking = breakingErrors(output, readSource);
assert(
  breaking.length === 0,
  breaking.length === 0
    ? `no undefined names or unresolved imports in scripts/ (watching ${BREAKING_CODES.join(", ")})`
    : `these break at runtime and must be fixed (or annotated with "// typecheck-ok: <why>"):\n` +
      breaking.map((e) => `  ${e.file}:${e.line} ${e.code} ${e.message}`).join("\n"),
);

// --- positive control: the gate has been SEEN to fail --------------------------
//
// Everything above is satisfied by a tsc invocation that never looked at
// scripts/ at all: a wrong `include`, a config that failed to load, and a clean
// tree are indistinguishable from an empty error list (L1, L98). So plant a real
// undefined identifier in the tree and require the gate to catch it by name.
//
// The filename does not match `test-*.ts`, so the suite runner cannot pick it up
// if it somehow survives, and it is removed in a `finally`.
{
  const controlName = "typecheck-control.tmp.ts";
  const controlPath = join(repoRoot, "scripts", controlName);
  try {
    writeFileSync(controlPath, "export const planted = thisNameIsNotDefined;\n");
    const caught = breakingErrors(runTsc(), readSource);
    assert(
      caught.some((e) => e.file.includes(controlName) && e.code === "TS2304"),
      `the gate catches a planted undefined name (caught: ${
        caught.map((e) => `${e.file} ${e.code}`).join(", ") || "nothing"
      })`,
    );
  } finally {
    rmSync(controlPath, { force: true });
  }
}

finish();
