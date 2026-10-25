import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { hasOptOut } from "./opt-out.ts";

// Static detector for #3972 (L1028): an outbound call in server code with no timeout of
// its own. Read `scripts/test-outbound-deadlines.ts` for why it matters.
//
// Two shapes are found, both through the TypeScript parser rather than a line match:
//
//   - a call to the global `fetch` whose second argument is not an object literal
//     naming a `signal` (a timeout signal, or the caller's own, which then owns it);
//   - the global `fetch` handed on as a VALUE (`fetchImpl: fetch`, `?? fetch`, a
//     default parameter, an argument), because whatever receives it calls it later
//     where this scan cannot follow.
//
// Either passes with `// deadline-ok: <why>` on its line or in the `//` comment block
// directly above it, naming what bounds the call instead (a deadline wrapper it is
// the inner fetch of, the receiver's own timeout, or a browser that is not the
// Worker). Client modules (`"use client"`) and tests are not scanned: the platform
// that kills at a deadline is the Worker.

export const DEADLINE_OK = "deadline-ok:";

export interface OutboundFinding {
  file: string;
  line: number;
  kind: "call" | "value";
  text: string;
}

function isUseClient(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use client"
  );
}

function hasSignal(arg: ts.Expression | undefined): boolean {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      ts.isIdentifier(p.name) &&
      p.name.text === "signal",
  );
}

/** Whether this `fetch` identifier is the global handed on as a value. */
function isValueUse(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isCallExpression(p)) return p.arguments.includes(id);
  if (ts.isPropertyAssignment(p)) return p.initializer === id;
  if (ts.isShorthandPropertyAssignment(p)) return true;
  if (ts.isVariableDeclaration(p)) return p.initializer === id;
  if (ts.isParameter(p)) return p.initializer === id;
  if (ts.isBinaryExpression(p)) return true;
  if (ts.isConditionalExpression(p)) return p.whenTrue === id || p.whenFalse === id;
  if (ts.isReturnStatement(p) || ts.isArrowFunction(p)) return true;
  return false;
}

/** The opt out, with a reason, on the finding's line or in the comment block above it. */
function optedOut(lines: string[], index: number): boolean {
  return hasOptOut(lines, index, DEADLINE_OK);
}

export function outboundWithoutDeadline(file: string, source: string): OutboundFinding[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  if (isUseClient(sf)) return [];
  const lines = source.split("\n");
  const out: OutboundFinding[] = [];
  const report = (node: ts.Node, k: OutboundFinding["kind"]) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    if (optedOut(lines, line)) return;
    out.push({ file, line: line + 1, kind: k, text: (lines[line] ?? "").trim() });
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
      if (!hasSignal(node.arguments[1])) report(node, "call");
    } else if (ts.isIdentifier(node) && node.text === "fetch" && isValueUse(node)) {
      report(node, "value");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every server module under `src/` and `worker/`, tests excluded. */
export function serverModules(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
    }
  };
  for (const top of ["src", "worker"]) walk(join(root, top));
  return out.map((p) => relative(root, p)).sort();
}

export function scanTree(root: string): { findings: OutboundFinding[]; filesScanned: number; callsSeen: number } {
  const files = serverModules(root);
  const findings: OutboundFinding[] = [];
  let callsSeen = 0;
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    callsSeen += (source.match(/\bfetch\b/g) ?? []).length;
    findings.push(...outboundWithoutDeadline(file, source));
  }
  return { findings, filesScanned: files.length, callsSeen };
}
