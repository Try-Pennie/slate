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
 * strings double quoted with `\"` escaping a quote inside, numbers and booleans
 * bare. A line that does not start with `slate ` is not ours (a library's own
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
        if (line[i] === "\\" && line[i + 1] === '"') {
          out += '"';
          i += 2;
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

/** An unquoted value is a number or a boolean, as `formatLine` wrote it. Anything
 *  else stays a string rather than becoming a NaN. */
function scalar(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}
