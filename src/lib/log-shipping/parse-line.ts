/**
 * Read a `slate tag=... key=value` line back into fields (#3105, #3138).
 *
 * `src/lib/log.ts` writes every server line in that one format, so a lane's
 * timing (`tag=cron msg="lane timings" total_ms=5400 recompute_ms=5101 ...`) is
 * already a set of named numbers. Shipping it as one opaque string would leave
 * Better Stack unable to chart a lane against itself, which is the whole reason
 * the line exists (#1245). So the tail worker parses it here and forwards the
 * fields as JSON, numbers as numbers.
 *
 * The grammar is exactly what `formatLine` emits: space separated `key=value`,
 * strings double quoted with a backslash escaping a backslash, a quote, a line
 * break, a tab or (as `\uXXXX`) any other control character inside (#4237),
 * numbers and booleans bare. A line that does not start with `slate ` is not ours (a library's own
 * console line, a framework warning) and returns null, so the caller ships it as
 * plain text rather than inventing fields for it.
 */

export type ParsedFields = Record<string, string | number | boolean>;

const PREFIX = "slate ";
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse one line, or null when it is not a `slate` line. */
export function parseSlateLine(line: string): ParsedFields | null {
  if (!line.startsWith(PREFIX)) return null;
  const fields: ParsedFields = {};
  let i = PREFIX.length;
  const n = line.length;
  while (i < n) {
    while (i < n && line[i] === " ") i++;
    if (i >= n) break;
    const eqAt = line.indexOf("=", i);
    if (eqAt === -1) break;
    const key = line.slice(i, eqAt);
    i = eqAt + 1;
    let value: string | number | boolean;
    if (line[i] === '"') {
      let out = "";
      i++;
      while (i < n && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < n) {
          const [text, width] = unescape(line, i + 1);
          out += text;
          i += 1 + width;
        } else {
          out += line[i];
          i++;
        }
      }
      i++; // the closing quote
      value = out;
    } else {
      const end = line.indexOf(" ", i);
      const raw = line.slice(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      value = scalar(raw);
    }
    // A key that is not a plain identifier means the line was not written by
    // `formatLine` after all; keep what parsed rather than inventing a field name.
    if (KEY.test(key)) fields[key] = value;
  }
  return fields;
}

const SHORT_UNESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  '"': '"',
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * The text an escape stands for, and how many characters after the backslash it
 * used. `formatLine` writes `\\`, `\"`, `\n`, `\r`, `\t` and `\uXXXX` (#4237). Any
 * other pair is kept as written, backslash included, which is how a line from
 * before #4237 holding a lone backslash (a Windows path) still reads as it was.
 */
function unescape(line: string, at: number): [string, number] {
  const ch = line[at] ?? "";
  const short = SHORT_UNESCAPES[ch];
  if (short !== undefined) return [short, 1];
  if (ch === "u") {
    const hex = line.slice(at + 1, at + 5);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) return [String.fromCharCode(parseInt(hex, 16)), 5];
  }
  return [`\\${ch}`, 1];
}

/** An unquoted value is a number or a boolean, as `formatLine` wrote it. Anything
 *  else stays a string rather than becoming a NaN. */
function scalar(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}
