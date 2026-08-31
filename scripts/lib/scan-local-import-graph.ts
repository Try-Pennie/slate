// Walk a script's TRANSITIVE import graph and report every edge that leaves the
// local set (#1598).
//
// Why this exists rather than a check on the workflow file: a workflow that no
// longer says `pnpm install` proves nothing about whether the script it runs still
// needs one. The quantity worth protecting is the import graph, so that is what is
// measured here, not a proxy for it (L63). An alert script that reaches
// `@/lib/notify/slack`, `@supabase/supabase-js`, or anything else under
// node_modules cannot run on a bare checkout, and the workflows that carry the
// alerting for a failed deploy or an unreviewed push to main deliberately run on
// one: every dependency they carry is another way for the alert to be unavailable
// in exactly the conditions it exists for (#1524, #1598).
//
// "Local" means: node builtins (which need no install), and files inside the roots
// the caller names, reached by a relative specifier that actually resolves on disk.
// Everything else is a foreign edge and is reported with the file it was found in,
// so a package pulled in three modules deep names the module that pulls it rather
// than the entry.
//
// The IO is injected so this is testable against fixtures and against an OVERLAY of
// the real tree (one real file's content replaced in memory), which is how the
// positive control reintroduces a removed import without writing to the repo.
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface ImportGraphIo {
  /** Read a file's source. Throws (like node:fs) when it is not there. */
  readFile(path: string): string;
  /** Whether a path exists as a readable file. */
  exists(path: string): boolean;
}

export type ForeignReason =
  /** A bare package specifier: it can only resolve out of node_modules. */
  | "package"
  /** A `@/...` path alias: it needs the register-paths hook AND the app's tree. */
  | "alias"
  /** Resolved to a real file, but one outside the roots the caller allows. */
  | "outside-local-roots"
  /** A relative specifier that resolves to nothing on disk. */
  | "unresolved";

export interface ForeignEdge {
  /** The file the import was written in (absolute). */
  from: string;
  /** The specifier exactly as written. */
  specifier: string;
  reason: ForeignReason;
}

export interface ImportGraph {
  entry: string;
  /** Every local file reached, entry included, sorted. */
  files: string[];
  /** Every edge that leaves the local set, sorted. */
  foreign: ForeignEdge[];
}

/**
 * Builtins need no install, so they are local for this purpose. Both spellings are
 * accepted: `node:fs` is the house style, and a bare `fs` still resolves to the
 * builtin rather than to anything installed.
 */
const NODE_BUILTINS = new Set([
  "assert",
  "assert/strict",
  "buffer",
  "child_process",
  "console",
  "crypto",
  "dns",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "stream/promises",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "worker_threads",
  "zlib",
]);

/**
 * Blank out comments, keeping every other byte at its original offset.
 *
 * Needed in BOTH directions. A header comment that quotes the import it describes
 * (these files explain the dependency chain they removed) would otherwise be read as
 * the import itself and fail a correct file (L103); and a commented-out import must
 * not be reported as a live edge.
 *
 * String and template literals are tracked so a `//` inside a URL (every Slack post
 * in this repo contains one) is not mistaken for the start of a comment.
 */
export function blankComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      // Blank the closing */ too, when it is there at all.
      if (i < n) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Every specifier a module imports, in source order, with duplicates kept out.
 *
 * Covers the four shapes that reach another module: a static `import ... from`, a
 * bare side-effect `import "x"`, a re-export `export ... from`, a dynamic
 * `import("x")`, and `require("x")`. The static form is anchored at the start of a
 * line and may not cross a quote before its `from`, so a multi line import list is
 * read as one statement while a string containing the word `from` cannot swallow the
 * rest of the file.
 */
export function importSpecifiers(src: string): string[] {
  const code = blankComments(src);
  const found: string[] = [];
  const add = (s: string | undefined): void => {
    if (s && !found.includes(s)) found.push(s);
  };
  const patterns = [
    /^[ \t]*(?:import|export)\b(?:(?!["'`])[\s\S])*?\bfrom\s*["']([^"']+)["']/gm,
    /^[ \t]*import\s+["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) add(m[1]);
  }
  return found;
}

function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..";
}

function resolveLocal(fromFile: string, spec: string, io: ImportGraphIo): string | null {
  const base = isAbsolute(spec) ? spec : resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  for (const c of candidates) {
    if (io.exists(c)) return c;
  }
  return null;
}

function insideRoots(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const r = root.endsWith(sep) ? root : root + sep;
    return path === root || path.startsWith(r);
  });
}

export interface WalkOptions {
  /** Directories whose files count as local. Absolute paths. */
  localRoots: string[];
  io: ImportGraphIo;
}

/**
 * Walk from `entry` and report what the graph reaches.
 *
 * A file that cannot be read is reported as an unresolved edge from itself rather
 * than throwing, so one bad path never hides the rest of the graph, and a caller
 * asserting "no foreign edges" still fails.
 */
export function walkImportGraph(entry: string, opts: WalkOptions): ImportGraph {
  const seen = new Set<string>();
  const foreign: ForeignEdge[] = [];
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    let src: string;
    try {
      src = opts.io.readFile(file);
    } catch (err) {
      foreign.push({
        from: file,
        specifier: file,
        reason: "unresolved",
      });
      void err;
      continue;
    }

    for (const spec of importSpecifiers(src)) {
      if (spec.startsWith("node:") || NODE_BUILTINS.has(spec)) continue;
      if (spec.startsWith("@/") || spec.startsWith("~/")) {
        foreign.push({ from: file, specifier: spec, reason: "alias" });
        continue;
      }
      if (!isRelative(spec) && !isAbsolute(spec)) {
        foreign.push({ from: file, specifier: spec, reason: "package" });
        continue;
      }
      const resolved = resolveLocal(file, spec, opts.io);
      if (!resolved) {
        foreign.push({ from: file, specifier: spec, reason: "unresolved" });
        continue;
      }
      if (!insideRoots(resolved, opts.localRoots)) {
        foreign.push({ from: file, specifier: spec, reason: "outside-local-roots" });
        continue;
      }
      queue.push(resolved);
    }
  }

  const order = (e: ForeignEdge): string => `${e.from}|${e.specifier}|${e.reason}`;
  return {
    entry,
    files: [...seen].sort(),
    foreign: foreign.sort((a, b) => order(a).localeCompare(order(b))),
  };
}

/** One line per foreign edge, for a failure message somebody has to act on. */
export function describeForeign(edges: ForeignEdge[], root: string): string {
  return edges
    .map((e) => {
      const from = e.from.startsWith(root) ? e.from.slice(root.length + 1) : e.from;
      return `  ${from} imports ${e.specifier} (${e.reason})`;
    })
    .join("\n");
}
