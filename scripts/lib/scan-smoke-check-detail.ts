/**
 * Pure scan behind `scripts/test-smoke-response-detail.ts` (#3663): every
 * `check(...)` in the canary whose condition reads a response (`x.status` or
 * `x.body`) must hand that response to `check` as its third argument, so a failure
 * prints the response's `code` rather than `got 503/undefined`.
 *
 * Parsed with the TypeScript compiler, so a shape named inside a string is never a
 * finding. What it cannot see: a condition computed into a variable first and then
 * passed to `check`, which reads no response by name.
 */
import ts from "typescript";

export type CheckDetailFinding = { line: number; text: string; reads: string[] };

/** Identifiers read as `<name>.status` or `<name>.body` anywhere inside `node`. */
function responsesRead(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      (n.name.text === "status" || n.name.text === "body")
    ) {
      names.add(n.expression.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

export function scanSmokeCheckDetail(source: string, fileName = "smoke.ts"): CheckDetailFinding[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: CheckDetailFinding[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "check" && n.arguments.length > 0) {
      const reads = responsesRead(n.arguments[0]!);
      const handed = n.arguments[2];
      const ok = reads.size === 0 || (handed !== undefined && ts.isIdentifier(handed) && reads.has(handed.text));
      if (!ok) {
        const line = file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1;
        findings.push({ line, text: n.getText(file).split("\n")[0]!, reads: [...reads] });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return findings;
}
