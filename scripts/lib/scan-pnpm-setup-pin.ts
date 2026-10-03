/**
 * Where pnpm's version comes from, for CI and for every laptop (#2261, #3128).
 *
 * `pnpm/action-setup` resolves its version from, in order: the step's own
 * `version:`, a `packageManager` key in package.json, or `devEngines.packageManager`.
 * Until #3128 Slate had neither key, so every step carried `version: 10`, which
 * resolves to whatever the newest 10.x is on the day the job runs. A laptop keeps
 * the pnpm it was installed with, so the minor that resolves the lockfile drifted
 * between CI and the machines writing it, with nothing to say so.
 *
 * So the version now lives in ONE place, an exact `packageManager: pnpm@X.Y.Z`,
 * which the action reads and pnpm itself honours locally (pnpm 10 switches to the
 * pinned version on its own). A step that ALSO names a version is a second place to
 * keep in step, and the action refuses a step whose version disagrees with the key,
 * which would take its whole job down in setup.
 *
 * The scan points at the whole workflow directory rather than one file (L313's
 * shape): `loadtest.yml` shipped ten steps nobody had run (#2261), and a guard
 * scoped to the file it was written for passes while the defect sits next door.
 */
export interface PnpmSetupStep {
  file: string;
  line: number;
}

/** The step lines that use the action, given each workflow's text. */
function pnpmSetupSteps(files: { name: string; yaml: string }[]): {
  file: string;
  line: number;
  ownVersion: boolean;
}[] {
  const out: { file: string; line: number; ownVersion: boolean }[] = [];
  for (const f of files) {
    const lines = f.yaml.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // The step itself, not prose about it: two workflows explain in comments why
      // they deliberately carry no install at all, and a comment is not a step.
      if (!/^\s*-\s+uses:\s*pnpm\/action-setup@/.test(line)) continue;
      const indent = line.match(/^\s*/)![0].length;
      // This step's own `with:` block is any deeper-indented line before the next
      // step at the same depth. A later step's `node-version:` is not this step's.
      let ownVersion = false;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.trim() === "") continue;
        const nextIndent = next.match(/^\s*/)![0].length;
        if (nextIndent <= indent) break;
        if (/^\s*version:\s*\S/.test(next)) {
          ownVersion = true;
          break;
        }
      }
      out.push({ file: f.name, line: i + 1, ownVersion });
    }
  }
  return out;
}

/** Every action-setup step in the given workflows. */
export function allPnpmSetups(files: { name: string; yaml: string }[]): PnpmSetupStep[] {
  return pnpmSetupSteps(files).map(({ file, line }) => ({ file, line }));
}

/** Steps carrying a `version:` of their own, which the packageManager key replaces. */
export function pnpmSetupsNamingAVersion(
  files: { name: string; yaml: string }[],
): PnpmSetupStep[] {
  return pnpmSetupSteps(files)
    .filter((s) => s.ownVersion)
    .map(({ file, line }) => ({ file, line }));
}

export type PnpmPin =
  | { ok: true; version: string }
  | { ok: false; reason: "unreadable" | "absent" | "not-pnpm" | "not-exact"; got?: string };

/**
 * Whether package.json pins pnpm to ONE exact release.
 *
 * `pnpm@10` or a range is refused as `not-exact`: it is the drift this exists to
 * end, written in a different place. The optional `+sha...` integrity suffix
 * corepack writes is accepted, since it pins harder rather than looser.
 */
export function exactPnpmPin(packageJson: string): PnpmPin {
  let pkg: { packageManager?: unknown };
  try {
    pkg = JSON.parse(packageJson) as { packageManager?: unknown };
  } catch {
    // An unreadable package.json is not evidence of a pin. Report rather than go
    // quiet (L98).
    return { ok: false, reason: "unreadable" };
  }
  const pm = pkg.packageManager;
  if (typeof pm !== "string" || pm.trim() === "") return { ok: false, reason: "absent" };
  const m = pm.match(/^([a-z]+)@(.+)$/);
  if (!m || m[1] !== "pnpm") return { ok: false, reason: "not-pnpm", got: pm };
  if (!/^\d+\.\d+\.\d+(\+sha\d+\.[0-9a-f]+)?$/.test(m[2]!)) {
    return { ok: false, reason: "not-exact", got: pm };
  }
  return { ok: true, version: m[2]!.split("+")[0]! };
}
