// Bookable-toggle state machine (#281), pure + idempotent. The bookable API is
// called by the roster/onboarding automation, which may retry, so the decision
// of what (if anything) to write must be a pure, idempotent function of the
// current row. The `bookable` axis is orthogonal to `deactivated_at`.
// Run: node --experimental-strip-types scripts/test-bookable-plan.ts
import { planBookableChange } from "../src/lib/bookable/plan.ts";
import { eq, finish } from "./lib/harness.ts";

const unbookable = { bookable: false };
const bookable = { bookable: true };

eq(planBookableChange(null, true), { status: "not_found" }, "activate unknown user = not_found");
eq(planBookableChange(null, false), { status: "not_found" }, "deactivate unknown user = not_found");

eq(planBookableChange(unbookable, true), { status: "apply", bookable: true }, "making an unbookable agent bookable applies");
eq(planBookableChange(bookable, true), { status: "noop" }, "already-bookable agent is a no-op (idempotent)");

eq(planBookableChange(bookable, false), { status: "apply", bookable: false }, "making a bookable agent unbookable applies");
eq(planBookableChange(unbookable, false), { status: "noop" }, "already-unbookable agent is a no-op (idempotent)");

finish();
