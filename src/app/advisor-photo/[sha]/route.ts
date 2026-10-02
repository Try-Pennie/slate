import { isPhotoHash, fromBase64, sniffPhotoMime, type PhotoMime } from "@/lib/advisor-photos/core";
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
 * read from the database.
 *
 * HOW LONG A DEPARTED ADVISOR'S PHOTO CAN STILL BE SEEN, stated exactly: the edge
 * copy in `caches.default` is kept for EDGE_PHOTO_TTL_S (one hour), and a cache hit
 * answers without asking whether the holder is still active, so the edge can serve
 * it for up to an hour after deactivation. A BROWSER that already fetched it keeps
 * its own copy for up to a year (`immutable`), which is safe for correctness because
 * the address is the content, and is only ever a copy that browser already had.
 *
 * UNAUTHENTICATED VOLUME (L498): the hash shape is checked before anything reads, the
 * edge cache is keyed on the origin and path alone so a query string cannot force a
 * fresh read, and a miss is remembered for EDGE_MISS_TTL_S, so a repeated random
 * hash costs one database read a minute rather than one per request.
 */
const NOT_FOUND_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** How long the edge keeps a photo. Bounds how long a departed advisor can linger there. */
const EDGE_PHOTO_TTL_S = 60 * 60;
/** How long the edge remembers that a hash is not served. */
const EDGE_MISS_TTL_S = 60;

const BROWSER_PHOTO_CACHE = "public, max-age=31536000, immutable";

function edgeCache(): Cache | null {
  // `caches.default` exists on the Workers runtime only; under `next dev` there is
  // nothing to cache in and the database answers every time.
  const c = (globalThis as { caches?: { default?: Cache } }).caches;
  return c?.default ?? null;
}

function photoResponse(bytes: Uint8Array, mime: PhotoMime, cacheControl: string): Response {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": mime,
      "content-length": String(bytes.length),
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ sha: string }> }) {
  const { sha } = await params;
  // The shape is checked before anything reads, so a probe with a junk address
  // costs no database read and writes no log line.
  if (!isPhotoHash(sha)) return new Response("not found", { status: 404, headers: NOT_FOUND_HEADERS });

  const cache = edgeCache();
  const url = new URL(req.url);
  const key = new Request(`${url.origin}${url.pathname}`);
  if (cache) {
    // swallow-ok: a cache that cannot be read falls through to the database read
    // below, which answers the same bytes.
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) {
      if (hit.status !== 200) return new Response("not found", { status: 404, headers: NOT_FOUND_HEADERS });
      const bytes = new Uint8Array(await hit.arrayBuffer());
      const mime = sniffPhotoMime(bytes);
      if (mime) return photoResponse(bytes, mime, BROWSER_PHOTO_CACHE);
    }
  }

  let photo: Awaited<ReturnType<typeof loadServedPhoto>>;
  try {
    photo = await loadServedPhoto(sha);
  } catch (err) {
    // Never cached: a failed read says nothing about the hash.
    log.error("advisor-photo", { msg: "photo read failed" }, err);
    return new Response("unavailable", { status: 503, headers: NOT_FOUND_HEADERS });
  }
  if (!photo) {
    if (cache) {
      const miss = new Response(null, { status: 404, headers: { "cache-control": `public, max-age=${EDGE_MISS_TTL_S}` } });
      // swallow-ok: remembering a miss is only a saving; a failed put reads again next time.
      await cache.put(key, miss).catch(() => {});
    }
    return new Response("not found", { status: 404, headers: NOT_FOUND_HEADERS });
  }

  const bytes = fromBase64(photo.base64);
  // The type is taken from the bytes' own signature, never from the stored label.
  const mime = bytes ? sniffPhotoMime(bytes) : null;
  if (!bytes || !mime) {
    log.error("advisor-photo", { msg: "stored photo is not a readable image", sha256: sha });
    return new Response("unavailable", { status: 503, headers: NOT_FOUND_HEADERS });
  }

  if (cache) {
    // swallow-ok: the cache is an optimisation; a failed put serves the same bytes
    // from the database next time.
    await cache.put(key, photoResponse(bytes, mime, `public, max-age=${EDGE_PHOTO_TTL_S}`)).catch(() => {});
  }
  return photoResponse(bytes, mime, BROWSER_PHOTO_CACHE);
}
