/**
 * Every machine bearer key has a rotation slot (#3110).
 *
 * A key checked against ONE value can only be rotated by changing the Worker and
 * every caller in the same instant, which never happens: between the two steps one
 * side holds a value the other refuses and the caller is locked out. The booking
 * API keys had a `_2` slot from #2645; the other `bearerTokenMatches` keys did
 * not. So every call passes `[KEY, KEY_2]` as an array literal, and a call written
 * against a single value is refused with the file and line.
 *
 * The escape hatch is `// rotation-slot-ok: <why>` on, or in the `//` block
 * directly above, the call, and it must carry a reason.
 */
import { hasOptOut } from "./opt-out.ts";

export interface RotationSlotFinding {
  file: string;
  line: number;
  text: string;
}

const CALL = /\bbearerTokenMatches\s*\(/g;

/** The text of the call's second argument, from just after the first top level comma. */
function secondArgument(src: string, open: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      // A trailing comma after the last argument is not part of it.
      if (depth === 0) return start === -1 ? null : src.slice(start, i).trim().replace(/,$/, "").trim();
    } else if (ch === "," && depth === 1 && start === -1) start = i + 1;
  }
  return null;
}

/**
 * The source with every comment and the inside of every string literal blanked to
 * spaces, newlines kept, so offsets and line numbers still match the original. A
 * comma or bracket inside a comment or a string is not syntax, and counting one
 * would read `[key /* , old *\/]` or `["a,b"]` as two slots. Quotes are kept, so a
 * string literal is still visible as one.
 */
export function maskCommentsAndStrings(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, src.length));
      i = j + 1;
    } else i++;
  }
  return out.join("");
}

/**
 * True when the argument is an array literal of at least two entries, none of
 * them a string literal (a literal is never a configured slot). Read over masked
 * source, so commas in comments and strings are not counted.
 */
function isSlotPair(arg: string): boolean {
  if (!arg.startsWith("[") || !arg.endsWith("]")) return false;
  let depth = 0;
  const entries: string[] = [];
  let cur = "";
  const inner = arg.slice(1, -1).trim().replace(/,\s*$/, "");
  for (const ch of inner) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      entries.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  entries.push(cur.trim());
  return entries.length >= 2 && entries.every((e) => e.length > 0 && !/^["'`]\s*["'`]$/.test(e));
}

export function scanBearerRotationSlots(file: string, src: string): RotationSlotFinding[] {
  const out: RotationSlotFinding[] = [];
  const lines = src.split("\n");
  // Calls are found and read in the masked text, so a name or a comma inside a
  // comment or a string is not syntax; the opt out is read from the original.
  const code = maskCommentsAndStrings(src);
  for (const m of code.matchAll(CALL)) {
    const at = m.index ?? 0;
    const lineIdx = code.slice(0, at).split("\n").length - 1;
    const lineText = lines[lineIdx];
    // The definition is not a call.
    if (/\bfunction\s+bearerTokenMatches\b/.test(lineText)) continue;
    const arg = secondArgument(code, at + m[0].length - 1);
    if (arg !== null && isSlotPair(arg)) continue;
    if (hasOptOut(lines, lineIdx, "rotation-slot-ok:")) continue;
    out.push({ file, line: lineIdx + 1, text: lineText.trim() });
  }
  return out;
}
