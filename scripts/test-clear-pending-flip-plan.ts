// #2078: clearing a pending bookable flip by hand.
//
// `planBookableChange` treats "not bookable" on somebody already not bookable as a
// noop, so the explicit write that settles `bookable_pending_since` is never
// reached and the mark survives. Clearing the mark is therefore its own decision,
// keyed on the MARK rather than on the bookable value, and it never moves
// `bookable` at all.
// Run: node --experimental-strip-types scripts/test-clear-pending-flip-plan.ts
import { planBookableChange, planClearPendingFlip } from "../src/lib/bookable/plan.ts";
import { CLEAR_PENDING_FLIP_LABEL, pendingFlipSentence } from "../src/lib/bookable/pending-flip-copy.ts";
import { eq, finish } from "./lib/harness.ts";

const since = "2026-09-08T14:00:00.000Z";

eq(planClearPendingFlip(null), { status: "not_found" }, "an unknown user is not_found");
eq(
  planClearPendingFlip({ bookable: false, bookable_pending_since: since }),
  { status: "clear", pendingSince: since },
  "a pending flip on somebody not bookable is cleared, carrying the stamp it replaces",
);
eq(
  planClearPendingFlip({ bookable: false, bookable_pending_since: null }),
  { status: "not_pending" },
  "nothing pending means nothing to clear, so a second press is a noop rather than a second audit entry",
);
eq(
  planClearPendingFlip({ bookable: false, bookable_pending_since: "" }),
  { status: "not_pending" },
  "an empty stamp is no stamp",
);

// The control: the toggle path really cannot settle this case, which is the
// whole reason the separate decision exists. If this ever stops being a noop the
// separate action is redundant and should be deleted.
eq(
  planBookableChange({ bookable: false }, false),
  { status: "noop" },
  "the toggle still cannot reach the mark on somebody already not bookable",
);

// What the agent page says beside the control. The date is in the business zone
// and names it, because the server renders in UTC.
eq(
  pendingFlipSentence(since),
  "Waiting to become bookable since Tuesday, September 8 at 10:00am ET. Slate cannot read their Google calendar yet, so the roster sync tries again every hour.",
  "the waiting line names when, in Eastern, and why",
);
eq(
  pendingFlipSentence("not a stamp"),
  "Waiting to become bookable. Slate cannot read their Google calendar yet, so the roster sync tries again every hour.",
  "an unreadable stamp drops the date rather than printing Invalid DateTime",
);
const dash = new RegExp("[\\u2014\\u2013]|\\s-\\s");
eq(dash.test(pendingFlipSentence(since)) || dash.test(CLEAR_PENDING_FLIP_LABEL), false, "no dashes in the copy");

finish();
