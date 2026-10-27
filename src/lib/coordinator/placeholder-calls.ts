/**
 * How many calls already sit on the placeholder advisor at a time (#4205), so the
 * coordinator can see a stack building before adding to it. Counted as the calls on the
 * placeholder of the bucket's own org and world (`findPlaceholderAdvisor`) whose time
 * OVERLAPS the call being placed, because a 10:15 call blocks a 10:00 one as surely as a
 * second 10:00 one does.
 *
 * Pure apart from the injected deps (relative imports); `live.ts` wires the real ones.
 */
import type { Bucket, EventType, User } from "../db/types.ts";

export interface PlaceholderCallsDeps {
  resolveBucketByCode(code: string): Promise<{ bucket: Bucket; eventType: EventType } | null>;
  /** The org's placeholder in one world, or null. THROWS on a failed read. */
  findPlaceholder(orgId: string, isTest: boolean): Promise<User | null>;
  /** Active calls on `userId` overlapping [startIso, endIso). THROWS on a failed read. */
  countOverlapping(userId: string, startIso: string, endIso: string): Promise<number>;
}

export type PlaceholderCalls =
  | { ok: true; count: number; startsAt: string; endsAt: string }
  | { ok: false; reason: "start-unreadable" | "no-bucket" | "no-placeholder" };

export async function placeholderCallsAt(input: { bucketCode: string; startIso: string }, deps: PlaceholderCallsDeps): Promise<PlaceholderCalls> {
  const startMs = Date.parse(input.startIso);
  if (!Number.isFinite(startMs)) return { ok: false, reason: "start-unreadable" };
  const resolved = await deps.resolveBucketByCode(input.bucketCode);
  if (!resolved) return { ok: false, reason: "no-bucket" };
  const placeholder = await deps.findPlaceholder(resolved.bucket.org_id, resolved.bucket.is_test);
  if (!placeholder) return { ok: false, reason: "no-placeholder" };
  const startsAt = new Date(startMs).toISOString();
  const endsAt = new Date(startMs + resolved.eventType.duration_min * 60_000).toISOString();
  return { ok: true, count: await deps.countOverlapping(placeholder.id, startsAt, endsAt), startsAt, endsAt };
}
