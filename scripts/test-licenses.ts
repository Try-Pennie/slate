/**
 * No copyleft license reaches the production dependency tree unnoticed (#1051).
 *
 * From the 2026-07-23 production readiness audit: the prod tree is MIT, Apache,
 * BSD, ISC and CC-BY, plus one LGPL prebuilt image binary, and nothing checked
 * it. A future dependency (or a relicensed existing one) could pull a copyleft
 * obligation in with no signal at all, and the first anyone would hear of it is
 * from outside the company.
 *
 * The judgement lives in `scripts/lib/scan-licenses.ts` so it can be driven with
 * a deliberately bad tree. That matters more here than usual: this guard runs
 * against a tree that is currently CLEAN, so on the real data it passes on its
 * first run and would pass just as happily if it were broken. The positive
 * controls below are the only thing separating it from a guard that returns
 * "fine" unconditionally (L1).
 *
 * Reads `pnpm licenses list --prod --json`, which resolves from the lockfile and
 * the installed tree, so it needs no network and takes about 0.2s.
 *
 * ## No SBOM, deliberately (#1051)
 *
 * An SBOM exists so a DOWNSTREAM consumer can audit what you shipped them. Slate
 * is a private single org application with no downstream consumers, so generating
 * one would produce a file nobody reads and a job that can fail, which is cost
 * with no reader. Revisit if that changes: a customer or an insurer asking for
 * one, or Slate being distributed to anyone outside Pennie. The lockfile plus
 * this check already answer "what is in the tree and is it safe to use", which is
 * the question the SBOM would have been generated to answer internally.
 *
 * Run: node --experimental-strip-types scripts/test-licenses.ts
 */
import { execFileSync } from "node:child_process";
import {
  licenseAllowed,
  licenseViolations,
  unusedExceptions,
  type LicenseReport,
  type LicensePolicy,
} from "./lib/scan-licenses.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/**
 * The policy.
 *
 * The allowlist is deliberately the licenses actually present plus their close
 * permissive relatives, NOT "anything that looks permissive". A license nobody
 * has seen before should stop a build and get thirty seconds of thought, in the
 * same way a new database table defaults to guarded rather than exempt.
 */
const POLICY: LicensePolicy = {
  allowed: [
    "MIT",
    "MIT-0",
    "ISC",
    "0BSD",
    "BSD",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "CC0-1.0",
    "CC-BY-4.0",
    "Unlicense",
    "BlueOak-1.0.0",
  ],
  exceptions: [
    {
      // LGPL-3.0-or-later. A prebuilt libvips binary that sharp uses for image
      // work on the machine doing the build.
      //
      // VERIFIED 2026-08-13 that it does not ship: in `.open-next`, the deploy
      // artifact, the sharp package directory contains zero files and no
      // `@img/*` libvips package is present at all, so nothing LGPL reaches the
      // Worker that actually serves traffic. The exception is about what we
      // DISTRIBUTE, and the whole reason it is safe is that we distribute none
      // of it. Re-check if the deploy pipeline changes how it bundles native
      // dependencies.
      //
      // One exception with several names rather than several exceptions: sharp
      // resolves a different binary per platform, so a Mac and CI see different
      // members of this list and neither is stale.
      packages: [
        "@img/sharp-libvips-darwin-arm64",
        "@img/sharp-libvips-darwin-x64",
        "@img/sharp-libvips-linux-x64",
        "@img/sharp-libvips-linux-arm64",
        "@img/sharp-libvips-linuxmusl-x64",
        "@img/sharp-libvips-linuxmusl-arm64",
      ],
      reason: "prebuilt libvips, used on the build machine only, absent from the deploy artifact",
    },
  ],
};

function readReport(): LicenseReport {
  const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw) as LicenseReport;
}

// --- the real tree ------------------------------------------------------------

const report = readReport();

// Finding nothing is not a pass (L98). An empty report is what a failed or
// changed command looks like, and it would clear every assertion below.
{
  const packages = Object.values(report).flatMap((p) => p ?? []).length;
  assert(packages > 0, `read the production license report (${packages} packages)`);
}

{
  const violations = licenseViolations(report, POLICY);
  eq(
    violations.map((v) => `${v.name} (${v.license})`),
    [],
    "every production dependency is permissively licensed, or carries an assessed exception",
  );
}

{
  const stale = unusedExceptions(report, POLICY);
  eq(
    stale,
    [],
    "no license exception outlives the dependency that earned it, because a stale one reads " +
      "as an assessment somebody made rather than as a permission nobody has revisited",
  );
}

// --- positive controls --------------------------------------------------------
//
// The real tree is clean, so everything above passes on its first run and would
// pass just as happily over a broken scan. These are what make it a guard.

{
  const copyleft: LicenseReport = {
    MIT: [{ name: "fine-package", versions: ["1.0.0"] }],
    "GPL-3.0": [{ name: "viral-package", versions: ["2.0.0"] }],
  };
  const caught = licenseViolations(copyleft, POLICY);
  eq(caught.length, 1, "a GPL dependency IS caught");
  eq(caught[0]?.name, "viral-package", "the offending package is named, not just counted");
}

{
  // The exception must be exact. A prefix match would silently cover a package
  // nobody assessed, which is the failure mode of every allowlist that got lazy.
  const lookalike: LicenseReport = {
    "LGPL-3.0-or-later": [{ name: "@img/sharp-libvips-darwin-arm64-EVIL", versions: ["1.0.0"] }],
  };
  eq(
    licenseViolations(lookalike, POLICY).length,
    1,
    "a package whose name merely STARTS with an excepted one is still caught",
  );
}

{
  // And the excepted package itself really is let through, or the exception is
  // doing nothing and the real tree is passing for the wrong reason.
  const excepted: LicenseReport = {
    "LGPL-3.0-or-later": [{ name: "@img/sharp-libvips-darwin-arm64", versions: ["1.2.3"] }],
  };
  eq(licenseViolations(excepted, POLICY).length, 0, "the assessed exception IS honoured");
}

// SPDX expressions, because a dual licensed package we may legitimately use under
// MIT must not be rejected: that teaches people to widen the allowlist to make a
// build pass, which is how a real copyleft eventually gets waved through.
{
  assert(licenseAllowed("(MIT OR Apache-2.0)", POLICY.allowed), "an OR expression passes on either side");
  assert(licenseAllowed("MIT AND ISC", POLICY.allowed), "an AND expression passes when every part is allowed");
  assert(!licenseAllowed("MIT AND GPL-3.0", POLICY.allowed), "an AND expression fails when any part is not");
  assert(!licenseAllowed("(GPL-2.0 OR LGPL-3.0)", POLICY.allowed), "an OR of two refused licenses fails");
  assert(!licenseAllowed("GPL-2.0+", POLICY.allowed), "a version-or-later suffix does not smuggle a family through");
  assert(!licenseAllowed("", POLICY.allowed), "an empty license field is refused rather than ignored");
}

finish();
