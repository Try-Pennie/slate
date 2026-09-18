// Find a hand written booker button class string (#2562).
//
// The shape is a composite, deliberately: `inline-flex` alone is on every row of
// icons in the app, and `font-semibold` is on half the headings. What makes a
// string the BOOKER BUTTON string is all five of these together, which is what
// the twelve converted sites had and what nothing else on the surface has:
//
//   inline-flex      it is laid out as a row
//   justify-center   its label is centred, so it is a box rather than a link
//   min-h-*          it reserves a touch target
//   px-*             it has horizontal padding of its own
//   font-semibold    it is a control's label
//
// Measured against the tree before it was written: the five together matched the
// twelve sites the issue names and nothing else on the booker surface. The text
// trigger (`min-h-9`, no `justify-center`), the times panel's chip retry (no
// `font-semibold`) and the toggle group container (no `min-h`, no `px`) each
// miss it, which is correct: none of them is the button this component owns.
//
// The IO is injected so the guard can drive this against fixtures and against an
// OVERLAY of the real tree, one file's content replaced in memory, which is how
// its positive control plants a hand written copy without writing to the repo.
import { dirname, join, normalize } from "node:path";

export interface BookerFilesIo {
  /** Read a file's source. Throws (like node:fs) when it is not there. */
  readFile(path: string): string;
  /** Whether a path exists as a readable file. */
  exists(path: string): boolean;
}

export interface HandWrittenButton {
  /** The file the string was written in, as the walk names it. */
  file: string;
  /** The class string itself, so a finding can be read without opening the file. */
  classes: string;
}

/** The five tokens that together make a string the booker's button class. */
const REQUIRED: ReadonlyArray<(token: string) => boolean> = [
  (t) => t === "inline-flex",
  (t) => t === "justify-center",
  (t) => t.startsWith("min-h-"),
  (t) => t.startsWith("px-"),
  (t) => t === "font-semibold",
];

/**
 * Whether this string is a hand written booker button class string.
 *
 * Interpolations are blanked rather than dropped, so `${a}px-5` cannot fuse into
 * a token that was never written, and a palette expression contributes nothing.
 */
export function isButtonClassString(text: string): boolean {
  const tokens = text.replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean);
  return REQUIRED.every((matches) => tokens.some(matches));
}

/**
 * Every class string in a source file, ANCHORED on `inline-flex`.
 *
 * Reading every quoted run in a `.tsx` and calling each one a string does not
 * work, and the way it fails is silent: an apostrophe in a prose comment ("the
 * booker's theme") opens a region that runs to the next apostrophe hundreds of
 * lines away, so one finding swallows a page of unrelated source and a real one
 * either side of it disappears. JSX text carries apostrophes too, and there is
 * no delimiter there to balance.
 *
 * So the anchor is the token itself. `inline-flex` is one of the five this hunts
 * for, it appears only inside a class string, and the delimiter immediately
 * before it is that string's opener. From there the walk skips whole `${...}`
 * spans, so an interpolation carrying its own quotes cannot end the capture
 * early and cost the string its later tokens.
 */
function classStrings(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<number>();
  for (const m of source.matchAll(/inline-flex/g)) {
    const at = m.index;
    let open = -1;
    for (let i = at - 1; i >= 0; i--) {
      const ch = source[i];
      if (ch === '"' || ch === "'" || ch === "`") { open = i; break; }
      // Only class tokens, whitespace and interpolations may sit between the
      // opener and the anchor. Anything else (a `=`, a `;`, a `,`) says this
      // `inline-flex` is not inside a literal, so there is nothing to capture.
      if (!/[-\w\s:/[\]().%#&+*>!${}]/.test(ch)) break;
    }
    if (open < 0 || seen.has(open)) continue;
    seen.add(open);
    const delim = source[open];
    let text = "";
    for (let i = open + 1; i < source.length; i++) {
      if (source[i] === delim) break;
      if (source[i] === "$" && source[i + 1] === "{") {
        let depth = 1;
        i += 2;
        for (; i < source.length && depth > 0; i++) {
          if (source[i] === "{") depth++;
          else if (source[i] === "}") depth--;
        }
        text += " ";
        i--;
        continue;
      }
      text += source[i];
    }
    out.push(text);
  }
  return out;
}

/** Every import specifier in a source file, `import` and `export ... from` alike. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

const EXTENSIONS = [".tsx", ".ts", "/index.tsx", "/index.ts"];

/** Resolve a specifier to a file inside `src/`, or null when it leaves it. */
function resolveLocal(spec: string, from: string, io: BookerFilesIo): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join("src", spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = join(dirname(from), spec);
  else return null; // a package: it is not ours to scan

  const candidate = normalize(base);
  if (!candidate.startsWith(`src${"/"}`)) return null;
  if (io.exists(candidate) && /\.(tsx?|mts)$/.test(candidate)) return candidate;
  for (const ext of EXTENSIONS) {
    const withExt = `${candidate}${ext}`;
    if (io.exists(withExt)) return withExt;
  }
  return null;
}

/**
 * The booker surface: every file reachable from the entry by an import that
 * resolves inside `src/`, sorted, the entry included.
 *
 * Test files are excluded, because a test may legitimately assert on the class
 * string it expects a component to render.
 */
export function bookerSurfaceFiles(entry: string, io: BookerFilesIo): string[] {
  const seen = new Set<string>();
  const queue = [normalize(entry)];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    // Deliberately UNGUARDED. Every path here either is the entry or was
    // confirmed to exist by `resolveLocal`, so a read that throws means the walk
    // covered less of the booker than it is about to report, and a caught one
    // would make that indistinguishable from a surface with nothing in it (L98).
    const source = io.readFile(file);
    for (const spec of importSpecifiers(source)) {
      const next = resolveLocal(spec, file, io);
      if (next && !seen.has(next) && !/\.test\.tsx?$/.test(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

/**
 * The hand written button class strings in the files given.
 *
 * `booker-button.ts` and `BookerButton.tsx` are the one place the string is
 * allowed to live, so they are the only exemption, and it is written as the
 * reason for exempting rather than as a path that happens to be there (L362).
 */
export function handWrittenBookerButtons(
  files: string[],
  io: BookerFilesIo,
): HandWrittenButton[] {
  const out: HandWrittenButton[] = [];
  for (const file of files) {
    if (/\/booker-button\.ts$|\/BookerButton\.tsx$/.test(file)) continue; // the owner
    // Unguarded for the same reason as the walk: a file skipped because it could
    // not be read is a file EXEMPT from the guard, and it reports as a clean one.
    const source = io.readFile(file);
    for (const text of classStrings(source)) {
      if (isButtonClassString(text)) out.push({ file, classes: text.trim() });
    }
  }
  return out;
}
