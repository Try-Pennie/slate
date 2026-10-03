// Does the tail worker's `tail()` handler wrap ALL of its work in one try/catch
// (#3105, review of #3160)? A whole file search for `try ... catch` is satisfied by
// any catch anywhere in the file, so this reads the handler's own body: its first
// statement must be a `try`, and nothing but the matching `catch` (or `finally`)
// block may follow it.

/** The text between the braces opening at `open`, or null when they never close.
 *  Strings, template literals and comments are skipped so a brace inside one does
 *  not count. */
function blockBody(src: string, open: number): { body: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      for (i++; i < src.length && src[i] !== quote; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) return null;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 1;
      if (i === 0) return null;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** Null when the handler wraps its whole body; otherwise why it does not. */
export function tailHandlerWrapFault(src: string): string | null {
  const head = /async\s+tail\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/.exec(src);
  if (!head) return "no async tail() handler found";
  const handler = blockBody(src, head.index + head[0].length - 1);
  if (!handler) return "the tail() handler's body never closes";
  const body = handler.body;
  const tryAt = /^\s*try\s*\{/.exec(body);
  if (!tryAt) return "the tail() handler's first statement is not a try, so work before it is unguarded";
  const tryBlock = blockBody(body, tryAt[0].length - 1);
  if (!tryBlock) return "the try block never closes";
  let rest = body.slice(tryBlock.end + 1);
  const catchAt = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(rest);
  if (!catchAt) return "the try in tail() has no catch, so a failure escapes";
  const catchBlock = blockBody(rest, catchAt[0].length - 1);
  if (!catchBlock) return "the catch block never closes";
  rest = rest.slice(catchBlock.end + 1);
  const finallyAt = /^\s*finally\s*\{/.exec(rest);
  if (finallyAt) {
    const fin = blockBody(rest, finallyAt[0].length - 1);
    if (!fin) return "the finally block never closes";
    rest = rest.slice(fin.end + 1);
  }
  if (rest.trim() !== "") return "the tail() handler does work after its try/catch, which is unguarded";
  return null;
}
