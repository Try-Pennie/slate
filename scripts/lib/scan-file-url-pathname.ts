/**
 * Pure scan behind `scripts/test-file-url-pathname.ts` (#3041): find every place
 * a file system path is taken from a FILE URL's `.pathname`.
 *
 * Why it exists: `new URL("..", import.meta.url).pathname` reads like a path and
 * is not one. A URL keeps its path percent encoded, so a checkout under
 * `Documents - Dan’s MacBook Pro` comes back as `Documents%20-%20Dan%E2%80%99s...`
 * and every file read built from it fails with ENOENT. On 2026-10-02 the Slate
 * checkout moved to exactly that folder and 17 node suites, plus the pre push
 * workflow settings guard, died on it. It stayed invisible until then because
 * the pre push gate builds in a temporary worktree under /var/folders and CI
 * checks out to a plain path, where encoding changes nothing.
 *
 * The decoding forms are `fileURLToPath(new URL(..., import.meta.url))` from
 * `node:url`, or `import.meta.dirname`. Both are left alone here.
 *
 * What counts as a file URL, parsed with the TypeScript compiler so a shape
 * NAMED inside a string or a comment is never a finding (the guards that test
 * this very shape carry it as fixture text):
 *   - `new URL(<anything>, import.meta.url)` and `new URL(import.meta.url)`;
 *   - `pathToFileURL(<anything>)`, which encodes in the same way;
 *   - a variable whose initializer is one of those, read as `name.pathname`.
 *
 * What it cannot see, stated so it is not read as broader than it is: a file URL
 * passed through a function parameter or a property before `.pathname` is read,
 * and a URL built from a `file://` string literal. The variable rule matches on
 * the NAME within one file, without scope, so it errs toward flagging.
 */
import ts from "typescript";

export type FileUrlPathnameFinding = { line: number; text: string };

function isImportMetaUrl(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "url" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
  return n;
}

/** Is this expression, as written, a file URL? */
function isFileUrlExpression(node: ts.Expression): boolean {
  const n = unwrap(node);
  if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "URL") {
    return (n.arguments ?? []).some((a) => isImportMetaUrl(unwrap(a)));
  }
  if (ts.isCallExpression(n)) {
    const callee = n.expression;
    if (ts.isIdentifier(callee) && callee.text === "pathToFileURL") return true;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "pathToFileURL") return true;
  }
  return false;
}

export function scanFileUrlPathname(source: string, fileName = "file.ts"): FileUrlPathnameFinding[] {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.m?jsx?$|\.cjs$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);

  // Names bound to a file URL anywhere in the file.
  const fileUrlNames = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFileUrlExpression(node.initializer)) {
      fileUrlNames.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const findings: FileUrlPathnameFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "pathname") {
      const target = unwrap(node.expression);
      const direct = isFileUrlExpression(target);
      const viaName = ts.isIdentifier(target) && fileUrlNames.has(target.text);
      if (direct || viaName) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        findings.push({ line, text: node.getText(sf).replace(/\s+/g, " ") });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}
