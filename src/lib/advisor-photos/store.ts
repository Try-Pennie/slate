/**
 * `advisor_photos` reads and writes (#3027), on the secret key client.
 *
 * The table holds the image BYTES, so this file decides which reads may carry
 * them. Only two may: the public photo route (one image by its hash) and the
 * reminder card (the images of the advisors a tick is reminding about). Every
 * other read takes the state and the hash and never the bytes, and
 * `scripts/test-advisor-photo-reads.ts` fails a `select("*")` or an embed of the
 * table anywhere else, so a page listing 136 people never drags 136 images with it.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap, unwrapCount } from "@/lib/db/result";
import type {
  FailedPhotoRow,
  FullPhotoRow,
  PhotoMime,
  PhotoSubjectUser,
  StoredPhotoState,
} from "@/lib/advisor-photos/core";
import type { PhotoWrites } from "@/lib/advisor-photos/refresh";
import type { PhotoRecord } from "@/lib/advisor-photos/resolve";

/** PostgREST carries `in()` in the URL, and 200 ids is measured safe (#2274 notes). */
const IN_CHUNK = 100;

function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Everybody the refresh may read for, active or not. `users` is roster bounded. */
export async function listPhotoSubjects(): Promise<PhotoSubjectUser[]> {
  const rows = unwrap(
    // any-advisor-ok: every face a booking can show is resolved, the placeholder's included.
    await supabaseAdmin().from("users").select("id, email, deactivated_at"),
    "advisor photo subjects",
  ) as { id: string; email: string; deactivated_at: string | null }[] | null;
  return (rows ?? []).map((r) => ({ id: r.id, email: r.email, deactivated_at: r.deactivated_at }));
}

/** What every row holds, without the image. One row per user, roster bounded. */
export async function listStoredPhotoStates(): Promise<StoredPhotoState[]> {
  const rows = unwrap(
    await supabaseAdmin().from("advisor_photos").select("user_id, state, sha256, failing_since"),
    "advisor photo states",
  ) as StoredPhotoState[] | null;
  return rows ?? [];
}

/**
 * The state and hash for these people, for a page to resolve. Throws on a failed
 * read; the caller turns that into the explicit `unreadable` state, never into
 * "nobody has a photo".
 */
export async function loadPhotoRecords(userIds: string[]): Promise<Map<string, PhotoRecord>> {
  const out = new Map<string, PhotoRecord>();
  for (const ids of chunks([...new Set(userIds)])) {
    if (ids.length === 0) continue;
    const rows = unwrap(
      await supabaseAdmin().from("advisor_photos").select("user_id, state, sha256").in("user_id", ids),
      "advisor photo records",
    ) as { user_id: string; state: "photo" | "none"; sha256: string | null }[] | null;
    for (const r of rows ?? []) out.set(r.user_id, { state: r.state, sha256: r.sha256 });
  }
  return out;
}

/**
 * One person's id and the photo Google gave them at sign in, the resolver's
 * fallback while the directory has not been read. Null when there is no such
 * user; throws on a failed read.
 */
export async function loadUserSignInPhoto(userId: string): Promise<{ id: string; avatar_url: string | null } | null> {
  return unwrap(
    await supabaseAdmin().from("users").select("id, avatar_url").eq("id", userId).maybeSingle(),
    "advisor sign in photo",
  ) as { id: string; avatar_url: string | null } | null;
}

/** The writes a real run makes. Each throws on a failed statement (fail loud). */
export function photoWrites(): PhotoWrites {
  const db = supabaseAdmin();
  return {
    // Every row in one call carries the same keys, so no column is nulled by a
    // sibling that happened to omit it (L705), and each is a FULL row rather than
    // a partial upsert (L685).
    async writeFull(rows: FullPhotoRow[]) {
      for (const part of chunks(rows, 25)) {
        unwrap(
          await db
            .from("advisor_photos")
            .upsert(part as unknown as Record<string, unknown>[], { onConflict: "user_id" })
            .select("user_id"),
          "advisor photo write",
        );
      }
    },
    async touch(userIds: string[], nowIso: string) {
      for (const ids of chunks(userIds)) {
        unwrapCount(
          await db
            .from("advisor_photos")
            .update({ checked_at: nowIso, last_error: null, failing_since: null }, { count: "exact" })
            .in("user_id", ids),
          "advisor photo touch",
        );
      }
    },
    async markFailed(rows: FailedPhotoRow[]) {
      for (const r of rows) {
        unwrapCount(
          await db
            .from("advisor_photos")
            .update({ last_error: r.last_error, failing_since: r.failing_since }, { count: "exact" })
            .eq("user_id", r.user_id),
          "advisor photo failure mark",
        );
      }
    },
    async deleteRows(userIds: string[]) {
      for (const ids of chunks(userIds)) {
        unwrapCount(
          await db.from("advisor_photos").delete({ count: "exact" }).in("user_id", ids),
          "advisor photo retention delete",
        );
      }
    },
  };
}

/**
 * The image for one content address, if a live advisor holds it. Null when no
 * active person's row carries that hash, so this read stops answering for a
 * deactivated advisor the moment they are deactivated, before the nightly run
 * deletes the row. The public route's edge copy can still serve it for up to an
 * hour after that, and a browser that already fetched it keeps its own copy (see
 * the route's header). Throws on a failed read.
 */
export async function loadServedPhoto(sha256: string): Promise<{ base64: string; mime: PhotoMime } | null> {
  const rows = unwrap(
    await supabaseAdmin()
      .from("advisor_photos")
      .select("bytes_b64, mime, users!inner(deactivated_at)")
      .eq("sha256", sha256)
      .eq("state", "photo")
      .is("users.deactivated_at", null)
      .limit(1),
    "advisor photo by hash",
  ) as { bytes_b64: string | null; mime: PhotoMime | null }[] | null;
  const hit = rows?.[0];
  if (!hit?.bytes_b64 || !hit.mime) return null;
  return { base64: hit.bytes_b64, mime: hit.mime };
}

/**
 * The stored images for the advisors a reminder tick is sending about, by user id.
 * Throws on a failed read; the reminder lane then sends every card with the logo.
 */
export async function loadCardPhotoRows(userIds: string[]): Promise<Map<string, { base64: string; mime: string }>> {
  const out = new Map<string, { base64: string; mime: string }>();
  for (const ids of chunks([...new Set(userIds)])) {
    if (ids.length === 0) continue;
    const rows = unwrap(
      await supabaseAdmin()
        .from("advisor_photos")
        .select("user_id, bytes_b64, mime")
        .eq("state", "photo")
        .in("user_id", ids),
      "advisor photos for reminder cards",
    ) as { user_id: string; bytes_b64: string | null; mime: string | null }[] | null;
    for (const r of rows ?? []) {
      if (r.bytes_b64 && r.mime) out.set(r.user_id, { base64: r.bytes_b64, mime: r.mime });
    }
  }
  return out;
}
