// A function's source, found by the TypeScript compiler rather than by counting braces
// (#3460 review, L135): a brace inside a string, a template or a regex throws a brace
// count off and silently cuts the function short, so a pin built on it guards a
// fragment. The compiler knows where a function ends.
//
// Both answers are PRINTED by the compiler with comments removed, so a guard hashing them
// moves when the code changes and not when a comment or the formatting does.
import ts from "typescript";

const printer = ts.createPrinter({ removeComments: true });

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** The top level function declaration `name` in `text`, printed without comments, or null when there is none. */
export function functionSource(fileName: string, text: string, name: string): string | null {
  const file = parse(fileName, text);
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return printer.printNode(ts.EmitHint.Unspecified, statement, file);
    }
  }
  return null;
}

/** A whole file, printed without comments. */
export function fileSource(fileName: string, text: string): string {
  return printer.printFile(parse(fileName, text));
}
