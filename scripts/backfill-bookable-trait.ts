// One off: give Regal its starting bookable trait for every agent (#2085).
//
//   pnpm backfill:bookable-trait
//
// The routable write (`src/lib/bookable/routable-write.ts`) tells Regal whether
// Slate can route to an agent only when that CHANGES, so until this runs Regal
// holds the trait for nobody. This records one `agent.bookable_changed` delivery
// per user row, carrying the agent's current routing value (`isRoutable`), through
// the ordinary webhook delivery path: each one lands in the delivery log at
// /admin/webhooks, the retry sweep retries a failure, and the dead letter page
// fires if one never lands. Test agents (#396) are recorded and withheld.
//
// WRITES: one webhook_deliveries row per user, and the POSTs to the subscribed
// endpoint. Nothing else. Run it AFTER migration 0135 is applied, which subscribes
// the live endpoint to `agent.bookable_changed`; before that every row would reach
// nobody (#1459), so the run refuses.
//
// Re-running is safe and SENDS AGAIN, deliberately: it is also the repair the
// `bookable_trait_unrecorded:*` page names, and the repair after SQL run by hand.
// Every send states the agent's value at that send, so a duplicate changes nothing.
//
// Exit codes (scripts/lib/bookable-trait-backfill.ts, BACKFILL_EXIT): 0 every
// trait recorded; 1 no Supabase credentials here; 2 the roster or the endpoints
// could not be read, or nothing subscribes; 3 the roster read came back empty;
// 4 some traits could not be recorded.
import { requireSupabaseCredentials } from "./lib/supabase-credentials.ts";
import {
  BACKFILL_EXIT,
  backfillExitCode,
  backfillSummary,
  runBookableTraitBackfill,
} from "./lib/bookable-trait-backfill.ts";

const creds = requireSupabaseCredentials();
if (!creds) process.exit(BACKFILL_EXIT.notConfigured);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { selectAllPages } = await import("@/lib/supabase/paginate");
const { emitWebhook } = await import("@/lib/webhooks/emit");
const { ROUTABLE_STATE_COLUMNS } = await import("@/lib/bookable/routable-trait");
type RoutableStateRow = import("@/lib/bookable/routable-trait").RoutableStateRow;

const db = supabaseAdmin();

// Say it before sending anything: a run against an endpoint that does not
// subscribe the event records nothing and reaches nobody (#1459).
{
  const { data, error } = await db
    .from("webhook_endpoints")
    .select("id")
    .eq("active", true)
    .contains("events", ["agent.bookable_changed"]);
  if (error) {
    console.error(`could not read the webhook endpoints: ${error.message}`);
    process.exit(BACKFILL_EXIT.unreadable);
  }
  if ((data ?? []).length === 0) {
    console.error(
      "No active webhook endpoint subscribes agent.bookable_changed, so every trait would reach nobody. " +
        "Apply migration 0135 (supabase db push) first; it adds the event to the existing endpoint.",
    );
    process.exit(BACKFILL_EXIT.unreadable);
  }
}

let report;
try {
  report = await runBookableTraitBackfill({
    listUsers: () =>
      selectAllPages<RoutableStateRow>("users", (from, to) =>
        db.from("users").select(ROUTABLE_STATE_COLUMNS).order("id").range(from, to),
      ),
    // Inline, not deferred: a script has no response to outlive, and each send
    // finishing before the next keeps the run's own count honest.
    emit: (e, dedupeKey) =>
      emitWebhook(
        e.orgId,
        "agent.bookable_changed",
        { user_id: e.userId, email: e.email, slate_bookable: e.slateBookable },
        dedupeKey,
        e.suppressed,
      ),
  });
} catch (err) {
  console.error(`could not read the roster: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(BACKFILL_EXIT.unreadable);
}

console.log(backfillSummary(report));
process.exit(backfillExitCode(report));
