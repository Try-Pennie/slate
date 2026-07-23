/**
 * Shared, bounded zod field schemas for the public booking input (#1034). Both
 * the embed `/booking` route and the direct `/api/bookings` parser compose from
 * these, so the size caps can never drift between the two surfaces. Caps live in
 * `input-limits.ts`; attendee content rules (name/email/phone) stay in
 * `validateAttendee`, which also enforces the contact length cap.
 */
import { z } from "zod";
import { INPUT_LIMITS } from "./input-limits.ts";

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
