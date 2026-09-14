// #2302: the shared bound on how many activations one roster run attempts. Since
// the calendar read joined the activation gate, every attempt is several Google
// calls, and the Salesforce and Twilio syncs spend them out of ONE Worker
// invocation. Two independent budgets would make the real worst case double the
// number anybody wrote down.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-activation-allowance.ts
import {
  activationAllowance,
  MAX_ACTIVATIONS_PER_RUN,
} from "@/lib/bookable/activation-allowance";
import { MAX_ONBOARDS_PER_TICK } from "@/lib/google/sync-pace";
import { assert, eq, finish } from "./lib/harness.ts";

{
  const a = activationAllowance(3);
  eq([a.take(), a.take(), a.take()], [true, true, true], "the allowance is spendable up to its size");
  eq(a.take(), false, "and refuses past it");
  eq(a.spent(), 3, "it reports what it spent, never what it refused");
}

{
  // The property the whole thing exists for: two callers, one budget. Independent
  // allowances would let the run spend twice the stated maximum.
  const shared = activationAllowance(4);
  const salesforce = [shared.take(), shared.take(), shared.take()];
  const twilio = [shared.take(), shared.take()];
  eq(salesforce, [true, true, true], "the first caller spends three");
  eq(twilio, [true, false], "and the second gets the one slot left, not four of its own");
  eq(shared.spent(), 4, "four spent in total, which is the stated maximum");
}

{
  const a = activationAllowance(0);
  eq(a.take(), false, "a zero allowance attempts nothing");
  eq(a.spent(), 0, "and spends nothing");
}

{
  // Derived, not chosen, and asserted so a change to either constant has to be a
  // decision about both.
  eq(
    MAX_ACTIVATIONS_PER_RUN,
    MAX_ONBOARDS_PER_TICK,
    "the run allowance matches the watch lane's own first-time setup rate",
  );
  assert(MAX_ACTIVATIONS_PER_RUN > 0, "and a run can always attempt at least one activation");
}

finish();
