/**
 * A `pnpm/action-setup` step that names no version (#2261).
 *
 * The action resolves its version from, in order: the step's own `version:`, a
 * `packageManager` key in package.json, or `devEngines.packageManager`. Slate has
 * none of the last two, so an unpinned step fails immediately with "No pnpm
 * version is specified" and takes its whole job with it, BEFORE anything the job
 * was written to do.
 *
 * `loadtest.yml` shipped with ten of them and nobody could see it: the workflow is
 * `workflow_dispatch` only, so its first execution was the first time any of those
 * jobs had ever started, and every one of them died in setup. A workflow nothing
 * runs is a workflow nothing checks.
 *
 * This is the class, not the instance (L30), and it points at the whole directory
 * rather than the one file (L313's shape): a guard scoped to the file it was
 * written for passes forever while the defect sits next door.
 */
export interface UnpinnedPnpmSetup {
  file: string;
  line: number;
}

/**
 * Steps that use the action without a version, given each workflow's text.
 *
 * `packageManagerPinned` is whether package.json carries a `packageManager` (or
 * `devEngines.packageManager`) key, which would make every step resolvable without
 * its own `version:`. When it does, nothing is reported: the guard is about
 * whether the version can be RESOLVED, not about where it is written.
 */
export function unpinnedPnpmSetups(
  files: { name: string; yaml: string }[],
  packageManagerPinned: boolean,
): UnpinnedPnpmSetup[] {
  if (packageManagerPinned) return [];
  const out: UnpinnedPnpmSetup[] = [];
  for (const f of files) {
    const lines = f.yaml.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // The step itself, not prose about it: two workflows explain in comments why
      // they deliberately carry no install at all, and a comment is not a step.
      if (!/^\s*-\s+uses:\s*pnpm\/action-setup@/.test(line)) continue;
      const indent = line.match(/^\s*/)![0].length;
      // Look for this step's own `with:` block, which is any deeper-indented line
      // before the next step at the same depth.
      let pinned = false;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.trim() === "") continue;
        const nextIndent = next.match(/^\s*/)![0].length;
        if (nextIndent <= indent) break;
        if (/^\s*version:\s*\S/.test(next)) {
          pinned = true;
          break;
        }
      }
      if (!pinned) out.push({ file: f.name, line: i + 1 });
    }
  }
  return out;
}

/** Whether package.json resolves pnpm's version for every step at once. */
export function packageManagerPinned(packageJson: string): boolean {
  try {
    const pkg = JSON.parse(packageJson) as {
      packageManager?: unknown;
      devEngines?: { packageManager?: unknown };
    };
    if (typeof pkg.packageManager === "string" && pkg.packageManager.trim() !== "") return true;
    return pkg.devEngines?.packageManager !== undefined;
  } catch {
    // An unreadable package.json is not evidence that the version resolves. Fail
    // toward reporting, so the guard is loud rather than absent (L98).
    return false;
  }
}
