/**
 * Pure scan behind `scripts/test-no-tree-writes.ts` (#2712): find every place a
 * test suite writes to the filesystem somewhere it has not PROVEN is a temp
 * directory.
 *
 * Why it exists: `pnpm test` runs its suites concurrently, and many of them walk
 * `scripts/` or `src/` reading every file. A suite that writes a file into that
 * tree and deletes it afterwards hands every concurrent walker a file it can list
 * and then fail to open. That is #2712: the typecheck guard planted its control
 * in `scripts/`, and an unrelated scanner died on ENOENT, on PRs and once on
 * main, where it skipped a deploy. Moving that one control fixes the instance;
 * this fixes the class (L30, L433).
 *
 * The rule is PROVE SAFE, not detect unsafe. A write is fine only when the path
 * it writes is ROOTED in a temp directory, followed through the variables it was
 * built from. Rooted means the temp call is the BASE of the path, never merely
 * somewhere inside it: the whole expression, the FIRST argument of `path.join`,
 * the last anchoring argument of `path.resolve` (everything after it a relative
 * literal), or the head of a template or `+` concatenation. So
 * `join(repoRoot, "scripts", basename(mkdtempSync(...)))` and
 * `join(repoRoot, tmpdir())` are refused: each names a temp directory and writes
 * into the repo. The temp calls are `tmpdir()` and a `mkdtemp`/`mkdtempSync`
 * whose own PREFIX is rooted in a temp directory (`mkdtempSync("scripts/x-")`
 * creates its directory in the tree). Everything else is flagged: a path built
 * from the repo root, a function parameter, a string literal. Listing the
 * spellings of "the repo root" instead would exempt every spelling nobody listed
 * (L257), and a helper that takes its path as a parameter is exactly the shape
 * that hides a repo path one call away.
 *
 * It parses with the TypeScript compiler and resolves each name through the
 * checker, so a name means the binding in scope at the write (two functions each
 * with their own `path` are two names), a write NAMED inside a string or comment
 * is not a write, and only calls bound to the real modules count (writes and
 * `mkdtemp` to `node:fs` / `node:fs/promises`, `tmpdir` to `node:os`, `join` and
 * `resolve` to `node:path`), so a local helper that happens to be called `rm` or
 * `tmpdir` is not one either. A variable
 * that is REASSIGNED counts as temp only if every value it is ever given is.
 *
 * What it cannot see, stated so it is not read as broader than it is:
 *   - a write made by a CHILD PROCESS the suite spawns (a shell script, tsc, git,
 *     pnpm);
 *   - a write inside a shared helper in `scripts/lib/` that a suite calls with a
 *     repo path (names are resolved within ONE file, not across imports).
 * Those were measured instead, by a recursive watch of the whole checkout across
 * a full `pnpm test` (#2712's PR).
 *
 * The escape hatch is `// tree-write-ok: <reason>` on, or in the `//` block
 * directly above, the call, and it must carry a reason.
 */
import ts from "typescript";
import { hasOptOut } from "./opt-out.ts";

export const OPT_OUT = "tree-write-ok:";

/** Which module group a specifier belongs to; anything else is not followed. */
const MODULE_GROUP: ReadonlyMap<string, "fs" | "os" | "path"> = new Map([
  ["fs", "fs"], ["node:fs", "fs"], ["fs/promises", "fs"], ["node:fs/promises", "fs"],
  ["os", "os"], ["node:os", "os"],
  ["path", "path"], ["node:path", "path"],
] as const);

/**
 * fs calls that create, change or remove a path, and WHICH arguments are the
 * paths they change. Deletion counts: removing a file a concurrent walker has
 * just listed is the same race. For a copy or a link the first argument is only
 * read, so only the destination is judged; a rename changes both.
 */
export const WRITE_CALLS: ReadonlyMap<string, readonly number[]> = new Map<string, number[]>([
  ["writeFileSync", [0]], ["writeFile", [0]],
  ["appendFileSync", [0]], ["appendFile", [0]],
  ["mkdirSync", [0]], ["mkdir", [0]],
  ["rmSync", [0]], ["rm", [0]],
  ["unlinkSync", [0]], ["unlink", [0]],
  ["rmdirSync", [0]], ["rmdir", [0]],
  ["truncateSync", [0]], ["truncate", [0]],
  ["createWriteStream", [0]],
  ["copyFileSync", [1]], ["copyFile", [1]],
  ["cpSync", [1]], ["cp", [1]],
  ["symlinkSync", [1]], ["symlink", [1]],
  ["linkSync", [1]], ["link", [1]],
  ["renameSync", [0, 1]], ["rename", [0, 1]],
]);


export interface TreeWrite {
  line: number;
  call: string;
  /** The path argument as written. */
  target: string;
}

/** A one-file program with no lib and no module resolution: enough for the
 *  checker to bind local names, and cheap enough to build once per suite. */
function checkerFor(file: string, source: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, types: [] };
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === file ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === file,
    readFile: () => undefined,
  };
  const program = ts.createProgram({ rootNames: [file], options, host });
  return { sf, checker: program.getTypeChecker() };
}

