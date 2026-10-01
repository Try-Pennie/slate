/**
 * The IO half of the inbound Regal call feed (#2090): look a Slate user up by
 * address, and write the one row per event.
 *
 * Both halves THROW on a database error. A user lookup that answered null on a
 * failed read would count the event as `no_slate_user`, which is the reason that
 * says Slate is fine; an insert that swallowed its error would report an event as
 * recorded that the counters never saw. The route logs the throw, because Regal
 * does not retry and there is nobody to hand the failure back to.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import {
  processRegalCallDelivery,
  type RegalCallDelivery,
  type RegalCallOutcomeRow,
  type RegalCallOutcomeStore,
  type RegalCallRow,
  type RegalCallStore,
} from "@/lib/regal/inbound-call";

export function regalCallStore(db = supabaseAdmin()): RegalCallStore {
  return {
    findUserId: async (email) => {
      // `users.email` is stored normalised (#1663) and unique, so an exact match on
      // the normalised address is the whole lookup and returns at most one row.
      const row = unwrap(
        await db.from("users").select("id").eq("email", email).maybeSingle(),
        "regal call user lookup",
      ) as { id: string } | null;
      return row ? row.id : null;
    },
    insert: async (row: RegalCallRow) => {
      // ON CONFLICT (event_id) DO NOTHING: the unique constraint is what makes a
      // redelivery harmless, and an ignored row comes back as an empty array, which
      // is how a duplicate is told apart from a write. A full row every time, so the
      // upsert never meets a NOT NULL it cannot satisfy (L685).
      const { data, error } = await db
        .from("regal_call_events")
        .upsert({ ...row }, { onConflict: "event_id", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`regal call insert failed: ${error.message}`);
      return (data ?? []).length === 0 ? "duplicate" : "inserted";
    },
  };
}

/**
 * The call outcome half (#2944): one row per completed call in
 * `regal_call_outcomes`, kept 120 days for the show rate. THROWS on any error
 * other than the event_id conflict, for the same reason the detector's insert
 * does: a swallowed error would report a call as stored that the show rate never
 * sees.
 */
export function regalCallOutcomeStore(db = supabaseAdmin()): RegalCallOutcomeStore {
  return {
    insertOutcome: async (row: RegalCallOutcomeRow) => {
      // ON CONFLICT (event_id) DO NOTHING, told apart from a write by the empty
      // array it returns. A full row every time (L685).
      const { data, error } = await db
        .from("regal_call_outcomes")
        .upsert({ ...row }, { onConflict: "event_id", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`regal call outcome insert failed: ${error.message}`);
      return (data ?? []).length === 0 ? "duplicate" : "inserted";
    },
  };
}

/**
 * Record one received body twice over: the detector's per reason row and the
 * call outcome row, each in its own failure boundary. Never throws for either
 * half; each half's error comes back settled for the route to log.
 */
export async function recordRegalCall(body: unknown): Promise<RegalCallDelivery> {
  const db = supabaseAdmin();
  return processRegalCallDelivery(body, { detector: regalCallStore(db), outcome: regalCallOutcomeStore(db) });
}
