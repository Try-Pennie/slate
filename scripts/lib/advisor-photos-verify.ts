// The decision half of `pnpm verify:advisor-photos` (#3027): which exit code a dry
// run's outcome earns. Pure, so every code is produced offline by
// scripts/test-advisor-photos-verify.ts.
//
// Finding nothing is never a pass (L98): only a run that read the directory, read
// at least one photo, and would apply with nothing held for a person exits 0.
import type { RefreshOutcome } from "../../src/lib/advisor-photos/refresh.ts";

export const VERIFY_EXIT = {
  ok: 0,
  noSubject: 1,
  slateUnreadable: 2,
  subjectRefused: 3,
  directoryUnreadable: 4,
  nothingRead: 5,
  flipGuard: 10,
  repeatedImage: 11,
  notInDirectory: 12,
  failures: 13,
} as const;

export function verifyExitCode(outcome: RefreshOutcome): number {
  if (outcome.status === "refused") {
    switch (outcome.why) {
      case "no-subject":
        return VERIFY_EXIT.noSubject;
      case "slate-unreadable":
        return VERIFY_EXIT.slateUnreadable;
      case "subject-refused":
        return VERIFY_EXIT.subjectRefused;
      case "directory-unreadable":
        return VERIFY_EXIT.directoryUnreadable;
      case "nothing-read":
      case "unknown-user":
        return VERIFY_EXIT.nothingRead;
    }
  }
  const plan = outcome.plan;
  if (plan.flipGuardTripped) return VERIFY_EXIT.flipGuard;
  if (plan.repeated.length) return VERIFY_EXIT.repeatedImage;
  if (plan.notInDirectory.length) return VERIFY_EXIT.notInDirectory;
  if (plan.counts.failed) return VERIFY_EXIT.failures;
  return VERIFY_EXIT.ok;
}

/** The lines the command prints: counts, then every name a person has to look at. */
export function verifyReport(outcome: RefreshOutcome): string[] {
  if (outcome.status === "refused") return [`REFUSED (${outcome.why}): ${outcome.detail}`];
  const c = outcome.plan.counts;
  const p = outcome.plan;
  const lines = [
    `read ${c.attempted} active people: ${c.photo} photo, ${c.none} none (${c.placeholder} of them Google's known placeholder), ${c.notInDirectory} not in the directory, ${c.failed} failed`,
    `a real run would: gain ${c.gained}, change ${c.changed}, lose ${c.lost}, leave ${c.unchanged} unchanged, delete ${c.deleted} departed rows`,
  ];
  if (p.flipGuardTripped) lines.push(`FLIP GUARD: would refuse every none write; losses held: ${p.heldNone.join(", ")}`);
  for (const r of p.repeated) lines.push(`REPEATED IMAGE ${r.sha256.slice(0, 12)}: held by ${r.holders.join(", ")}; not written for ${r.held.join(", ") || "anybody new"}`);
  if (p.notInDirectory.length) lines.push(`NOT IN DIRECTORY: ${p.notInDirectory.join(", ")}`);
  for (const f of p.failed) lines.push(`FAILED ${f.email}: ${f.last_error}`);
  for (const f of p.failedNeverRead) lines.push(`FAILED ${f.email} (never read): ${f.reason}`);
  return lines;
}
