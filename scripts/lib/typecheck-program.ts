/**
 * Typecheck a tree under one of the repo's tsconfigs WITH a planted control file
 * that lives OUTSIDE the repo (#2712).
 *
 * Both typecheck guards (`test-scripts-typecheck.ts`, `test-worker-typecheck.ts`)
 * need a positive control: a real undefined name the run must report, because a
 * run that read nothing and a clean tree both produce an empty error list (L1,
 * L98). They used to plant it INSIDE the tree being checked, which meant every
 * other suite walking `scripts/` at the same moment could list the file and then
 * fail to open it (ENOENT on unrelated PRs, and once on main, skipping a deploy).
 *
 * `tsc -p` cannot be told "this config, plus one more file", and a temporary
 * tsconfig that extends the real one is NOT the same program: TypeScript resolves
 * `types` entries and the default `typeRoots` from the CONFIG FILE's directory, so
 * a worker config in a temp dir fails with TS2688, cannot find
 * `@cloudflare/workers-types` (measured 2026-09-25). So this drives the compiler
 * API instead: parse the REAL config from its real location, add the control to
 * its root names, and check. The options are the real config's, and nothing is
 * written anywhere but the temp directory: no control in the tree, and no
 * `.tsbuildinfo` at the repo root either, since a plain program is not incremental.
 *
 * The result carries every file the program READ, so a caller can prove the run
 * covered the whole tree its config names, not merely that it caught the control.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

export interface TypecheckRun {
  /** Diagnostics in `tsc`'s own `file(line,col): error TSxxxx: message` format,
   *  paths relative to the repo root, ready for `parseTscErrors`. */
  output: string;
  /** Absolute paths the config's `include` resolves to on disk. */
  configFiles: string[];
  /** Absolute paths of every source file the program actually read. */
  readFiles: Set<string>;
  /** The control's path as it appears in `output` (relative to the repo root). */
  controlFile: string;
}

/**
 * Plant `controlSource` in a fresh temp directory, typecheck `configName`'s tree
 * plus the control, remove the temp directory, and return what the run saw.
 */
export function typecheckWithControl(
  repoRoot: string,
  configName: string,
  controlSource: string,
): TypecheckRun {
  const configPath = resolve(repoRoot, configName);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(`could not read ${configName}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot, undefined, configPath);

  const dir = mkdtempSync(join(tmpdir(), "slate-typecheck-control-"));
  try {
    const control = join(dir, "typecheck-control.ts");
    writeFileSync(control, controlSource);
    const program = ts.createProgram({
      rootNames: [...parsed.fileNames, control],
      options: { ...parsed.options, noEmit: true },
      projectReferences: parsed.projectReferences,
      configFileParsingDiagnostics: parsed.errors,
    });
    // Config parsing, options, syntax, globals and semantics: what `tsc` reports.
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const host: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => repoRoot,
      getNewLine: () => "\n",
    };
    return {
      output: ts.formatDiagnostics(diagnostics, host),
      configFiles: parsed.fileNames.map((f) => resolve(f)),
      readFiles: new Set(program.getSourceFiles().map((s) => resolve(s.fileName))),
      controlFile: relative(repoRoot, control),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Files the config names that the program never read: must be empty, or the
 *  verdict is about a subset of the tree (L1). Pure, so it is unit tested. */
export function unreadConfigFiles(configFiles: readonly string[], readFiles: ReadonlySet<string>): string[] {
  return configFiles.filter((f) => !readFiles.has(f));
}
