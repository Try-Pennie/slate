/**
 * The advisor's photo, read from the Google Workspace directory (#2600).
 *
 * `users.avatar_url` only ever held a photo for somebody who had SIGNED INTO
 * Slate, and the roster is synced from Salesforce, so most agents never do:
 * measured 2026-09-22, 47 of 98 bookable agents. Slate already holds
 * domain-wide delegation to the Workspace for calendars, so the directory can
 * answer for the rest without anybody logging in.
 *
 * Three things were MEASURED against the live directory before this was built,
 * because each one decided the design:
 *
 *  - **The delegation can impersonate the AGENT**, not only an admin, so there
 *    is no admin subject to configure and no new environment variable.
 *  - **`thumbnailPhotoUrl` is fetchable with no auth**, so Slate stores nothing
 *    and proxies nothing: the URL goes straight into an `img`.
 *  - **The field is present for accounts with NO photo**, pointing at a
 *    placeholder Google generates. Counting the field is therefore counting the
 *    roster rather than counting photos (L67, L192), and the first pass at this
 *    reported 94 of 98 when the real answer is 84.
 */
import { getDelegatedToken } from "@/lib/google/dwd";
import { log } from "@/lib/log";

export const DIRECTORY_SCOPE =
  "https://www.googleapis.com/auth/admin.directory.user.readonly";

/**
 * The only host a real photo is served from.
 *
 * Google serves an UPLOADED photo from its user content host and a GENERATED
 * placeholder from its own, and that split was clean across all 94 agents
 * carrying the field on 2026-09-22: 84 user content, 10 generated. It is the
 * only signal that separates them. The dedicated photos endpoint does not:
 * `users/{key}/photos/thumbnail` answers 200 for the placeholders too, serving
 * them as ordinary image data, and 404s only for the four agents with no field
 * at all.
 *
 * Anything else is treated as NO photo, and that direction is deliberate. If
 * Google ever moves the host, Slate loses photos and falls back to its own
 * initials, rather than filling a lead-facing page with Google's grey blobs.
 */
const UPLOADED_PHOTO_HOST = "lh3.googleusercontent.com";

/**
 * A read that SUCCEEDED and found no photo is not the same answer as a read
 * that failed, and a caller must not be able to confuse them: one means this
 * agent has no photo, the other means we do not know (L215, L544). One value
 * carries both rather than two pieces of state beside each other.
 */
export type DirectoryPhoto =
  | { ok: true; url: string | null }
  /** `status` is the HTTP code when there was one, so a caller can tell a rate
   *  limit from a refusal without reading the message. Branching on message text
   *  is how an unknown failure ends up classified as a known one (L35). */
  | { ok: false; reason: string; status?: number };

/** The host rule, pure so it can be driven without a network or a token. */
export function uploadedPhotoUrl(thumbnailPhotoUrl: unknown): string | null {
  if (typeof thumbnailPhotoUrl !== "string" || thumbnailPhotoUrl === "") return null;
  let host: string;
  try {
    host = new URL(thumbnailPhotoUrl).host;
  } catch {
    // Not a URL at all. No photo, rather than a broken `src` on a lead's page.
    return null;
  }
  return host === UPLOADED_PHOTO_HOST ? thumbnailPhotoUrl : null;
}

/** How long one agent's answer is kept in this isolate. Photos change about
 *  never, and the manage page is reached repeatedly from one email. */
export const DIRECTORY_PHOTO_TTL_MS = 60 * 60 * 1000;

type Entry = { value: DirectoryPhoto; exp: number };
const cache = new Map<string, Entry>();

/** Only a SUCCESSFUL read is cached: caching a failure would hold an agent's
 *  page on the initials for an hour over one bad minute at Google. */
function remember(email: string, value: DirectoryPhoto, nowMs: number) {
  if (value.ok) cache.set(email, { value, exp: nowMs + DIRECTORY_PHOTO_TTL_MS });
}

/** Test seam: the suite drives this with its own fetch and clock. */
export interface DirectoryDeps {
  token: (email: string, scope: string) => Promise<string>;
  get: (url: string, token: string) => Promise<{ ok: boolean; status: number; body: unknown }>;
  nowMs: () => number;
}

export async function workspacePhotoUrl(
  email: string,
  deps: DirectoryDeps,
): Promise<DirectoryPhoto> {
  const now = deps.nowMs();
  const hit = cache.get(email);
  if (hit && hit.exp > now) return hit.value;

  let result: DirectoryPhoto;
  try {
    const token = await deps.token(email, DIRECTORY_SCOPE);
    const res = await deps.get(
      // `domain_public` is what a non admin may read, which is what the agent
      // impersonation above is. `admin_view` answers 403 for them.
      `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(email)}` +
        "?projection=full&viewType=domain_public",
      token,
    );
    if (!res.ok) {
      result = { ok: false, reason: `directory read ${res.status}`, status: res.status };
    } else {
      const body = res.body as { thumbnailPhotoUrl?: unknown } | null;
      result = { ok: true, url: uploadedPhotoUrl(body?.thumbnailPhotoUrl) };
    }
  } catch (err) {
    result = { ok: false, reason: err instanceof Error ? err.message : "directory read failed" };
  }
  remember(email, result, now);
  return result;
}

/** Wired to the real delegation. */
export function directoryDeps(): DirectoryDeps {
  return {
    token: (email, scope) => getDelegatedToken(email, scope),
    get: async (url, token) => {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const body = res.ok ? await res.json() : null;
      return { ok: res.ok, status: res.status, body };
    },
    nowMs: () => Date.now(),
  };
}

/**
 * The photo for one advisor, or null.
 *
 * Never throws and never surfaces a reason to the caller: the only consumer is
 * a lead-facing page whose fallback is the initials circle, so there is nothing
 * for anybody to do about a failure in the moment and nothing to say about it.
 * It is logged so a sustained one is findable.
 */
export async function advisorPhotoUrl(
  email: string | null,
  deps: DirectoryDeps = directoryDeps(),
): Promise<string | null> {
  if (!email) return null;
  const photo = await workspacePhotoUrl(email, deps);
  if (photo.ok) return photo.url;
  log.warn("directory-photo", { msg: "could not read a photo", reason: photo.reason });
  return null;
}

/** Test seam only: the cache is module scoped, so a suite must be able to empty it. */
export function clearDirectoryPhotoCache() {
  cache.clear();
}
