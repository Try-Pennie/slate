/**
 * A file a run may or may not have produced, read three ways that each send a reader
 * somewhere different (L11): absent (the leg was not asked for, or never wrote it),
 * read, or there and unreadable. An unreadable file is never folded into absent,
 * which would say the evidence never arrived when it arrived and could not be used.
 *
 * Shared by every optional artifact the judge reads (the cold leg's results, #3354,
 * and the burst tail, #3416), so the line between "never arrived" and "could not be
 * read" is drawn one way (L41).
 */
export type OptionalText = { kind: "absent" } | { kind: "unreadable"; why: string } | { kind: "read"; text: string };

export function readOptionalText(read: () => string): OptionalText {
  try {
    return { kind: "read", text: read() };
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", why: err instanceof Error ? err.message : String(err) };
  }
}
