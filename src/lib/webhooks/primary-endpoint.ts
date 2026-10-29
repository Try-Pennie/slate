import type { supabaseAdmin } from "@/lib/supabase/admin";

type Db = ReturnType<typeof supabaseAdmin>;

/**
 * The org's primary webhook endpoint: its OLDEST row (#4381).
 *
 * The webhooks admin page edits one endpoint, and its save action and test send
 * act on the same one. That was "the org's only row" until #4381 added a second,
 * the dialer's lead sender. An unordered `.limit(1)` can then return either, and
 * the page would show and save over the sender's row as if it were Regal's. The
 * primary is the row the org started with, so a later endpoint never displaces
 * it; `id` breaks a tie between rows created in the same instant.
 *
 * Returns the builder's own `{ data, error }`, so each caller keeps its own way of
 * telling "no endpoint" from "could not read".
 * `scripts/test-primary-webhook-endpoint.ts` refuses any other single-row read of
 * the table that is not by id.
 */
export function readPrimaryWebhookEndpoint(db: Db, orgId: string, columns: string) {
  return db
    .from("webhook_endpoints")
    .select(columns)
    .eq("org_id", orgId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
}
