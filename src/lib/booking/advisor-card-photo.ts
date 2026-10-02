/**
 * The advisor's photo for the reminder's contact card (#1334, #3027).
 *
 * The bytes come straight out of `advisor_photos`, the same image the manage page
 * serves, read under the reminder lane's own deadline. There is no HTTP hop and no
 * self fetch: the Worker already holds the database, and fetching its own public
 * route would be a second request for bytes it can read directly.
 *
 * The photo is an optional extra on an email a real person reads, so the stored
 * value is checked again here rather than trusted, and anything wrong ends as "no
 * photo" (the Pennie logo), never a broken card or a bloated email:
 *
 *  - a byte ceiling;
 *  - only `image/jpeg` or `image/png`, and only when the bytes' own signature
 *    agrees with the stored label, since the card declares the type and a reader
 *    trusts it.
 *
 * Directory thumbnails are 96px, so the card's photo is 96px (accepted on #3027).
 */
import { fromBase64, sniffPhotoMime } from "@/lib/advisor-photos/core";
import type { CardPhoto } from "./advisor-contact-card.ts";

/**
 * The largest image embedded, in bytes before base64 (which adds a third). The
 * stored photos are directory thumbnails of 2 to 20 KB, so this only refuses a
 * value no refresh should ever have written.
 */
export const CARD_PHOTO_MAX_BYTES = 64 * 1024;

const CARD_TYPE: Record<string, CardPhoto["type"]> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
};

/**
 * The card photo for one stored image, or a reason it cannot be one. Pure, so the
 * reminder lane counts and logs the refusal exactly as it did a failed fetch.
 */
export function cardPhotoFromStored(
  stored: { base64: string; mime: string },
): { ok: true; photo: CardPhoto } | { ok: false; reason: string } {
  const declared = CARD_TYPE[stored.mime];
  if (!declared) return { ok: false, reason: `photo is not an image the card can carry (${stored.mime || "no type"})` };
  const bytes = fromBase64(stored.base64);
  if (!bytes || bytes.length === 0) return { ok: false, reason: "stored photo is not readable base64" };
  if (bytes.length > CARD_PHOTO_MAX_BYTES) return { ok: false, reason: `photo too large (${bytes.length} bytes)` };
  const actual = sniffPhotoMime(bytes);
  if (!actual || CARD_TYPE[actual] !== declared) {
    return { ok: false, reason: `photo data does not match its declared type (${stored.mime})` };
  }
  return { ok: true, photo: { type: declared, base64: stored.base64 } };
}
