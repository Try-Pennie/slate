// The source spans of every `selectAllPages(...)` call in a file (#3273).
//
// Since #3273 a paged read hands `selectAllPages` its query WITHOUT `.range()`:
// the helper orders it by a unique key and cuts every page itself, so a caller
// can no longer page a query without a total order. The query chain inside the
// call therefore carries no bounding signal of its own, and a scanner judging
// the chain alone would read a fully paged read as a capped single page. This is
// how those scanners see that the helper owns the paging.
//
// A text scan, like its callers: it walks parentheses, skipping string literals,
// template literals and comments, so a paren inside a comment or a string
// cannot end a call early.

/** [start, end) offsets of each `selectAllPages(` call, from the name to its `)`. */
export function pagedCallSpans(source: string): [number, number][] {
  const spans: [number, number][] = [];
  const re = /\bselectAllPages\s*(?:<[^()]*?>)?\s*\(/g;
  for (const m of source.matchAll(re)) {
    const start = m.index as number;
    const open = start + m[0].length - 1;
    let depth = 0;
    let quote: string | null = null;
    let i = open;
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "/" && source[i + 1] === "/") {
        const nl = source.indexOf("\n", i);
        i = nl === -1 ? source.length : nl;
        continue;
      }
      if (c === "/" && source[i + 1] === "*") {
        const endComment = source.indexOf("*/", i + 2);
        i = endComment === -1 ? source.length : endComment + 1;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    spans.push([start, Math.min(i + 1, source.length)]);
  }
  return spans;
}

/** True when `index` falls inside a `selectAllPages(...)` call. */
export function isInsidePagedCall(spans: [number, number][], index: number): boolean {
  return spans.some(([s, e]) => index > s && index < e);
}
