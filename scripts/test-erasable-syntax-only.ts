// TypeScript the shipping loader cannot run is refused at typecheck (#4362, L823).
// Run: node --experimental-strip-types scripts/test-erasable-syntax-only.ts
//
// Every script in `scripts/` (the deploy, canary, verify and alerting commands) and
// every `src/lib` module those scripts import is RUN by Node stripping types
// (`node --experimental-strip-types`). Strip mode only deletes type annotations: an
// `enum`, a `namespace` with values, a constructor parameter property
// (`constructor(private x)`) or `import x = require()` throws
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX on load. The same file passes `tsc`, `next build`
// and Vitest, which all compile it fully, so a module tested only under Vitest can go
// green and still kill the script that imports it before its first line runs.
//
// `erasableSyntaxOnly` makes the compiler refuse exactly that syntax (TS1294). It is
// set once, in `tsconfig.json`, so the app typecheck the push gate and CI run covers
// `src/`, and the scripts and worker configs inherit it. The scripts tree is not
// demanded clean, so `TS1294` is one of the codes its guard fails on
// (`scripts/lib/scan-scripts-typecheck.ts`).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { BREAKING_CODES, breakingErrors } from "./lib/scan-scripts-typecheck.ts";
import { assert, finish } from "./lib/harness.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Syntax strip mode cannot run: an enum and a constructor parameter property, the
// second being the shape the tree actually held when this was added.
const NOT_ERASABLE = "export enum Planted { A }\nexport class Held { constructor(private readonly x: number) {} }\n";

const dir = mkdtempSync(join(tmpdir(), "slate-erasable-"));
try {
  const control = join(dir, "not-erasable.ts");
  writeFileSync(control, NOT_ERASABLE);

  // --- the premise, measured: the shipping loader refuses this file ----------------
  // If Node ever runs it, the setting below guards nothing and this says so (L460).
  let loaderError = "";
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", control], { stdio: "pipe" });
  } catch (err) {
    loaderError = String((err as { stderr?: Buffer }).stderr ?? err);
  }
  assert(
    loaderError.includes("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"),
    loaderError.includes("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX")
      ? "node --experimental-strip-types refuses an enum on load, so the scripts loader cannot run it"
      : `node ran the non erasable file (or failed another way: ${loaderError.slice(0, 200) || "no error"}), so the premise of this guard no longer holds`,
  );

  // --- each config, as TypeScript parses it from its real location ----------------
  for (const name of ["tsconfig.json", "tsconfig.scripts.json", "tsconfig.worker.json"]) {
    const configPath = resolve(repoRoot, name);
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    assert(!read.error, `${name} parses`);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot, undefined, configPath);
    assert(
      parsed.options.erasableSyntaxOnly === true,
      `${name} sets erasableSyntaxOnly (got ${String(parsed.options.erasableSyntaxOnly)}), so syntax Node cannot strip is refused at typecheck`,
    );

    // The control, compiled under this config's own options: it must come back as
    // TS1294, or the option above is set and still not doing anything (L1).
    const program = ts.createProgram({
      rootNames: [control],
      options: { ...parsed.options, noEmit: true, incremental: false },
    });
    const codes = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file && resolve(d.file.fileName) === resolve(control))
      .map((d) => `TS${d.code}`);
    const refused = codes.filter((c) => c === "TS1294").length;
    assert(
      refused === 2,
      `${name} refuses both the enum and the parameter property as TS1294 (got ${codes.join(", ") || "nothing"})`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// --- the scripts tree guard fails on it ----------------------------------------------
// That guard fails only on the codes it lists, so without TS1294 there an enum in
// `scripts/` would be reported and still pass.
{
  const fixture = "scripts/foo.ts(3,13): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.";
  const found = breakingErrors(fixture, () => []);
  assert(
    found.length === 1 && found[0].code === "TS1294",
    `the scripts typecheck guard fails on TS1294 (watching ${BREAKING_CODES.join(", ")})`,
  );
}

finish();
