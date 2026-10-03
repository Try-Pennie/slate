// GitHub Actions `paths:` filters, read and matched (#3099), so a path gated
// workflow can be checked against the inputs it really reads (L88).

/**
 * The `paths:` list under one event of a workflow's `on:` block, or null when the
 * event or its list is absent. Null and an empty list are different answers: no gate
 * at all runs on every change, and a caller must not read either as "covered".
 */
export function readTriggerPaths(source: string, event: string): string[] | null {
  const lines = source.split("\n");
  const on = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (on < 0) return null;
  let i = on + 1;
  for (; i < lines.length && !/^\S/.test(lines[i] as string); i++) {
    if (new RegExp(`^ {2}${event}:\\s*$`).test(lines[i] as string)) break;
  }
  if (i >= lines.length || /^\S/.test(lines[i] as string)) return null;
  for (i++; i < lines.length; i++) {
    const l = lines[i] as string;
    if (/^ {0,3}\S/.test(l)) return null;
    if (/^ {4}paths:\s*$/.test(l)) break;
  }
  if (i >= lines.length) return null;
  const out: string[] = [];
  for (i++; i < lines.length; i++) {
    const l = (lines[i] as string).replace(/\s+#.*$/, "");
    if (/^\s*#/.test(l) || l.trim() === "") continue;
    const item = l.match(/^ {6}-\s*["']?([^"']+?)["']?\s*$/);
    if (!item) break;
    out.push(item[1] as string);
  }
  return out;
}

/** GitHub's filter glob: `**` crosses directories, `*` and `?` stay within one. */
export function pathFilterMatches(pattern: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}

/** The inputs no pattern in the gate matches. Negated (`!`) patterns are not supported and are refused by being unmatched. */
export function uncoveredInputs(patterns: readonly string[], inputs: readonly string[]): string[] {
  return inputs.filter((p) => !patterns.some((g) => !g.startsWith("!") && pathFilterMatches(g, p)));
}
