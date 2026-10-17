/**
 * The live binding of the lost race judgement (#3797): the reads `offer-race.ts`
 * decides from, run as a `candidate_read_empty` refusal is recorded.
 *
 * Three reads, at most, and only on such a refusal:
 *  - the refusing codes' stored rows, by primary key: which rows still offer the
 *    refused time. Those are the row proofs this refusal leaves for later ones, and the
 *    route's stored offer check reuses the rows rather than reading them again;
 *  - only when the confirm carried the list's `computed_at`: the pools' busy blocks
 *    over the requested buffered window, with when each was written, and the newest
 *    row proof on those codes since that list was computed.
 *
 * Every read THROWS on failure (`unwrap`, `selectAllPages`), and the caller records
 * `unknown`, which counts exactly as a refusal did before. A short or empty answer
 * read as "nothing written since" would turn a stale offer into a race, which is the
 * one direction this must never fail in.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { selectAllPages, type PageableQuery } from "@/lib/supabase/paginate";
import { bufferedWindow } from "@/lib/booking/buffered-window";
import { offeredCodes, storedOfferCodes, type StoredSlotRow } from "@/lib/booking/refusal-stored-offer";
import type { RefusalTrace } from "@/lib/booking/refusal-trace";
import type { EventType } from "@/lib/db/types";
import { judgeOfferRace, newestProofMs, type OfferVerdict } from "@/lib/booking/offer-race";

export interface RefusedOfferJudgement {
  verdict: OfferVerdict | null;
  staleRowCodes: string[];
  storedRows: StoredSlotRow[];
}

export async function judgeRefusedOfferLive(input: {
  trace: RefusalTrace;
  servedComputedAt: string | null;
  eventType: Pick<EventType, "duration_min" | "buffer_before_min" | "buffer_after_min">;
}): Promise<RefusedOfferJudgement> {
  const { trace } = input;
  const codes = storedOfferCodes(trace);
  if (!codes || !trace.requestedStart) return { verdict: null, staleRowCodes: [], storedRows: [] };
  const db = supabaseAdmin();

  // One primary key read of the ladder's rows: a handful of codes, one row each.
  const storedRows = (unwrap(
    await db.from("bucket_slots").select("bucket_code, payload, computed_at").in("bucket_code", codes),
    "offerRaceStoredRows",
  ) ?? []) as StoredSlotRow[];
  const staleRowCodes = offeredCodes(trace, storedRows);
  if (!input.servedComputedAt) return { verdict: null, staleRowCodes, storedRows };

  const servedMs = Date.parse(input.servedComputedAt);
  const startMs = Date.parse(trace.requestedStart);
  const members = [...new Set(trace.rungs.flatMap((r) => r.memberIds ?? []))];
  // A rung whose read did not say who was in it cannot be judged, and an unreadable
  // stamp cannot be compared: both are unknown, never a race.
  if (!Number.isFinite(servedMs) || !Number.isFinite(startMs) || trace.rungs.some((r) => !r.memberIds)) {
    return { verdict: "unknown", staleRowCodes, storedRows };
  }
  if (members.length === 0) return { verdict: "stale_offer", staleRowCodes, storedRows };

  const [fromIso, toIso] = bufferedWindow(
    input.eventType,
    new Date(startMs).toISOString(),
    new Date(startMs + input.eventType.duration_min * 60_000).toISOString(),
  );
  const [blocks, proofs] = await Promise.all([
    selectAllPages<{ user_id: string; created_at: string; source: string }>("offer race busy blocks", "id", () =>
      db
        .from("busy_blocks")
        .select("id, user_id, created_at, source")
        // in-chunk-ok: one refusal's pools, bounded by the roster (at most 200 advisors at
        // the design target, 7,520 bytes of uuids against the 10,000 budget).
        .in("user_id", members)
        .lt("starts_at", toIso)
        .gt("ends_at", fromIso) as unknown as PageableQuery,
    ),
    // The newest refusal on these codes since the list was computed whose stored row
    // still offered its time: the proof that Slate already knew the row was wrong.
    db
      .from("routing_decisions")
      .select("created_at")
      .overlaps("stale_row_codes", codes)
      .gt("created_at", new Date(servedMs).toISOString())
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  const proofRows = (unwrap(proofs, "offerRaceStaleProofs") ?? []) as { created_at: string }[];
  const judged = judgeOfferRace({
    servedComputedAt: input.servedComputedAt,
    memberIds: members,
    blocks: blocks.map((b) => ({ userId: b.user_id, createdAt: b.created_at, source: b.source })),
    provenStaleAtMs: newestProofMs(proofRows.map((p) => ({ createdAt: p.created_at }))),
  });
  return { verdict: judged.verdict, staleRowCodes, storedRows };
}
