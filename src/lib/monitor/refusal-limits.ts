/**
 * The limits each refusal page NAMES (#1442, #1727), derived from the rules that
 * actually refuse rather than copied into the copy (L41). A figure written by hand
 * beside the rule it describes goes stale the first time somebody changes one, and
 * a message carrying a wrong number is worse than one carrying none: a reader who
 * checks it once and finds it right stops checking.
 *
 * One place for the monitor lane, the alert preview and the live verification
 * (#1726), so all three render the figures that ship.
 */
import {
  BOOKING_API_IP_LIMITER,
  BOOKING_API_WRITE_LIMITER,
  BOOKING_CONTACT_HOURLY_RATE_RULES,
  BOOKING_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
} from "../rate-limit-core.ts";
import type { CeilingLimits, EmbedCapLimits } from "./api-refusal-signals.ts";

export const SHIPPED_CEILING_LIMITS: CeilingLimits = {
  keyPerHour: DIRECT_BOOKING_API_HOURLY_RATE_RULES[0]!.max,
  keyPerMinute: BOOKING_API_WRITE_LIMITER.perMinute,
  ipPerHour: DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES[0]!.max,
  ipPerMinute: BOOKING_API_IP_LIMITER.perMinute,
};

export const SHIPPED_EMBED_CAP_LIMITS: EmbedCapLimits = {
  addressPerHour: BOOKING_HOURLY_RATE_RULES[0]!.max,
  contactPerHour: BOOKING_CONTACT_HOURLY_RATE_RULES[0]!.max,
};
