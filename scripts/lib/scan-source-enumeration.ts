// Scan logic for the shared enumeration guard (#2421), beside its test so it is
// unit testable with positive controls.
//
// The rule: a `scripts/test-*.ts` that builds its subject list by asking git for
// one must get it from `sourceFiles` (scripts/lib/source-files.ts), which refuses
// an empty or short listing instead of scanning nothing. A hand rolled
// `execFileSync("git", ["ls-files", ...])` has no floor, and a guard that scanned
// nothing prints the same clean sentence a guard over a clean tree prints (L98).
//
// The check is FILE level (enumerates from git AND references the helper), the
// same coarseness `scan-git-spawns.ts` accepts for the same reason: a suite that
// imports the shared helper is trusted to use it for its listing, and per call
// matching would be defeated by the first local wrapper.
//
// Blind to: a listing obtained some other way entirely (a `readdirSync` walk, a
// glob library, a shelled out `find`). Those carry no floor either, but they also
// carry no evidence of intent to enumerate the tree, and matching them would
// catch every suite that reads a directory for any reason. `test-prose-width.ts`
// held exactly such a walk and was converted rather than exempted.

/** A `git ls-files` call, however it was spawned. */
import { textHasOptOut } from "./opt-out.ts";

const GIT_ENUMERATION_RE =
  /(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(\s*["']git["']\s*,\s*\[[^\]]*["']ls-files["']/;

/** The opt-out, which must carry a reason or it decays into a magic word (L675). */
export function enumeratesFromGit(source: string): boolean {
  return GIT_ENUMERATION_RE.test(source);
}

export function usesSharedEnumeration(source: string): boolean {
  return /\bsourceFiles\s*\(/.test(source) && source.includes("source-files.ts");
}

/** File scoped: this rule is about the MODULE, so the marker may sit anywhere. */
export function hasReasonedOptOut(source: string): boolean {
  return textHasOptOut(source, "enumeration-ok:");
}

/** A reason string if `source` enumerates the tree with no floor, else null. */
export function handRolledEnumeration(name: string, source: string): string | null {
  if (!enumeratesFromGit(source)) return null;
  if (usesSharedEnumeration(source)) return null;
  if (hasReasonedOptOut(source)) return null;
  return (
    `${name} builds its subject list with its own \`git ls-files\` and never checks the ` +
    `list is non empty. Route it through \`sourceFiles\` (scripts/lib/source-files.ts), which ` +
    `refuses a listing it cannot believe, or carry \`// enumeration-ok: <why>\` (#2421).`
  );
}
