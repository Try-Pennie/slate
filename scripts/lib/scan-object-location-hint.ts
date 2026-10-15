/**
 * Every Durable Object lookup passes the one location hint (#3752).
 *
 * A lookup is a `.get(` whose first argument makes an object id (`idFromName(`,
 * `idFromString(` or `newUniqueId(`, reached through `.`, `!.` or `?.`), or is a name a
 * `const`/`let` in the same file was given from one. It passes when that call's own
 * arguments name `OBJECT_LOCATION_HINT`, never a literal: a literal region is the copy
 * this exists to stop drifting. An id that crosses a function boundary is not followed. Comments are blanked first,
 * so a lookup written in prose is never counted. One pass per file (L297).
 */
import { blankComments } from "./strip-comments.ts";

export interface UnhintedLookup {
  file: string;
  line: number;
  text: string;
}

/** The index of the parenthesis closing the one opened at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Every object lookup in one file's source, with whether it carries the hint. */
export function objectLookups(file: string, source: string): { hinted: number; unhinted: UnhintedLookup[] } {
  const text = blankComments(source);
  const unhinted: UnhintedLookup[] = [];
  let hinted = 0;
  const makesId = String.raw`[\w.!?]+?\??\.(?:idFromName|idFromString|newUniqueId)\(`;
  const ids = [...text.matchAll(new RegExp(String.raw`\b(?:const|let)\s+(\w+)\s*=\s*${makesId}`, "g"))].map((m) => m[1]!);
  const firstArg = ids.length ? String.raw`(?:${makesId}|(?:${ids.join("|")})\s*[,)])` : makesId;
  const lookup = new RegExp(String.raw`\.get\(\s*${firstArg}`, "g");
  for (let m = lookup.exec(text); m; m = lookup.exec(text)) {
    const open = m.index + ".get".length;
    const end = closing(text, open);
    const call = end === -1 ? text.slice(open) : text.slice(open, end + 1);
    if (/\bOBJECT_LOCATION_HINT\b/.test(call)) hinted++;
    else {
      const line = text.slice(0, m.index).split("\n").length;
      unhinted.push({ file, line, text: source.split("\n")[line - 1]!.trim() });
    }
  }
  return { hinted, unhinted };
}