export function scanTreeWrites(source: string, file = "suite.ts"): TreeWrite[] {
  const { sf, checker } = checkerFor(file, source);

  // How this file reaches fs, os and path: named imports (local name -> the
  // module's own name) and the local names of default or namespace imports
  // (`fs.writeFileSync`, `fs.promises.writeFile`, `os.tmpdir`, `path.join`).
  const named = { fs: new Map<string, string>(), os: new Map<string, string>(), path: new Map<string, string>() };
  const namespaces = { fs: new Set<string>(), os: new Set<string>(), path: new Set<string>() };
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
    const group = MODULE_GROUP.get(st.moduleSpecifier.text);
    if (!group) continue;
    const clause = st.importClause;
    if (clause.isTypeOnly) continue;
    if (clause.name) namespaces[group].add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) namespaces[group].add(nb.name.text);
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue;
        const imported = (el.propertyName ?? el.name).text;
        if (group === "fs" && imported === "promises") namespaces.fs.add(el.name.text);
        else named[group].set(el.name.text, imported);
      }
    }
  }

  /** The module function a call's callee is bound to, as `[group, name]`, or null
   *  for anything not reached through a real fs, os or path import. */
  const boundCall = (callee: ts.Expression): ["fs" | "os" | "path", string] | null => {
    if (ts.isIdentifier(callee)) {
      for (const group of ["fs", "os", "path"] as const) {
        const imported = named[group].get(callee.text);
        if (imported) return [group, imported];
      }
      return null;
    }
    if (!ts.isPropertyAccessExpression(callee)) return null;
    const obj = callee.expression;
    if (ts.isIdentifier(obj)) {
      for (const group of ["fs", "os", "path"] as const) {
        if (namespaces[group].has(obj.text)) return [group, callee.name.text];
      }
    }
    if (
      ts.isPropertyAccessExpression(obj) &&
      obj.name.text === "promises" &&
      ts.isIdentifier(obj.expression) &&
      namespaces.fs.has(obj.expression.text)
    ) {
      return ["fs", callee.name.text];
    }
    return null;
  };

  // Every value each variable is REASSIGNED to, keyed by its symbol.
  const assigned = new Map<ts.Symbol, ts.Expression[]>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const sym = checker.getSymbolAtLocation(node.left);
      if (sym) assigned.set(sym, [...(assigned.get(sym) ?? []), node.right]);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  /** Every value a name can hold, or null when one of them is not knowable here
   *  (a parameter, an import, a loop variable, a declaration with no value). */
  const valuesOf = (id: ts.Identifier): ts.Expression[] | null => {
    const sym = checker.getSymbolAtLocation(id);
    const decls = sym?.declarations ?? [];
    if (!sym || decls.length === 0) return null;
    const values: ts.Expression[] = [];
    for (const d of decls) {
      if (!ts.isVariableDeclaration(d)) return null;
      // A loop variable takes its values from the collection, which is not
      // followed here.
      const stmt = d.parent.parent;
      if (ts.isForOfStatement(stmt) || ts.isForInStatement(stmt)) return null;
      // `let x;` holds nothing until assigned, so only its assignments count.
      if (d.initializer) values.push(d.initializer);
    }
    values.push(...(assigned.get(sym) ?? []));
    return values.length > 0 ? values : null;
  };

  /** A string literal that cannot re-anchor a `path.resolve`: a relative piece. */
  const isRelativeLiteral = (e: ts.Expression): boolean =>
    (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && !e.text.startsWith("/");

  /** True when `expr` is a path ROOTED in a temp directory: the temp call is its
   *  base, not merely present somewhere inside it. */
  const isTemp = (expr: ts.Expression, seen: Set<ts.Node>): boolean => {
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
      return isTemp(expr.expression, seen);
    }
    if (ts.isAwaitExpression(expr)) return isTemp(expr.expression, seen);
    if (ts.isIdentifier(expr)) {
      if (seen.has(expr)) return false;
      seen.add(expr);
      const values = valuesOf(expr);
      return values !== null && values.every((v) => isTemp(v, seen));
    }
    if (ts.isTemplateExpression(expr)) {
      // `${dir}/x`: rooted only when nothing precedes the first substitution.
      return expr.head.text === "" && isTemp(expr.templateSpans[0].expression, seen);
    }
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return isTemp(expr.left, seen);
    }
    if (!ts.isCallExpression(expr)) return false;
    const bound = boundCall(expr.expression);
    if (!bound) return false;
    const [group, name] = bound;
    const args = expr.arguments;
    if (group === "os" && name === "tmpdir") return true;
    // A temp directory is created INSIDE its prefix, so the prefix is what has
    // to be rooted in a temp directory.
    if (group === "fs" && (name === "mkdtemp" || name === "mkdtempSync")) {
      return args.length > 0 && isTemp(args[0], seen);
    }
    if (group === "path" && name === "join") return args.length > 0 && isTemp(args[0], seen);
    if (group === "path" && name === "resolve") {
      // The result is anchored at the LAST absolute argument, so the temp base
      // must be followed only by relative literals that cannot re-anchor it.
      for (let i = args.length - 1; i >= 0; i--) {
        if (isTemp(args[i], seen)) return true;
        if (!isRelativeLiteral(args[i])) return false;
      }
      return false;
    }
    return false;
  };

  const writeName = (callee: ts.Expression): string | null => {
    const bound = boundCall(callee);
    return bound && bound[0] === "fs" && WRITE_CALLS.has(bound[1]) ? bound[1] : null;
  };

  const lines = source.split("\n");
  const out: TreeWrite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const call = writeName(node.expression);
      if (call) {
        const lineIndex = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        for (const i of WRITE_CALLS.get(call) ?? []) {
          const target = node.arguments[i];
          if (!target || isTemp(target, new Set())) continue;
          if (hasOptOut(lines, lineIndex, OPT_OUT)) continue;
          out.push({ line: lineIndex + 1, call, target: target.getText(sf) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
