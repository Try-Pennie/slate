// Offboarding lifecycle state machine (#264/#265), pure + idempotent.
// The deactivate/reactivate endpoints are called by an external automation that
// may retry, so the decision of what (if anything) to write must be a pure,
// idempotent function of the current row.
// Run: node --experimental-strip-types scripts/test-offboarding-plan.ts
import { planLifecycleChange } from "../src/lib/offboarding/plan.ts";
import { eq, finish } from "./lib/harness.ts";

const active = { deactivated_at: null };
const gone = { deactivated_at: "2026-06-19T00:00:00Z" };

eq(planLifecycleChange(null, "deactivate"), { status: "not_found" }, "deactivate unknown user = not_found");
eq(planLifecycleChange(null, "reactivate"), { status: "not_found" }, "reactivate unknown user = not_found");

eq(planLifecycleChange(active, "deactivate"), { status: "apply", deactivate: true }, "deactivate an active user applies");
eq(planLifecycleChange(gone, "deactivate"), { status: "noop" }, "deactivate an already-deactivated user is a no-op (idempotent)");

eq(planLifecycleChange(gone, "reactivate"), { status: "apply", deactivate: false }, "reactivate a deactivated user applies");
eq(planLifecycleChange(active, "reactivate"), { status: "noop" }, "reactivate an already-active user is a no-op (idempotent)");

finish();
