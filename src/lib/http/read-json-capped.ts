/**
 * Read a request's JSON body with a byte cap (#3135).
 *
 * `req.json()` buffers whatever arrives before it parses anything, so on a public route the
 * only bound on the body was the platform's own request ceiling. This stops reading at
 * `maxBytes`: a body that DECLARES a larger length is refused before a byte is read, and
 * since the declared length is only a claim, what arrives is counted as it streams and the
 * read is cancelled the moment it passes the cap.
 *
 * A body that is missing, unreadable, or not JSON comes back as `value: null`, which is what
 * every caller's `req.json().catch(() => null)` produced, so swapping one for the other
 * changes nothing but the cap. No imports, so a node test can drive it with real Requests.
 */
export type CappedJson = { tooLarge: true } | { tooLarge: false; value: unknown };

/** The cap for a public route's JSON body. Every such body is a small form or report. */
export const PUBLIC_JSON_MAX_BYTES = 16 * 1024;

/** A browser's CSP report can batch several violations, so its route allows more. */
export const CSP_REPORT_MAX_BYTES = 64 * 1024;

export async function readJsonCapped(req: Request, maxBytes: number): Promise<CappedJson> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true };
  if (!req.body) return { tooLarge: false, value: null };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling: the rest of the body is never read into memory.
        // swallow-ok: the answer is already decided (too large); a failed cancel of a
        // stream we are abandoning changes nothing the caller is told.
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { tooLarge: false, value: null };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { tooLarge: false, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { tooLarge: false, value: null };
  }
}
