/**
 * The license check's decision, separated from the command that feeds it (#1051)
 * so it is unit testable and can be driven with a deliberately bad tree.
 *
 * A guard that has only ever been run against a clean dependency tree has never
 * been seen to fail, and is indistinguishable from one that returns "fine" no
 * matter what it is given (L1). Keeping the judgement pure is what lets
 * `test-licenses.ts` prove it catches a copyleft package before trusting it on
 * the real one.
 */

/** The shape `pnpm licenses list --json` emits: license id to packages. */
export interface LicenseReport {
  [license: string]: { name: string; versions?: string[] }[];
}

/**
 * One assessed exception, covering one or more EXACT package names.
 *
 * Several names, because a platform specific optional dependency resolves to a
 * different package per operating system: sharp's libvips binary is
 * `darwin-arm64` on a developer Mac and `linux-x64` in CI, and those are one
 * decision rather than three. Listing them as separate exceptions would make the
 * staleness check report the other platforms' entries on every machine.
 *
 * Exact names, never prefixes: an exception matching by prefix would silently
 * cover a package nobody assessed.
 */
export interface LicenseException {
  packages: string[];
  reason: string;
}

export interface LicensePolicy {
  /** License ids that need no thought. */
  allowed: string[];
  exceptions: LicenseException[];
}

export interface LicenseViolation {
  name: string;
  license: string;
  versions: string[];
}

/**
 * Whether one license field satisfies the allowlist.
 *
 * npm license fields are SPDX EXPRESSIONS, not ids: `(MIT OR Apache-2.0)` is
 * common and is satisfied by either side, because the consumer chooses. An `AND`
 * binds us to both, so every part has to be allowed. Reading the whole string as
 * one id would reject a dual licensed package we are entitled to use under MIT,
 * which trains people to widen the allowlist for the wrong reason.
 */
export function licenseAllowed(expression: string, allowed: string[]): boolean {
  const clean = expression.replace(/[()]/g, " ").trim();
  if (!clean) return false;
  const ok = (id: string) => allowed.some((a) => a.toLowerCase() === id.toLowerCase());
  // The detector and the splitter MUST be the same pattern, and both must require
  // whitespace around the operator. A word boundary alone treats the "or" inside
  // `LGPL-3.0-or-later` as an operator, because a hyphen is a word boundary: the
  // test then matches, the split does not, and the function recurses on itself
  // forever. That is not hypothetical, it is what the real tree did on the first
  // run of this guard.
  const OR = /\s+OR\s+/i;
  const AND = /\s+AND\s+/i;
  if (OR.test(clean)) {
    return clean.split(OR).some((part) => licenseAllowed(part, allowed));
  }
  if (AND.test(clean)) {
    return clean.split(AND).every((part) => licenseAllowed(part, allowed));
  }
  // A trailing `+` (GPL-2.0+) is "this version or later" and does not change the
  // family, so it is stripped rather than treated as an unknown id.
  return ok(clean.replace(/\+$/, ""));
}

/**
 * Every production package whose license is neither allowed nor excepted.
 *
 * Returns the packages, not a count, because a count tells whoever is blocked
 * nothing about what to do next (L16: a count and the rows it promises come from
 * one predicate).
 */
export function licenseViolations(
  report: LicenseReport,
  policy: LicensePolicy,
): LicenseViolation[] {
  const out: LicenseViolation[] = [];
  for (const [license, packages] of Object.entries(report)) {
    if (licenseAllowed(license, policy.allowed)) continue;
    for (const pkg of packages ?? []) {
      if (policy.exceptions.some((e) => e.packages.includes(pkg.name))) continue;
      out.push({ name: pkg.name, license, versions: pkg.versions ?? [] });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Exceptions that no longer match anything in the tree.
 *
 * A stale exception is not harmless: it is a standing permission for a license
 * nobody has assessed recently, and it reads to the next person as evidence that
 * somebody thought about it. Reported so an exception has to be removed when the
 * dependency that earned it goes away (the same reasoning as the alert catalog's
 * rule that no entry may name a key nothing sends).
 */
export function unusedExceptions(report: LicenseReport, policy: LicensePolicy): string[] {
  const present = new Set<string>();
  for (const packages of Object.values(report)) {
    for (const pkg of packages ?? []) present.add(pkg.name);
  }
  // An exception is stale only when NONE of its packages is in the tree. Judging
  // each name on its own would flag the other platforms' variants on every
  // machine, and a check that cries wolf on every run is one nobody reads (L36).
  return policy.exceptions
    .filter((e) => !e.packages.some((name) => present.has(name)))
    .map((e) => e.packages.join(", "))
    .sort();
}
