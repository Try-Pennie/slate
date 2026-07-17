/**
 * Compile-time regression guard for #354. The hand-written DB `Relationships`
 * (schema.ts) keep PostgREST embeds type-safe, so the availability
 * round-trip-reducing nested selects need no `as unknown as` cast. `tsc --noEmit`
 * (CI typecheck + the pre-push gate) type-checks this file; if a relationship
 * regresses to `[]`, the embedded field collapses to a SelectQueryError and the
 * concrete-type assertions below fail the build, pointing straight back here.
 *
 * Never imported at runtime; it exists only to be type-checked.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function __dbEmbedRelationshipTypeGuard() {
  const db = supabaseAdmin();

  // Forward embed: buckets -> event_types (buckets.event_type_id FK). Proves the
  // nested row is the real EventType shape, not `never`/`any`: duration_min is a
  // number, so the wrong-type assignment must be rejected.
  const bucket = (await db.from("buckets").select("*, event_types(*)").maybeSingle()).data;
  const _duration: number | undefined = bucket?.event_types?.duration_min;
  // @ts-expect-error event_types.duration_min is number, never string
  const _durationWrong: string = bucket!.event_types!.duration_min;

  // Reverse embed: availability_schedules <- availability_rules (rules.schedule_id
  // FK). Proves the nested array is the real AvailabilityRule shape.
  const scheds = (
    await db.from("availability_schedules").select("id, availability_rules(weekday)").in("id", ["x"])
  ).data;
  const _weekday: number | undefined = scheds?.[0]?.availability_rules?.[0]?.weekday;
  // @ts-expect-error availability_rules[].weekday is number, never string
  const _weekdayWrong: string = scheds![0].availability_rules[0].weekday;

  return { _duration, _durationWrong, _weekday, _weekdayWrong };
}
