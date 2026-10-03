// Scans that keep every staff photo going through one resolver and keep image
// bytes off every read that does not serve them (#3027), plus two (3 and 4, at
// the bottom) that keep "who the refresh covers" one definition (#3161). Driven by
// scripts/test-advisor-photo-reads.ts.
//
// 1. RAW AVATAR READS. `users.avatar_url` is the photo Google gave at sign in. It is
//    a FALLBACK the resolver applies while the directory has not been read, never a
//    picture a surface may draw on its own: a measured "no photo" must hide it
//    (Dan, 2026-10-02). So the name may appear, outside comments, only where it is
//    written (sign in provisioning, and the auth callback reading Google's own
//    metadata key), declared (the row type), or resolved (the advisor photo module
//    and the manage page's reader of it). Anywhere else is a surface reading the
//    column raw, which is the shape #3027 removed from five places.
//
// 2. IMAGE BYTES. `advisor_photos` holds 2 to 20 KB per row. Every read of it lives
//    in `src/lib/advisor-photos/store.ts`, and only that file's two serving readers
//    may select the bytes. A `select("*")` or an embed of the table (a PostgREST
//    `advisor_photos(...)` inside another table's select) is refused everywhere,
//    because it drags every image along with whatever it was really after.

export interface SourceFile {
  path: string;
  text: string;
}

/** Files allowed to name `avatar_url`, each with the reason. */
export const AVATAR_ALLOWED: Record<string, string> = {
  "src/lib/provision.ts": "writes the sign in photo",
  "src/app/api/auth/callback/route.ts": "reads Google's own user metadata key of the same name",
  "src/lib/db/types.ts": "declares the column",
  "src/lib/booking/advisor-photo.ts": "the manage page's reader, which hands it to the resolver",
};
/** The resolver module itself. */
export const AVATAR_ALLOWED_DIR = "src/lib/advisor-photos/";

/** The functions in store.ts that may select image bytes. */
export const BYTE_READERS = ["loadServedPhoto", "loadCardPhotoRows"];
export const STORE_PATH = "src/lib/advisor-photos/store.ts";

/** Remove line and block comments, keeping line numbers. */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

export function scanRawAvatarReads(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.path in AVATAR_ALLOWED || f.path.startsWith(AVATAR_ALLOWED_DIR)) continue;
    const code = stripComments(f.text);
    for (const m of code.matchAll(/avatar_url/g)) out.push(`${f.path}:${lineOf(code, m.index!)}`);
  }
  return out;
}

/** The body of a named exported function in `text`, by brace matching. */
function functionBodies(text: string): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)) {
    // The body's brace is the first one that ends its line; an object type in the
    // signature (`Promise<{ base64: string }>`) carries its fields on the same line.
    const bodyOpen = /\{[ \t]*\n/.exec(text.slice(m.index!));
    if (!bodyOpen) continue;
    const open = m.index! + bodyOpen.index;
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) break;
    }
    out.push({ name: m[1]!, start: m.index!, end: i });
  }
  return out;
}

export function scanPhotoTableReads(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const code = stripComments(f.text);
    // An embed of the table inside another select, in any file.
    for (const m of code.matchAll(/["'`][^"'`]*\badvisor_photos\s*(?:!inner)?\s*\(/g)) {
      out.push(`${f.path}:${lineOf(code, m.index!)} embeds advisor_photos in another table's select`);
    }
    const reads = [...code.matchAll(/\.from\(\s*["'`]advisor_photos["'`]\s*\)/g)];
    if (reads.length === 0) continue;
    if (f.path !== STORE_PATH) {
      for (const m of reads) out.push(`${f.path}:${lineOf(code, m.index!)} reads advisor_photos outside ${STORE_PATH}`);
      continue;
    }
    const bodies = functionBodies(code);
    for (const m of reads) {
      const tail = code.slice(m.index!, code.indexOf(";", m.index!) + 1);
      const select = /\.select\(\s*["'`]([^"'`]*)["'`]/.exec(tail)?.[1];
      if (select === undefined) continue;
      const wide = select.trim() === "*" || /\bbytes_b64\b/.test(select);
      if (!wide) continue;
      const owner = bodies.find((b) => b.start < m.index! && m.index! < b.end)?.name ?? "(top level)";
      if (select.trim() === "*") out.push(`${f.path}:${lineOf(code, m.index!)} selects * from advisor_photos in ${owner}`);
      else if (!BYTE_READERS.includes(owner)) out.push(`${f.path}:${lineOf(code, m.index!)} selects image bytes in ${owner}, which does not serve them`);
    }
  }
  return out;
}

/** Where who the refresh covers, and who is still waiting for it, are defined (#3161). */
export const RESOLVE_PATH = "src/lib/advisor-photos/resolve.ts";

/**
 * 3. WHO IS NOT READ YET (#3161). `never-read` alone means "no record", which a
 *    deactivated person has for ever, since the refresh never reads them. The
 *    roster banner counted them and named a gap the Refresh button could not
 *    close. So the state is judged only inside the resolver, where
 *    `awaitingFirstRead` pairs it with `photoRefreshCovers`; any other comparison
 *    against it is a reader that can say "not read yet" about somebody who never
 *    will be. File level, so a comparison is caught wherever it sits.
 */
export function scanNeverReadJudges(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.path === RESOLVE_PATH) continue;
    const code = stripComments(f.text);
    const re = /(?:===|!==|==|!=)\s*["'`]never-read["'`]|["'`]never-read["'`]\s*(?:===|!==|==|!=)|\bcase\s+["'`]never-read["'`]/g;
    for (const m of code.matchAll(re)) {
      out.push(`${f.path}:${lineOf(code, m.index!)} judges never-read itself; use awaitingFirstRead`);
    }
  }
  return out;
}

/**
 * 4. ONE DEFINITION OF WHO THE REFRESH COVERS (#3161, L16). Inside the advisor
 *    photo module, a comparison of `deactivated_at` against null, or a call to
 *    the roster's `isActive`, is a second definition beside `photoRefreshCovers`,
 *    and the two drift silently. Allowed only in the resolver, where the one
 *    definition lives. A PostgREST `.is(..., null)` filter is a query, not a
 *    predicate, and is not matched.
 */
export function scanRefreshCoverageDefinitions(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!f.path.startsWith(AVATAR_ALLOWED_DIR) || f.path === RESOLVE_PATH) continue;
    const code = stripComments(f.text);
    const re = /\bdeactivated_at\s*(?:===|!==|==|!=)|(?:===|!==|==|!=)\s*[\w.?]*\bdeactivated_at\b|\bisActive\s*\(/g;
    for (const m of code.matchAll(re)) {
      out.push(`${f.path}:${lineOf(code, m.index!)} decides who the refresh covers itself; use photoRefreshCovers`);
    }
  }
  return out;
}
