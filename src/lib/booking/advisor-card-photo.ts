/**
 * The advisor's photo, fetched for the reminder's contact card (#1334, Dan
 * 2026-10-01).
 *
 * The URL is the one the manage page shows (`users.avatar_url`, judged by
 * `storedPhotoUrl`), which is always Google's user content host. Measured on
 * 2026-10-01 against a live sample of twelve: it answers with NO auth from outside
 * Google (as #2600 found for the directory's thumbnail), so the Worker fetches it
 * exactly as a browser rendering the manage page does, with no credential.
 *
 * The photo is an optional extra on an email a real person reads, so every way it
 * can go wrong ends as "no photo", reported once through `onUnread`, and never as a
 * broken card, a bloated email or a stalled lane:
 *
 *  - a deadline (the lane's shared `readWithinDeadline`), and the request aborted
 *    when it passes rather than left running;
 *  - a byte ceiling, judged from the declared length and again while reading;
 *  - only `image/jpeg` or `image/png`, and only when the bytes agree with the
 *    label, since the card declares the type and a reader trusts it.
 */
import { readWithinDeadline, type ScheduleTimer } from "@/lib/read-within-deadline";
import type { CardPhoto } from "./advisor-contact-card.ts";

/**
 * The square size asked of Google, as a JPEG. The stored URL asks for 96px, which
 * is blurry on a contact screen. Measured 2026-10-01 over a live sample of twelve:
 * at 256px half the photos come back as PNG, up to 112 KB; asking for JPEG (`-rj`)
 * brought those to 14 to 27 KB. A host that answers PNG anyway is still accepted.
 */
export const CARD_PHOTO_SIZE_PX = 256;

/**
 * The largest image embedded, in bytes before base64 (which adds a third). More than
 * twice every 256px JPEG measured, so a real photo is never refused, while a
 * surprise (a full size original, a PNG the conversion did not apply to) cannot
 * bloat the email.
 */
export const CARD_PHOTO_MAX_BYTES = 64 * 1024;

/**
 * How long one photo fetch may take. The fetches run together, so this is the most
 * the photos can add to a tick, and it is far inside the five minute cadence.
 */
export const CARD_PHOTO_DEADLINE_MS = 5_000;

/** The slice of `fetch` this needs, injected so tests drive it without a network. */
export type PhotoFetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/**
 * The URL to fetch for the card: the stored one, asking for a modest square size
 * when it carries Google's size suffix, or null when it is not an https address.
 */
export function cardPhotoUrl(stored: string): string | null {
  let url: URL;
  try {
    url = new URL(stored.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return url.toString().replace(/=s\d+(-c)?$/, `=s${CARD_PHOTO_SIZE_PX}-c-rj`);
}

/** The type the BYTES are, from their signature, or null for anything else. */
function sniff(bytes: Uint8Array): CardPhoto["type"] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "JPEG";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) return "PNG";
  return null;
}

const DECLARED: Record<string, CardPhoto["type"]> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
};

/** Let go of a body this code has decided not to read. */
async function release(stream: { cancel(): Promise<void> } | null | undefined): Promise<void> {
  // swallow-ok: this only releases a body after a refusal that is already being
  // reported; a cancel that fails changes nothing about that refusal.
  await stream?.cancel().catch(() => {});
}

/** Read a body up to the ceiling, refusing as soon as it is passed. */
async function readCapped(res: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal.aborted) {
      await release(reader);
      throw new Error("photo read abandoned");
    }
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > CARD_PHOTO_MAX_BYTES) {
      await release(reader);
      throw new Error(`photo too large (over ${CARD_PHOTO_MAX_BYTES} bytes)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Base64 without a Node dependency, in chunks so a large image cannot blow the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * The photo for the card, or null. Every refusal and the timeout reach `onUnread`
 * exactly once, with a reason short enough for a log line.
 */
export async function fetchCardPhoto(
  url: string,
  fetcher: PhotoFetcher,
  onUnread: (err: unknown) => void,
  timer?: ScheduleTimer,
): Promise<CardPhoto | null> {
  const controller = new AbortController();
  return readWithinDeadline<CardPhoto>(
    async () => {
      const res = await fetcher(url, { signal: controller.signal });
      if (!res.ok) {
        await release(res.body);
        throw new Error(`photo answered ${res.status}`);
      }
      const mediaType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const declared = DECLARED[mediaType];
      if (!declared) {
        await release(res.body);
        throw new Error(`photo is not an image the card can carry (${mediaType || "no type"})`);
      }
      const length = Number(res.headers.get("content-length"));
      if (Number.isFinite(length) && length > CARD_PHOTO_MAX_BYTES) {
        await release(res.body);
        throw new Error(`photo too large (${length} bytes)`);
      }
      const bytes = await readCapped(res, controller.signal);
      if (bytes.length === 0) throw new Error("photo was empty");
      if (sniff(bytes) !== declared) throw new Error(`photo data does not match its declared type (${mediaType})`);
      return { type: declared, base64: toBase64(bytes) };
    },
    CARD_PHOTO_DEADLINE_MS,
    (err) => {
      // A timeout leaves the request running; abort it so it costs nothing more.
      controller.abort();
      onUnread(err);
    },
    timer,
  );
}
