// Sweep orphaned smoke-test events off the smoketest@/smoketest2@ calendars (#524).
//
// The booking smoke test books and cancels real bookings on the two test
// mailboxes; per #166 a cancel can leave a lingering Google event, so those
// calendars accumulate orphaned busy blocks. The reschedule hot path reads
// availability LIVE from Google, so that clutter makes the lone test agent read
// busy and smoke runs flake. This deletes the stale smoke orphans. The smoke run
// also invokes this automatically on teardown (scripts/smoke-booking-api.ts); run
// it by hand to drain a backlog or after a run that crashed before teardown.
//
// Needs the Google service-account creds (GOOGLE_SA_CLIENT_EMAIL /
// GOOGLE_SA_PRIVATE_KEY) in .env.local / .dev.vars (the same domain-wide
// delegation the app uses). DRY RUN by default; pass --apply to actually delete.
//
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/cleanup-smoke-events.ts [--apply]
//
// Env overrides:
//   SMOKE_AGENT_A_EMAIL (default smoketest@trypennie.com)
//   SMOKE_AGENT_B_EMAIL (default smoketest2@trypennie.com)
//   SMOKE_CLEANUP_LOOKBACK_DAYS (default 90)
import { loadEnvFiles } from "./smoke-env.ts";
import { sweepMailboxes, type SweepResult } from "./lib/smoke-event-cleanup.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const apply = process.argv.includes("--apply");
const mailboxes = [
  process.env.SMOKE_AGENT_A_EMAIL ?? "smoketest@trypennie.com",
  process.env.SMOKE_AGENT_B_EMAIL ?? "smoketest2@trypennie.com",
];
const lookbackDays = Number(process.env.SMOKE_CLEANUP_LOOKBACK_DAYS ?? "90");

async function main(): Promise<void> {
  console.log(
    `Smoke event cleanup ${apply ? "(APPLY, deleting)" : "(dry run, pass --apply to delete)"}` +
      ` over ${mailboxes.join(", ")}, last ${lookbackDays} days`,
  );
  const results = await sweepMailboxes(mailboxes, { apply, lookbackDays });
  let total = 0;
  for (const r of results as SweepResult[]) {
    total += r.matched;
    const verb = r.dryRun ? "would delete" : "deleted";
    console.log(`  ${r.email}: ${verb} ${r.matched} stale smoke event(s)`);
    for (const id of r.deletedIds) console.log(`    - ${id}`);
  }
  console.log(
    apply
      ? `\nDone. Deleted ${total} orphaned smoke event(s).`
      : `\nDry run: ${total} orphaned smoke event(s) would be deleted. Re-run with --apply.`,
  );
}

main().catch((err) => {
  // Fail loud: a real Google error surfaces and exits non-zero rather than
  // silently reporting a clean sweep.
  console.error("Smoke event cleanup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
