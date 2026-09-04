import type { WebhookFormat } from "@/lib/db/types";

/**
 * What each webhook format IS, and the fact that the list is closed (#1952).
 *
 * Dan asked "how would I add a new format?" on /admin/webhooks. The answer is
 * that he cannot, from any page, and the page did not say so: Format was a
 * dropdown of two unexplained words. `Generic (signed)` in particular never
 * said it means an HMAC over `timestamp.body`, which is the whole reason a
 * subscriber can reject a replayed delivery.
 *
 * Adding one is FOUR edits, not the three the issue counted:
 *
 *   1. the `WebhookFormat` union in `src/lib/db/types.ts`
 *   2. an entry here, which is what puts it in the dropdown
 *   3. a builder in `FORMAT_BUILDERS` (`src/lib/webhooks/wire.ts`)
 *   4. the column's own `check (format in (...))` constraint, in a migration,
 *      or the database refuses to store it
 *
 * The first three are enforced by the compiler, because this and the builder map
 * are both `Record<WebhookFormat, ...>`: a format added to the union fails to
 * build until it has a label and a builder, and the dropdown is DERIVED from
 * this record rather than hand written beside it, so it cannot go stale (L41,
 * L96). The fourth is enforced by `scripts/test-webhook-formats.ts`, which
 * parses the constraint out of the migration, because nothing in TypeScript can
 * see a check constraint.
 */
export const WEBHOOK_FORMATS: Record<WebhookFormat, { label: string; what: string }> = {
  regal: {
    label: "Regal",
    what:
      "The Regal event shape, authenticated with the API key below sent as the " +
      "Authorization header. This is what the live endpoint uses.",
  },
  generic: {
    label: "Generic (signed)",
    what:
      "A {event, data} body, signed with an HMAC over the timestamp and the body " +
      "together and sent as x-slate-signature with x-slate-timestamp, so a " +
      "subscriber can reject a delivery that was replayed.",
  },
};

/** The dropdown's options, derived from the record above rather than repeated. */
export const WEBHOOK_FORMAT_OPTIONS = (
  Object.keys(WEBHOOK_FORMATS) as WebhookFormat[]
).map((value) => ({ value, label: WEBHOOK_FORMATS[value].label }));

/**
 * Said on the page, so nobody hunts for a button that cannot exist. A format is
 * a payload shape plus an authentication scheme, so needing code is correct; a
 * dropdown that looks open about it is not.
 */
export const WEBHOOK_FORMAT_NOTE =
  "These two are the whole list. A format is a payload shape and a way of " +
  "authenticating, so adding one is a code change rather than a setting.";
