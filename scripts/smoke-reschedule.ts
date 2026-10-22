// Post-deploy smoke for the crash-safe / concurrency-safe reschedule (#439).
// Validates the lease-pin reschedule against the REAL database + deployed code,
// isolated to the dedicated test agent (#396): it books a throwaway appointment
// in the SMOKE test bucket, reschedules it, then fires TWO different-target
// reschedules at once and asserts exactly one wins and the other gets the typed
// 409 conflict. Cleans up the booking at the end.
//
// It hits PRODUCTION (creates a real, then-cancelled booking on smoketest@'s
// calendar; the attendee is a plus-alias of that same mailbox). Run it manually:
//
//   BOOKING_API_KEY_CANARY=<key> node --experimental-strip-types \
//     --import ./scripts/register-paths.mjs scripts/smoke-reschedule.ts
//
// Optional env: SLATE_BASE_URL (default prod), SMOKE_BUCKET (default SMOKE).
//
// The run itself lives in scripts/lib/smoke-reschedule-run.ts (#4060), with its
// network and clock injected so a crash and the run after it are node-testable.

import { envOr } from "./smoke-env.ts";
import { jpost, slots, createChecker } from "./smoke-lib.ts";
import { rescheduleSmokeExitCode, runRescheduleSmoke } from "./lib/smoke-reschedule-run.ts";

// envOr, not `??`: the canary wires SLATE_BASE_URL from a repo Actions variable and
// `${{ vars.X }}` for an unset variable arrives as "" rather than undefined (#1494).
const BASE = envOr(process.env.SLATE_BASE_URL, "https://slate.trypennie.app").replace(/\/$/, "");
const KEY = process.env.BOOKING_API_KEY_CANARY ?? "";
// env-ok: SMOKE_BUCKET (a local override only; CI wants the seeded SMOKE bucket,
//   and wiring it would let an unset repo variable aim the run at bucket "")
const BUCKET = envOr(process.env.SMOKE_BUCKET, "SMOKE");

const { check, failed } = createChecker();

async function main(): Promise<void> {
  if (!KEY) {
    console.error("Set BOOKING_API_KEY_CANARY in the environment first.");
    process.exit(2);
  }
  console.log(`# reschedule smoke vs ${BASE} (bucket ${BUCKET})`);
  const outcome = await runRescheduleSmoke({ bucket: BUCKET, nonce: Date.now(), post: jpost, slots, check });
  const code = rescheduleSmokeExitCode(outcome, failed());
  if (outcome === "ran") console.log(code === 0 ? "\nSMOKE PASSED" : `\n${failed()} CHECK(S) FAILED`);
  process.exit(code);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
