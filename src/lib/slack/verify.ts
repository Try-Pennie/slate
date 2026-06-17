import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an inbound Slack request signature (#77), per Slack's recipe: HMAC-
 * SHA256 of `v0:${timestamp}:${rawBody}` keyed by the app signing secret,
 * compared in constant time, with a 5-minute timestamp window to blunt replay.
 * Pure (takes `nowMs`) so it's unit-testable without a live request.
 */
const FIVE_MINUTES_MS = 5 * 60 * 1000;

export function verifySlackSignature(args: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowMs: number;
}): boolean {
  const { signingSecret, timestamp, signature, rawBody, nowMs } = args;
  if (!signingSecret || !timestamp || !signature) return false;

  // Reject stale (or far-future) timestamps before spending the HMAC.
  const tsMs = Number(timestamp) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > FIVE_MINUTES_MS) {
    return false;
  }

  const expected =
    "v0=" +
    createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex");

  // Constant-time compare; bail if lengths differ (timingSafeEqual throws).
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
