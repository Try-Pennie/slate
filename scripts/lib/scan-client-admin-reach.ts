// Static detector for the #3172 guard: a `"use client"` module whose import graph
// reaches the secret key Supabase client. See scripts/test-client-admin-reach.ts for
// the why, the surface, its stated boundary, and the controls that prove it catches
// the shape.
//
// The bundler puts every module a client component imports at runtime into a browser
// chunk, and it follows the WHOLE module, not the export that was asked for. So a
// client component importing a plain constant (`SEARCH_LIMIT`) out of a module that
// also imports `@/lib/supabase/admin` ships the admin client and its
// `SUPABASE_SECRET_KEY` read to every browser that opens the page. Nothing failed:
// the secret's VALUE is never in the bundle, because the read only runs server side,
// so the page works and the code is simply somewhere it should not be.
//
// The walk reads each module's syntax tree with the TypeScript compiler API, because
// what matters is which imports survive compilation: `import type` and an import
// whose every binding is `type` are erased and reach nothing, while a side effect
// import, a re-export and a dynamic `import()` all pull a module in. It stops at a
// module carrying `"use server"`, because a client component importing one gets
// action REFERENCES, never the module's code, which is how every admin form reaches
// the database without carrying it.

import { readFileSync } from "node:fs";
import ts from "typescript";
import { hasUseClientDirective, resolveLocalSpecifier } from "./scan-client-boundary-calls.ts";

/** Modules no client graph may reach, as paths relative to the repo's `src/`. */
export const SERVER_ONLY_MODULES = [
  "lib/supabase/admin.ts",
  // #4205: the zip to zone table, about 11 KB a browser has no use for.
  "lib/zip-zones/zip-zone-data.ts",
] as const;

export interface ClientAdminReachFinding {
  /** The `"use client"` module the walk started from (absolute). */
  entry: string;
  /** The import chain from the entry to the forbidden module, both ends included. */
  chain: string[];
}

/** True when the file's directive prologue carries `"use server"`. */
export function hasUseServerDirective(source: string): boolean {
  const sf = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
    if (st.expression.text === "use server") return true;
  }
  return false;
}

/** True when an import clause is erased by compilation and so reaches nothing. */
function isErasedImport(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false; // `import "x"` runs x for its side effects
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const nb = clause.namedBindings;
  if (!nb) return false;
  if (ts.isNamespaceImport(nb)) return false;
  return nb.elements.length > 0 && nb.elements.every((el) => el.isTypeOnly);
}

/**
 * Every specifier a module pulls in at RUNTIME: value imports, side effect imports,
 * value re-exports, dynamic `import()` and `require()`. Type only forms are skipped.
 */
export function runtimeImportSpecifiers(source: string): string[] {
  const sf = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      if (!isErasedImport(st.importClause)) add(st.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      !st.isTypeOnly
    ) {
      const clause = st.exportClause;
      const allTypes =
        clause !== undefined &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((el) => el.isTypeOnly);
      if (!allTypes) add(st.moduleSpecifier.text);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface ReachIo {
  readFile(path: string): string;
  exists(path: string): boolean;
}

const fsIo: ReachIo = {
  readFile: (p) => readFileSync(p, "utf8"),
  exists: (p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Walk from each `"use client"` entry and report the FIRST chain (breadth first, so
 * the shortest) by which it reaches a forbidden module. A file that cannot be read is
 * skipped rather than thrown on, since a broken import is the build's to report.
 */
export function scanClientAdminReach(args: {
  entries: string[];
  srcRoot: string;
  forbidden: string[];
  io?: ReachIo;
}): ClientAdminReachFinding[] {
  const io = args.io ?? fsIo;
  const forbidden = new Set(args.forbidden);
  const findings: ClientAdminReachFinding[] = [];
  const read = (p: string): string | null => {
    try {
      return io.readFile(p);
    } catch {
      return null;
    }
  };

  for (const entry of args.entries) {
    const entrySrc = read(entry);
    if (entrySrc === null || !hasUseClientDirective(entrySrc)) continue;
    const parent = new Map<string, string | null>([[entry, null]]);
    const queue = [entry];
    let hit: string | null = null;
    while (queue.length > 0 && hit === null) {
      const file = queue.shift() as string;
      const src = read(file);
      if (src === null) continue;
      if (file !== entry && hasUseServerDirective(src)) continue;
      for (const spec of runtimeImportSpecifiers(src)) {
        const resolved = resolveLocalSpecifier(spec, file, args.srcRoot, io.exists);
        if (!resolved || parent.has(resolved)) continue;
        parent.set(resolved, file);
        if (forbidden.has(resolved)) {
          hit = resolved;
          break;
        }
        queue.push(resolved);
      }
    }
    if (hit !== null) {
      const chain: string[] = [];
      for (let at: string | null = hit; at !== null; at = parent.get(at) ?? null) chain.unshift(at);
      findings.push({ entry, chain });
    }
  }
  return findings;
}

/** One block per finding, naming every hop, for a failure somebody has to act on. */
export function describeClientAdminReach(findings: ClientAdminReachFinding[], root: string): string {
  const rel = (p: string) => (p.startsWith(root) ? p.slice(root.length + 1) : p);
  return findings.map((f) => `  ${f.chain.map(rel).join("\n    imports ")}`).join("\n");
}
