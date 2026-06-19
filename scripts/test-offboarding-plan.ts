// Offboarding lifecycle state machine (#264/#265), pure + idempotent.
// The deactivate/reactivate endpoints are called by an external automation that
// may retry, so the decision of what (if anything) to write must be a pure,
// idempotent function of the current row.
// Run: node --experimental-strip-types scripts/test-offboarding-plan.ts
import { planLifecycleChange } from "../src/lib/offboarding/plan.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const active = { deactivated_at: null };
const gone = { deactivated_at: "2026-06-19T00:00:00Z" };

assert(eq(planLifecycleChange(null, "deactivate"), { status: "not_found" }), "deactivate unknown user = not_found");
assert(eq(planLifecycleChange(null, "reactivate"), { status: "not_found" }), "reactivate unknown user = not_found");

assert(eq(planLifecycleChange(active, "deactivate"), { status: "apply", deactivate: true }), "deactivate an active user applies");
assert(eq(planLifecycleChange(gone, "deactivate"), { status: "noop" }), "deactivate an already-deactivated user is a no-op (idempotent)");

assert(eq(planLifecycleChange(gone, "reactivate"), { status: "apply", deactivate: false }), "reactivate a deactivated user applies");
assert(eq(planLifecycleChange(active, "reactivate"), { status: "noop" }), "reactivate an already-active user is a no-op (idempotent)");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
