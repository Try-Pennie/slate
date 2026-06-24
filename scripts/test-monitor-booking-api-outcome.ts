// Pure format for the direct booking API outcome log line (#375): a stable,
// parseable structured line so Cloudflare Workers observability can tally
// outcomes (created/deduped/rescheduled/confirm_required/error) once the bot is
// live. Run: node --experimental-strip-types scripts/test-monitor-booking-api-outcome.ts
import {
  formatOutcomeLine,
  OUTCOME_LOG_PREFIX,
  type BookingApiOutcome,
} from "../src/lib/monitor/booking-api-outcome.ts";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
};

// --- formatOutcomeLine ---
{
  const o: BookingApiOutcome = { outcome: "created", bucketCode: "411", keyId: "primary", status: 200 };
  const line = formatOutcomeLine(o);
  ok(line.startsWith(OUTCOME_LOG_PREFIX), "line starts with the stable prefix (so a query can match it)");
  const json = line.slice(OUTCOME_LOG_PREFIX.length).trim();
  const parsed = JSON.parse(json) as BookingApiOutcome;
  ok(parsed.outcome === "created" && parsed.bucketCode === "411" && parsed.keyId === "primary" && parsed.status === 200,
    "the payload is valid JSON carrying outcome, bucket, key id, and status");
}
{
  // Error outcomes carry the machine code so the tally can split error types.
  const line = formatOutcomeLine({ outcome: "error", bucketCode: "311", keyId: "secondary", status: 409, code: "SLOT_TAKEN" });
  const parsed = JSON.parse(line.slice(OUTCOME_LOG_PREFIX.length).trim()) as BookingApiOutcome;
  ok(parsed.code === "SLOT_TAKEN" && parsed.outcome === "error", "error lines carry the machine code");
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
