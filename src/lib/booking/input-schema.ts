/**
 * Shared, bounded zod field schemas for the public booking input (#1034). Both
 * the embed `/booking` route and the direct `/api/bookings` parser compose from
 * these, so the size caps can never drift between the two surfaces. Caps live in
 * `input-limits.ts`; attendee content rules (name/email/phone) stay in
 * `validateAttendee`, which also enforces the contact length cap.
 */
import { z } from "zod";
import { INPUT_LIMITS } from "./input-limits.ts";
import { DEBT_TIER } from "../xbc.ts";

export const bucketCodeSchema = z.string().trim().min(1).max(INPUT_LIMITS.code);
export const startSchema = z.string().min(1).max(INPUT_LIMITS.start);
export const timezoneSchema = z.string().min(1).max(INPUT_LIMITS.code);
export const salesforceIdSchema = z.string().max(INPUT_LIMITS.salesforceId);

/**
 * Prefill is an arbitrary key/value bag from the caller. Bound it three ways so a
 * blob can't reach Postgres / gcal / webhooks: per-key length, per-value length,
 * and total key count. Defaults to `{}` when omitted.
 */
export const prefillSchema = z
  .record(z.string().max(INPUT_LIMITS.prefillKey), z.string().max(INPUT_LIMITS.prefillValue))
  .refine((r) => Object.keys(r).length <= INPUT_LIMITS.prefillKeys, {
    message: `Too many prefill fields (max ${INPUT_LIMITS.prefillKeys})`,
  })
  .default({});

/**
 * The tier whose times the caller had on show when the lead confirmed (#3495): the
 * booker hands back the `shownTier` its availability answer named, so the confirm
 * records it instead of reading the cache for it. A measure only, never routed on,
 * so anything that is not one of the tier names is dropped rather than refusing the
 * booking: a lead must never lose a call over a field only /admin/routing reads.
 */
const TIER_KEYS = Object.values(DEBT_TIER).map((t) => t.key) as [string, ...string[]];
export const shownTierSchema = z.enum(TIER_KEYS).optional().catch(undefined);
