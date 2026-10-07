// A function's source, found by the TypeScript compiler rather than by counting braces
// (#3460 review, L135): a brace inside a string, a template or a regex throws a brace
// count off and silently cuts the function short, so a pin built on it guards a
// fragment. The compiler knows where a function ends.
//
// Both answers are the source's OWN tokens, joined by single spaces, with comments and
// layout dropped, so a guard hashing them moves when the code changes and not when a
// comment or the formatting does. Never the compiler's printer (review of #3470, L552):
// its layout belongs to the installed TypeScript version, so a compiler upgrade would
// move the hash with no change to the code it stands for.
import ts from "typescript";

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function isDocComment(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

/** The leaf tokens under `node`, in source order, as written. */
function tokensOf(node: ts.Node, file: ts.SourceFile, out: string[] = []): string[] {
  if (isDocComment(node)) return out;
  const children = node.getChildren(file);
  if (children.length === 0) {
    const text = node.getText(file);
    if (text !== "") out.push(text);
    return out;
  }
  for (const child of children) tokensOf(child, file, out);
  return out;
}

/** The top level function declaration `name` in `text`, as its tokens, or null when there is none. */
export function functionSource(fileName: string, text: string, name: string): string | null {
  const file = parse(fileName, text);
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return tokensOf(statement, file).join(" ");
    }
  }
  return null;
}

/** A whole file, as its tokens. */
export function fileSource(fileName: string, text: string): string {
  const file = parse(fileName, text);
  return tokensOf(file, file).join(" ");
}
