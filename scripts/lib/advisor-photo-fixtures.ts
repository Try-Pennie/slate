// Fixtures for the advisor photo suites (#3027).
//
// GOOGLE_PLACEHOLDER_PNG_B64 is the REAL image `photos.get` returned, as an admin,
// for 21 directory accounts on 2026-10-02: Google's grey slashed silhouette, 800
// bytes, byte identical in every case. It is a generic Google asset, not anybody's
// photo. It is kept here so the suite proves the known placeholder hash really is
// the hash of what Google serves, rather than of a string somebody typed (L48).
//
// Every other image here is SYNTHETIC: a valid signature followed by filler, so no
// real person's photo is ever committed.

export const GOOGLE_PLACEHOLDER_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAAAAADH8yjkAAAAAXNCSVQI5gpbmQAAAtpJREFUaIHt2dty2jAQBuD9ZQiQkDItpU0zhRz6/q/UukOYzpAASTgEjK3tBSEFLMkrAxeZ2lcJlvaTjGRpBUI67qWOHL8ACqAACqAA3gdQ8isOIuKjAcAiihGcVNjDkAMqHj4lICIOGp9KWtyqUBr/4UHh9W/WzZZUsPQAqYcQLoJ/d4PhtCNtmDH6z+HO5wijrU9UFIJElwEAh/p+sB2vF+/EQ9yTjfB0KehfCYItAeNJqr2YjEV9SAM6TEC0JaAfpIpR0M8HoL96GhsCpktT1XgqEVIAfztdjcBNwVgVE0F80yNq7wpcuzKO+pdcPTAK1Y5BQCSIb5wHUkH0RjIOZqGQc5jKhXJ+QCRwTfKMbPNdIHBdEN++ZGYLwdk+PcgWdEsQ3rnouwWuNvIPU4HAqi1b05wvdbugg5v8C062wEnjNr2o5gHMQlK/uRBvXDJ3Fao7W0VOWs2VBZDHxihzYTX0QWuPjVf2yp0WvC5Blf0ESY29BFGFfQRZ+T0EYXHu1DmfINi+g5DM5uv/gntqivfuEgBYjMcL4G0F9hQyAKUfR5GirZ2jn+AEwP0RqdS+1EtwAWrUh/Eb9RHsAOLfkW3AeAhWQE3vzM33FGwAxj1DTpBDsDQSc3d8+YyzFbrLiC8WzGUwEHRfJliAR0njRIK5xDIWxJcJ5gJK+MYUCBbgMjmUYL7N9Y/CiZop2BKQr6LsQiDYE5DyYQTrPb46jOC4dV09xPfgALjTOMBYciYgF5fCXahDcCcg5z9qGZ3QWbsZ9yBm1f6u7N8E62BjR2Y5kwndLSTgebBQpsqsK5/PGa/5A6vbfAAR8PL0zNg6mmBifGjUmNcZCpeuLbWzASKAZrPZXL+dmwaV07PaOs9R3Zni0rUlaZMezIJA8TLWGlClcol44zBHdacnlvZ7nPyulNW121b154s1qfU6fbdNCu1IOg/z+4FjOr7/X0AKoAAKoAD+C+Av9xxqcGBe/eMAAAAASUVORK5CYII=";

/** Synthetic image bytes with a real signature, distinguished by `seed`. */
export function fakeImage(kind: "jpeg" | "png", seed: number, size = 2048): Uint8Array {
  const head = kind === "jpeg" ? [0xff, 0xd8, 0xff, 0xe0] : [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const out = new Uint8Array(size);
  out.set(head);
  for (let i = head.length; i < size; i++) out[i] = (i * 31 + seed * 97) % 256;
  return out;
}

/** Base64 in Google's URL safe alphabet, unpadded, the way `photoData` arrives. */
export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A `photos.get` 200 body for these bytes. */
export function photoBody(bytes: Uint8Array, mimeType = "image/jpeg"): string {
  return JSON.stringify({
    kind: "admin#directory#user#photo",
    id: "1",
    etag: '"e"',
    primaryEmail: "x@example.test",
    mimeType,
    height: 96,
    width: 96,
    photoData: base64url(bytes),
  });
}

/** The two 404 bodies Google returned on 2026-10-02, verbatim apart from spacing. */
export const NO_PHOTO_404 =
  '{ "error": { "code": 404, "message": "Resource Not Found: photo", "errors": [ { "message": "Resource Not Found: photo", "domain": "global", "reason": "notFound" } ] } }';
export const NO_USER_404 =
  '{ "error": { "code": 404, "message": "Resource Not Found: userKey", "errors": [ { "message": "Resource Not Found: userKey", "domain": "global", "reason": "notFound" } ] } }';
export const FORBIDDEN_403 =
  '{ "error": { "code": 403, "message": "Not Authorized to access this resource/api", "errors": [ { "message": "Not Authorized to access this resource/api", "domain": "global", "reason": "forbidden" } ] } }';
