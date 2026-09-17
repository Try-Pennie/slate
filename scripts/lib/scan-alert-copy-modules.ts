// Which modules the alert preview's copy comes from, read from the preview itself
// (#2502).
//
// `pnpm preview:alerts` proves it is deterministic by rendering twice and comparing,
// with a cache busting import so the second render really re-runs. That cannot see a
// builder reading the clock and never could: the clock does not move between two
// renders a millisecond apart, so the check reads clean over exactly the defect it
// is named for (L713). The booker preview learned this the expensive way in #2497,
// where `dayWord` read `DateTime.now()`, its test pinned the other end, the suite
// went red at midnight with no code change and main's deploy was skipped.
//
// The booker side answered it with a GLOB over its copy directory. The alert side
// cannot: its copy is spread across the monitoring tree, in `*/alert-copy.ts`,
// `lane-copy.ts`, and a few dozen `format*` builders that live beside the check they
// describe. A hand written list of those would be exempt from the guard the moment
// somebody added the next one (L96), so the list is DERIVED from what
// `src/lib/notify/alert-preview.ts` imports: the preview is by construction the one
// place that names every builder whose words reach Slack, because a builder it does
// not call renders nothing to preview.
//
// WHAT IT COVERS, and what it does not, said here so a green run is never read as
// more than it is (L400):
//
//   - DIRECT imports only, one hop from the preview. A module the preview does not
//     import is not scanned, and neither is one reached only through another.
//     Transitive coverage was weighed and declined: the graph reaches most of `src`
//     within three hops, and a guard that flags an unrelated runtime clock read
//     three modules away is one people switch off (L36).
//   - The WHOLE module, not just the exported builder. That is deliberate and it is
//     the half that matters: #2497's clock read was in `dayWord`, a local helper the
//     exported builder called, so a scan narrowed to the imported binding would have
//     missed the only instance this family has ever had.
//   - The four spellings `scanCopyClockReads` matches, as text. A clock reached
//     through an imported helper, through `Temporal`, or through an injected
//     collaborator is invisible to any single file scan.
//
// The IO is injected so the guard can drive it against an OVERLAY of the real tree
// (one real file's content replaced in memory), which is how its positive control
// plants a clock read without writing anything to the repo.
import { join } from "node:path";
import { scanCopyClockReads, type CopyClockFinding } from "./scan-copy-clock-reads.ts";

export interface AlertCopyIo {
  /** Read a file's source. Throws (like node:fs) when it is not there. */
  readFile(path: string): string;
  /** Whether a path exists as a readable file. */
  exists(path: string): boolean;
}

/** Repo relative, because every message this produces is read against a checkout. */
export const ALERT_PREVIEW = join("src", "lib", "notify", "alert-preview.ts");

/** `@/lib/x/y` as written in an import, in file order and deduplicated. */
export function aliasImportsOf(source: string): string[] {
  const seen = new Set<string>();
  for (const m of source.matchAll(/from\s+["'](@\/[^"']+)["']/g)) seen.add(m[1] as string);
  return [...seen];
}

/**
 * The repo relative file a `@/...` specifier resolves to, or null when nothing on
 * disk answers to it.
 *
 * A specifier that resolves to NOTHING is returned as null rather than guessed at,
 * and the caller reports the count, because a resolver that silently dropped what it
 * could not find would shrink the scanned set without saying so and every remaining
 * module would still report clean (L98).
 */
export function resolveAliasModule(spec: string, io: AlertCopyIo, root: string): string | null {
  const base = join("src", spec.replace(/^@\//, ""));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (io.exists(join(root, candidate))) return candidate;
  }
  return null;
}

export interface AlertCopyScan {
  /** Every module scanned, repo relative and sorted, the preview itself included. */
  modules: string[];
  /** Specifiers the preview imports that resolve to no file on disk. */
  unresolved: string[];
  findings: CopyClockFinding[];
}

/**
 * Every clock read in the preview and in the modules it imports its copy from.
 *
 * The preview is scanned alongside them rather than assumed innocent: it builds the
 * fixtures each builder is called with, so a date seeded from the clock there moves
 * every rendered message just as surely as one inside a builder.
 */
export function scanAlertCopyClockReads(root: string, io: AlertCopyIo): AlertCopyScan {
  const preview = io.readFile(join(root, ALERT_PREVIEW));
  const modules = [ALERT_PREVIEW];
  const unresolved: string[] = [];

  for (const spec of aliasImportsOf(preview)) {
    const rel = resolveAliasModule(spec, io, root);
    if (rel === null) unresolved.push(spec);
    else if (!modules.includes(rel)) modules.push(rel);
  }
  modules.sort();

  const findings: CopyClockFinding[] = [];
  for (const rel of modules) {
    findings.push(...scanCopyClockReads(io.readFile(join(root, rel)), rel));
  }
  return { modules, unresolved, findings };
}
