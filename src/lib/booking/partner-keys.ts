/**
 * The two join keys a landing page passes on the booking URL (#2659).
 *
 * Pennie's GTM/GA4 tagging spec v2 (2026-09-24, section 3) asks for two keys ON
 * THE BOOKING so the warehouse can tie a booking to a lead's submission and to a
 * call platform contact without leaning on GA4, whose side is lossy (consent,
 * ad blockers, sampling). trypennie already puts `submissionId=<submission.Id>`
 * on the `/book` URL; a page adds `regalProfileId` when it has one. With cal.com
 * they rode as `metadata[...]`; here they ride in `prefill`, which `/book` fills
 * from every query param, `POST /api/bookings` accepts as a string map, the
 * booking row stores as jsonb, every webhook payload carries, and the Snowflake
 * mirror exports as a VARIANT. That is one home (L83), and no migration.
 *
 * What was missing was the READERS: the Regal event dropped the bag, the API
 * views did not show the keys, and nothing named the spelling in one place. So
 * the spelling is `PARTNER_KEYS`, the read is `partnerKeysFrom`, and
 * `scripts/test-partner-keys.ts` fails on any other file spelling either key by
 * hand (L613): four hand written lookups of one URL key drift silently.
 *
 * `partnerKeysFrom` answers `null` for an absent, empty, blank or non string
 * value, and trims what it does return. The spec is explicit that a key is LEFT
 * OUT when the page has no value, and an empty string sent as a join key is
 * worse than no key: it joins nothing and reads as a value.
 */

export const PARTNER_KEYS = {
  submissionId: "submissionId",
  regalProfileId: "regalProfileId",
} as const;

/** What a reader gets: each key's trimmed value, or null when the page passed none. */
export interface PartnerKeys {
  submissionId: string | null;
  regalProfileId: string | null;
}

export function partnerKeysFrom(prefill: Record<string, unknown> | null | undefined): PartnerKeys {
  return {
    submissionId: readKey(prefill, PARTNER_KEYS.submissionId),
    regalProfileId: readKey(prefill, PARTNER_KEYS.regalProfileId),
  };
}

function readKey(prefill: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = prefill?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
