import { isPhotoHash, fromBase64, sniffPhotoMime } from "@/lib/advisor-photos/core";
import { loadServedPhoto } from "@/lib/advisor-photos/store";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * GET /advisor-photo/{sha256}: one advisor photo, by the SHA-256 of its bytes (#3027).
 *
 * WHO MAY CALL: anybody. A lead's manage page and the roster both draw from it, and
 * it is on Slate's own origin so the content security policy's `img-src 'self'`
 * allows it, where a Google hosted image was a violation.
 *
 * WHOSE DATA: one image and nothing else. The address is the hash of the image, so
 * it names no person and no user id, and it cannot be guessed without already
 * holding the image. Only a hash a live (non deactivated) advisor's row holds is
 * served, so somebody who leaves stops being served the day they are deactivated.
 *
 * `immutable` is safe because the address IS the content: a changed photo has a
 * different hash and so a different address. `caches.default` sits in front of the
 * database read on the Worker, keyed on the URL.
 */
const NOT_FOUND_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function edgeCache(): Cache | null {
  // `caches.default` exists on the Workers runtime only; under `next dev` there is
  // nothing to cache in and the database answers every time.
  const c = (globalThis as { caches?: { default?: Cache } }).caches;
  return c?.default ?? null;
}

export async function GET(req: Request, { params }: { params: Promise<{ sha: string }> }) {
  const { sha } = await params;
  // The shape is checked before anything reads, so a probe with a junk address
  // costs no database read and writes no log line.
  if (!isPhotoHash(sha)) return new Response("not found", { status: 404, headers: NOT_FOUND_HEADERS });

  const cache = edgeCache();
  if (cache) {
    // swallow-ok: a cache that cannot be read falls through to the database read
    // below, which answers the same bytes.
    const hit = await cache.match(req).catch(() => undefined);
    if (hit) return hit;
  }

  let photo: Awaited<ReturnType<typeof loadServedPhoto>>;
  try {
    photo = await loadServedPhoto(sha);
  } catch (err) {
    log.error("advisor-photo", { msg: "photo read failed" }, err);
    return new Response("unavailable", { status: 503, headers: NOT_FOUND_HEADERS });
  }
  if (!photo) return new Response("not found", { status: 404, headers: NOT_FOUND_HEADERS });

  const bytes = fromBase64(photo.base64);
  // The type is taken from the bytes' own signature, never from the stored label.
  const mime = bytes ? sniffPhotoMime(bytes) : null;
  if (!bytes || !mime) {
    log.error("advisor-photo", { msg: "stored photo is not a readable image", sha256: sha });
    return new Response("unavailable", { status: 503, headers: NOT_FOUND_HEADERS });
  }

  // `fromBase64` allocates a fresh array, so its buffer is exactly these bytes.
  const res = new Response(bytes.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "content-type": mime,
      "content-length": String(bytes.length),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
  if (cache) {
    // swallow-ok: the cache is an optimisation; a failed put serves the same bytes
    // from the database next time.
    await cache.put(req, res.clone()).catch(() => {});
  }
  return res;
}
