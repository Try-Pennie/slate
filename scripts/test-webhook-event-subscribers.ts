// Repo invariant (#1459): a webhook event Slate can emit must be able to reach
// somebody.
//
// `emitWebhook` delivers only to endpoints whose stored `events` array contains
// the event, so adding a value to the `WebhookEvent` union ships an event that is
// recorded as a delivery and sent to nobody. Nothing fails, nothing alerts, the
// delivery rows look normal, and the only symptom is a downstream system quietly
// never hearing about something (L120).
//
// This is the BUILD-time half, and it is deliberately narrow: it compares the
// code's event list against the migration DEFAULT, which is the subscription a NEW
// endpoint is created with. That is the half a repo scan can see. It says nothing
// about the endpoint that already exists, which is why the monitor lane also reads
// the live rows (src/lib/monitor/webhook-subscriber-coverage.ts): the one live
// Regal endpoint predates every event added from here on, and no migration default
// will ever update it. Each guard is blind exactly where the other looks.
//
// Run: node --experimental-strip-types scripts/test-webhook-event-subscribers.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  DELIBERATELY_UNSUBSCRIBED,
  WEBHOOK_EVENTS,
  deliberatelyUnsubscribedReason,
} from "@/lib/webhooks/events";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

/**
 * The `events` column DEFAULT, read from the LAST migration that sets one, so a
 * later migration changing the default is what this compares against rather than
 * the original 0001. Returns null when no migration sets it, which is a failure
 * rather than an empty answer: "found no default" and "the default is empty" would
 * otherwise be the same result (L98).
 */
function migrationDefaultEvents(): { events: string[]; file: string } | null {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let found: { events: string[]; file: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    // `events text[] not null default array[ '…', '…' ]`, or a later
    // `alter column events set default array[…]`.
    for (const m of sql.matchAll(
      /events[\s\S]{0,80}?default\s+array\s*\[([\s\S]*?)\]/gi,
    )) {
      const events = [...m[1]!.matchAll(/'([^']+)'/g)].map((q) => q[1]!);
      if (events.length > 0) found = { events, file };
    }
  }
  return found;
}

// --- the code's own list is complete ---
{
  // WEBHOOK_EVENTS is derived from a `Record<WebhookEvent, true>`, so tsc already
  // fails when a union member is missing from it. Asserted here anyway, because
  // that guarantee is invisible at this level and a future refactor to a plain
  // array would silently drop it.
  const union = [
    ...readFileSync(join(ROOT, "src", "lib", "db", "types.ts"), "utf8")
      .match(/export type WebhookEvent =([\s\S]*?);/)![1]!
      .matchAll(/"([^"]+)"/g),
  ].map((m) => m[1]!);
  assert(union.length > 0, `read ${union.length} events off the WebhookEvent union`);
  eq(
    [...WEBHOOK_EVENTS].sort().join(","),
    [...union].sort().join(","),
    "WEBHOOK_EVENTS holds exactly the WebhookEvent union",
  );
}

// --- every event is in the migration default, or declared unsubscribed ---
{
  const def = migrationDefaultEvents();
  assert(def !== null, "a migration sets a DEFAULT for webhook_endpoints.events");
  if (def) {
    assert(def.events.length > 0, `the default (${def.file}) names ${def.events.length} events`);
    const defaults = new Set(def.events);

    const unreachable = WEBHOOK_EVENTS.filter(
      (e) => !defaults.has(e) && !deliberatelyUnsubscribedReason(e),
    );
    eq(
      unreachable.join(","),
      "",
      `every event Slate emits is in the webhook_endpoints.events DEFAULT (${def.file}), ` +
        `or declared in DELIBERATELY_UNSUBSCRIBED with the issue that subscribes it. ` +
        `Unreachable: ${unreachable.join(", ")}`,
    );

    // The other direction. A default naming an event nothing emits is a dead
    // subscription: it reads as coverage forever, and a rename leaves exactly this
    // (L96 in the code-to-registry direction, L41 on the copy drifting).
    const orphans = def.events.filter((e) => !WEBHOOK_EVENTS.includes(e as never));
    eq(
      orphans.join(","),
      "",
      `every event in the DEFAULT is one Slate actually emits. Orphans: ${orphans.join(", ")}`,
    );

    // Positive control: the guard has to be shown catching the real shape, or
    // "nothing unreachable" is indistinguishable from a comparison that cannot
    // find anything (L1).
    const withNewEvent = [...WEBHOOK_EVENTS, "booking.updated"];
    eq(
      withNewEvent.filter((e) => !defaults.has(e) && !deliberatelyUnsubscribedReason(e)).join(","),
      "booking.updated",
      "control: an event added to the union but not the default is caught",
    );
  }
}

// --- a declaration must name an issue and a reason, not just silence the check ---
{
  const entries = Object.entries(DELIBERATELY_UNSUBSCRIBED);
  for (const [event, reason] of entries) {
    assert(
      WEBHOOK_EVENTS.includes(event as never),
      `DELIBERATELY_UNSUBSCRIBED names ${event}, which is a real event (no stale entry)`,
    );
    assert(
      typeof reason === "string" && /#\d+/.test(reason),
      `the ${event} declaration names the issue that will subscribe it (got: ${reason})`,
    );
    assert(
      typeof reason === "string" && reason.replace(/#\d+/, "").trim().length > 8,
      `the ${event} declaration states a reason, not only an issue number`,
    );
  }
  // Not an error to have none: today every event is subscribed. Reported so the
  // count is visible rather than assumed.
  assert(true, `${entries.length} event(s) declared deliberately unsubscribed`);
}

finish();
