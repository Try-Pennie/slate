// Static detector for the #2690 guard: server code CALLING a function exported
// from a `"use client"` module. See scripts/test-client-boundary-calls.ts for the
// why, the surface, its stated boundary, and the controls that prove it catches
// the shape.
//
// The rule the React server components runtime enforces, and nothing before it
// does: a module WITHOUT `"use client"` renders on the server, and every export of
// a `"use client"` module reaches it as a client REFERENCE, not as the function.
// So the server may render one (`<SaveForm />`) or pass one along as a value, but
// CALLING one throws "Attempted to call X() from the server but X is on the
// client" at render time. tsc cannot see it (the types are the real function's),
// vitest cannot see it (jsdom has no boundary), and `next build` does not see it
// either for a dynamic admin page, which is how `/admin/business-hours` shipped
// broken and took the public booking kill switch down with it.
//
// This walks the real syntax tree with the TypeScript compiler API rather than
// matching text, because the question is about BINDINGS: which local name came
// from which module, and whether that name is the callee of a call. A text scan
// would confuse `holdsAView(` inside a string or comment with a call, and could
// not tell a namespace import's member call from an unrelated one.
//
// A finding is: in a file with no `"use client"` directive, a call (or `new`)
// whose callee is a binding imported from a module that HAS the directive, either
// directly (`fn()`) or through a namespace import (`ns.fn()`). JSX (`<Name />`),
// passing the binding as a value, and type-only imports are not findings.
//
// Escape hatch: `// client-boundary-ok: <reason>` on the call's line or in the
// comment block directly above it, read through the shared opt-out reader, so a
// bare marker with no reason exempts nothing.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { hasOptOut } from "./opt-out.ts";

export const OPT_OUT_TOKEN = "client-boundary-ok:";

export interface ClientBoundaryCallFinding {
  /** The calling file, as passed in. */
  file: string;
  /** 1-indexed line of the call. */
  line: number;
  /** The callee as written: `holdsAView` or `ns.fn`. */
  callee: string;
  /** The import specifier the binding came from, as written. */
  from: string;
}

/** True when the file's directive prologue carries `"use client"`. */
export function hasUseClientDirective(source: string): boolean {
  const sf = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
    if (st.expression.text === "use client") return true;
  }
  return false;
}

const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/**
 * Resolve a specifier to a file under the repo, or null for a package or an
 * unresolvable path. `@/` maps to `src/` (the tsconfig alias). Packages are out
 * of reach on purpose: see the boundary in the test's header.
 */
export function resolveLocalSpecifier(
  specifier: string,
  fromFile: string,
  srcRoot: string,
  exists: (p: string) => boolean = existsSync,
): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(srcRoot, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;
  if (/\.(tsx?|jsx?)$/.test(base) && exists(base)) return base;
  for (const ext of EXTENSIONS) {
    if (exists(base + ext)) return base + ext;
  }
  return null;
}

/**
 * Scan one server-side source for calls into client modules.
 *
 * `isClientModule(specifier)` answers whether an import specifier names a
 * `"use client"` module; the caller supplies it so the scan is testable with
 * synthetic sources and no file system.
 */
export function scanClientBoundaryCalls(
  source: string,
  file: string,
  isClientModule: (specifier: string) => boolean,
): ClientBoundaryCallFinding[] {
  if (hasUseClientDirective(source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // local name -> specifier, split by how the binding was imported.
  const direct = new Map<string, string>();
  const namespaces = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.importClause;
    if (clause.isTypeOnly) continue;
    const spec = st.moduleSpecifier.text;
    if (!isClientModule(spec)) continue;
    if (clause.name) direct.set(clause.name.text, spec);
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) namespaces.set(nb.name.text, spec);
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue;
        direct.set(el.name.text, spec);
      }
    }
  }
  if (direct.size === 0 && namespaces.size === 0) return [];

  const lines = source.split("\n");
  const findings: ClientBoundaryCallFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      let name: string | null = null;
      let from: string | undefined;
      if (ts.isIdentifier(callee) && direct.has(callee.text)) {
        name = callee.text;
        from = direct.get(callee.text);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text)
      ) {
        name = `${callee.expression.text}.${callee.name.text}`;
        from = namespaces.get(callee.expression.text);
      }
      if (name !== null && from !== undefined) {
        const lineIndex = sf.getLineAndCharacterOfPosition(callee.getStart(sf)).line;
        if (!hasOptOut(lines, lineIndex, OPT_OUT_TOKEN)) {
          findings.push({ file, line: lineIndex + 1, callee: name, from });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/**
 * Scan real files: resolve each import against the tree and read the target's
 * directive, caching per resolved path.
 */
export function scanFilesForClientBoundaryCalls(
  files: readonly string[],
  srcRoot: string,
  display: (file: string) => string = (f) => f,
): ClientBoundaryCallFinding[] {
  const directiveCache = new Map<string, boolean>();
  const isClientPath = (path: string): boolean => {
    let v = directiveCache.get(path);
    if (v === undefined) {
      v = hasUseClientDirective(readFileSync(path, "utf8"));
      directiveCache.set(path, v);
    }
    return v;
  };
  const out: ClientBoundaryCallFinding[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    out.push(
      ...scanClientBoundaryCalls(source, display(file), (spec) => {
        const target = resolveLocalSpecifier(spec, file, srcRoot);
        return target !== null && isClientPath(target);
      }),
    );
  }
  return out;
}
