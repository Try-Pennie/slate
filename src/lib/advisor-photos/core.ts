/**
 * The advisor photo refresh (#3027), as pure decisions.
 *
 * Slate keeps each advisor's photo as BYTES in `advisor_photos`, read once a day
 * from the Google Workspace directory as an admin, and serves them from its own
 * origin. Everything here decides; nothing here reads a network or a database,
 * so every outcome below is driven by a hand written fixture (L52 keeps the live
 * half in `pnpm verify:advisor-photos`).
 *
 * WHAT WAS MEASURED before any of this was written (2026-10-02, read only, as an
 * admin subject, over the whole directory of 251 accounts):
 *
 *  - `photos.get` answers 200 with a real image for every uploaded photo, AND for
 *    21 accounts it answers 200 with Google's grey slashed silhouette, an 800 byte
 *    PNG, byte identical across all 21. So a 200 is not proof of a photo, and that
 *    one image is held as a measured "no photo" by its hash below.
 *  - Nothing in the response's fields tells the silhouette apart (same keys, same
 *    width, an etag of the same shape). Only the bytes do.
 *  - The host of `thumbnailPhotoUrl` does not tell it apart either: 27 accounts on
 *    `lh3.google.com` hold real uploads. #2600's rule ("that host means a
 *    placeholder") dropped real photos, and it is deleted with this change.
 *  - An account with no photo at all answers 404 `Resource Not Found: photo`. An
 *    address the directory does not hold answers 404 `Resource Not Found: userKey`.
 *    Those are two different facts and are kept apart below.
 *  - Read as the AGENT rather than an admin, `photos.get` answers 403 for
 *    everybody. That is why #2600's 2026-09-22 reading differed.
 */

/**
 * Images Google serves as a photo that are really its "no photo" placeholder,
 * by the SHA-256 of their bytes. A read whose bytes hash to one of these is a
 * measured "none", never stored as a photo.
 *
 * Evidence, 2026-10-02: `photos.get` as an admin returned this exact 800 byte
 * 96x96 PNG (a grey silhouette with a slash through it) for 21 directory
 * accounts, byte identical in every case, while their real uploads hash
 * differently every time. None of the 21 was an active Slate user that day.
 *
 * A NEW placeholder Google starts serving would not be in this list. The
 * repeated image check below is what catches that: a placeholder is one image
 * held by many people.
 */
export const KNOWN_PLACEHOLDER_SHA256: ReadonlySet<string> = new Set([
  "091c0e2fe196a438759d5014383ed0f659a13e1b557eb6fa776f4f27a82ed12f",
]);

/**
 * How many active people may hold one identical image before a run stops
 * writing it as a NEW photo for anybody who did not already hold it.
 *
 * Three, because two is legitimate today: two advisors (measured 2026-10-02)
 * deliberately share one Pennie logo as their directory photo. A run reports
 * every image at or over this floor, with who holds it, as a repeated image
 * that may be a placeholder; it never silently stores or silently drops one.
 */
export const REPEATED_IMAGE_FLOOR = 3;

/**
 * The most people one run may move from a stored photo to "no photo". More than
 * this refuses every "no photo" write in the run and pages, because the measured
 * day to day rate is zero (0 of 129 on 2026-10-02) and a sudden wave of them is
 * far likelier to be Google answering wrongly than to be a dozen people deleting
 * their photos overnight (L211).
 */
export const FLIP_TO_NONE_LIMIT = 3;

/**
 * The largest image accepted, in bytes. Every photo measured on 2026-10-02 was
 * 96x96 and between 1.8 and 20 KB, so this is three times the largest real one
 * and refuses anything that is not a directory thumbnail.
 */
export const PHOTO_MAX_BYTES = 64 * 1024;

/**
 * A person whose read has failed on this many consecutive DAILY runs is paged by
 * name (L117: one person's failure must not hide inside a healthy total).
 */
export const FAILING_DAYS_BEFORE_PAGE = 3;

/**
 * The age of `failing_since` at which that is true. Three daily runs span two
 * days, and an hour is taken off so the third run is not missed by cron jitter.
 */
export const FAILING_PAGE_AFTER_MS = (FAILING_DAYS_BEFORE_PAGE - 1) * 24 * 60 * 60_000 - 60 * 60_000;

export type PhotoMime = "image/jpeg" | "image/png";

/** The type the BYTES are, by their signature, or null for anything else. */
export function sniffPhotoMime(bytes: Uint8Array): PhotoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) return "image/png";
  return null;
}

/**
 * Decode Google's `photoData`, which is base64 in the URL safe alphabet (`-` and
 * `_` where standard base64 has `+` and `/`), with or without padding. Null for
 * anything that is not exactly that, rather than a best effort decode that turns
 * a damaged string into a damaged image.
 */
export function decodeBase64Url(text: string): Uint8Array | null {
  const trimmed = text.replace(/=+$/, "");
  if (trimmed.length === 0 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  if (trimmed.length % 4 === 1) return null;
  const standard = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Standard base64, in chunks so a large image cannot blow the stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Standard base64 back to bytes, or null when it is not base64. */
export function fromBase64(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Lower case hex SHA-256, through Web Crypto so it runs on the Worker and in node. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The shape a content address must have before anything reads with it. */
export function isPhotoHash(text: string): boolean {
  return /^[0-9a-f]{64}$/.test(text);
}

/**
 * What one `photos.get` concluded. Four outcomes, because they send four
 * different people to do four different things (L11):
 *
 *   photo             an image to store
 *   none              the directory MEASURED that this person has no photo, or
 *                     served its known placeholder
 *   not-in-directory  the directory does not hold this address at all
 *   failed            nothing was learned; the stored row is left as it was
 */
export type PhotoRead =
  | {
      kind: "photo";
      base64: string;
      mime: PhotoMime;
      sha256: string;
      bytes: number;
      width: number | null;
      height: number | null;
    }
  | { kind: "none"; why: "no-photo" | "placeholder" }
  | { kind: "not-in-directory" }
  | {
      kind: "failed";
      reason: string;
      /** The HTTP status, when there was one. */
      status: number | null;
      /** 401 or 403: the subject is not allowed to read this, which no retry fixes. */
      refused: boolean;
    };

/** Whether a status is worth asking again for: a rate limit or a server error. */
export function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function shortBody(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * Classify one `photos.get` answer. The 404 bodies are matched on Google's own
 * message, measured 2026-10-02: `Resource Not Found: photo` for a person with no
 * photo and `Resource Not Found: userKey` for an address the directory lacks. A
 * 404 carrying neither is a failure, never assumed to be either.
 */
export async function readPhotoResponse(status: number, bodyText: string): Promise<PhotoRead> {
  if (status === 404) {
    if (bodyText.includes("Resource Not Found: photo")) return { kind: "none", why: "no-photo" };
    if (bodyText.includes("Resource Not Found: userKey")) return { kind: "not-in-directory" };
    return { kind: "failed", reason: `404 with an unrecognised body: ${shortBody(bodyText)}`, status, refused: false };
  }
  if (status === 401 || status === 403) {
    return { kind: "failed", reason: `refused with ${status}`, status, refused: true };
  }
  if (status !== 200) {
    return { kind: "failed", reason: `answered ${status}`, status, refused: false };
  }
  let body: { photoData?: unknown; width?: unknown; height?: unknown };
  try {
    body = JSON.parse(bodyText) as typeof body;
  } catch {
    return { kind: "failed", reason: "answered 200 with a body that is not JSON", status, refused: false };
  }
  if (typeof body?.photoData !== "string") {
    return { kind: "failed", reason: "answered 200 with no photo data", status, refused: false };
  }
  // The ceiling is judged on the TEXT first, so a huge answer is never decoded.
  if (body.photoData.length > Math.ceil((PHOTO_MAX_BYTES * 4) / 3) + 4) {
    return { kind: "failed", reason: `photo too large (over ${PHOTO_MAX_BYTES} bytes)`, status, refused: false };
  }
  const bytes = decodeBase64Url(body.photoData);
  if (!bytes || bytes.length === 0) {
    return { kind: "failed", reason: "photo data is not readable base64url", status, refused: false };
  }
  if (bytes.length > PHOTO_MAX_BYTES) {
    return { kind: "failed", reason: `photo too large (${bytes.length} bytes)`, status, refused: false };
  }
  const mime = sniffPhotoMime(bytes);
  if (!mime) {
    return { kind: "failed", reason: "photo data is not a JPEG or a PNG", status, refused: false };
  }
  const sha256 = await sha256Hex(bytes);
  if (KNOWN_PLACEHOLDER_SHA256.has(sha256)) return { kind: "none", why: "placeholder" };
  const dim = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  return {
    kind: "photo",
    base64: toBase64(bytes),
    mime,
    sha256,
    bytes: bytes.length,
    width: dim(body.width),
    height: dim(body.height),
  };
}

/** One Slate person the refresh may read for. */
export interface PhotoSubjectUser {
  id: string;
  email: string;
  /** False once deactivated: their row is deleted, never refreshed. */
  active: boolean;
}

/** What `advisor_photos` already holds for one person (never the bytes). */
export interface StoredPhotoState {
  user_id: string;
  state: "photo" | "none";
  sha256: string | null;
  failing_since: string | null;
}

/** A row written in full, because its state or its image changed (L685). */
export interface FullPhotoRow {
  user_id: string;
  state: "photo" | "none";
  bytes_b64: string | null;
  mime: PhotoMime | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  checked_at: string;
  changed_at: string;
  last_error: null;
  failing_since: null;
}

/** A failed read for somebody who already has a row: only these two columns move. */
export interface FailedPhotoRow {
  user_id: string;
  email: string;
  last_error: string;
  failing_since: string;
}

export interface RepeatedImage {
  sha256: string;
  /** Everybody holding it after this run's reads, sorted. */
  holders: string[];
  /** Those it was NOT written for, because they did not already hold it. */
  held: string[];
}

export interface RefreshCounts {
  /** People a read was attempted for. */
  attempted: number;
  photo: number;
  none: number;
  /** Of `none`, the reads that were Google's known placeholder. */
  placeholder: number;
  notInDirectory: number;
  failed: number;
  /** Never read or "no photo" before, a photo now. */
  gained: number;
  /** A photo before, "no photo" now (written only when the flip guard allows). */
  lost: number;
  /** A photo before and a different one now. */
  changed: number;
  unchanged: number;
  /** Rows of deactivated people, deleted. */
  deleted: number;
}

export interface RefreshPlan {
  full: FullPhotoRow[];
  /** Unchanged rows: `checked_at` moves and any failure marker clears, in one update. */
  touch: string[];
  /** Failed reads for people with a row; their stored image is left as it was. */
  failed: FailedPhotoRow[];
  /** Failed reads for people with no row yet, so nothing can carry the streak. */
  failedNeverRead: { email: string; reason: string }[];
  deleteIds: string[];
  flipGuardTripped: boolean;
  /** The "no photo" writes the flip guard withheld, by address. */
  heldNone: string[];
  repeated: RepeatedImage[];
  notInDirectory: string[];
  /** People failing for FAILING_DAYS_BEFORE_PAGE daily runs in a row. */
  streaks: { email: string; failingSince: string; reason: string }[];
  counts: RefreshCounts;
}

export interface PlanInput {
  nowMs: number;
  users: PhotoSubjectUser[];
  rows: StoredPhotoState[];
  /** One read per person the run asked about, keyed by user id. */
  reads: Map<string, PhotoRead>;
  /**
   * True on a full run, which owns retention: deactivated people's rows are
   * deleted. A run for one person never deletes anybody else's row.
   */
  full: boolean;
}

/**
 * Turn one run's reads into the writes it will make, with every refusal guard
 * applied BEFORE any write (L211). Pure: the caller applies the plan.
 */
export function planRefresh(input: PlanInput): RefreshPlan {
  const nowIso = new Date(input.nowMs).toISOString();
  const rowBy = new Map(input.rows.map((r) => [r.user_id, r]));
  const userBy = new Map(input.users.map((u) => [u.id, u]));
  const counts: RefreshCounts = {
    attempted: input.reads.size,
    photo: 0,
    none: 0,
    placeholder: 0,
    notInDirectory: 0,
    failed: 0,
    gained: 0,
    lost: 0,
    changed: 0,
    unchanged: 0,
    deleted: 0,
  };

  // Who holds which image once this run is applied, for the repeated image check:
  // this run's read where there is one, the stored row otherwise. Active people
  // only, since a deactivated row is about to be deleted.
  const holdersBySha = new Map<string, Set<string>>();
  for (const u of input.users) {
    if (!u.active) continue;
    const read = input.reads.get(u.id);
    let sha: string | null = null;
    if (read?.kind === "photo") sha = read.sha256;
    else if (!read || read.kind === "failed" || read.kind === "not-in-directory") {
      const row = rowBy.get(u.id);
      sha = row?.state === "photo" ? row.sha256 : null;
    }
    if (!sha) continue;
    if (!holdersBySha.has(sha)) holdersBySha.set(sha, new Set());
    holdersBySha.get(sha)!.add(u.email);
  }
  const repeatedShas = new Set(
    [...holdersBySha].filter(([, holders]) => holders.size >= REPEATED_IMAGE_FLOOR).map(([sha]) => sha),
  );

  // The flip guard, counted before anything is decided.
  const wouldLose = [...input.reads].filter(([id, read]) => read.kind === "none" && rowBy.get(id)?.state === "photo");
  const flipGuardTripped = wouldLose.length > FLIP_TO_NONE_LIMIT;

  const full: FullPhotoRow[] = [];
  const touch: string[] = [];
  const failed: FailedPhotoRow[] = [];
  const failedNeverRead: { email: string; reason: string }[] = [];
  const heldNone: string[] = [];
  const notInDirectory: string[] = [];
  const streaks: RefreshPlan["streaks"] = [];
  const heldRepeated = new Map<string, string[]>();

  for (const [userId, read] of input.reads) {
    const user = userBy.get(userId);
    if (!user) continue;
    const row = rowBy.get(userId);
    switch (read.kind) {
      case "photo": {
        counts.photo += 1;
        if (row?.state === "photo" && row.sha256 === read.sha256) {
          counts.unchanged += 1;
          touch.push(userId);
          break;
        }
        if (repeatedShas.has(read.sha256)) {
          // Not written for somebody who did not already hold it. Their row, if
          // any, is left exactly as it was, and the image is reported.
          if (!heldRepeated.has(read.sha256)) heldRepeated.set(read.sha256, []);
          heldRepeated.get(read.sha256)!.push(user.email);
          break;
        }
        if (row?.state === "photo") counts.changed += 1;
        else counts.gained += 1;
        full.push({
          user_id: userId,
          state: "photo",
          bytes_b64: read.base64,
          mime: read.mime,
          sha256: read.sha256,
          width: read.width,
          height: read.height,
          checked_at: nowIso,
          changed_at: nowIso,
          last_error: null,
          failing_since: null,
        });
        break;
      }
      case "none": {
        counts.none += 1;
        if (read.why === "placeholder") counts.placeholder += 1;
        if (row?.state === "none") {
          counts.unchanged += 1;
          touch.push(userId);
          break;
        }
        if (flipGuardTripped) {
          heldNone.push(user.email);
          break;
        }
        if (row?.state === "photo") counts.lost += 1;
        full.push({
          user_id: userId,
          state: "none",
          bytes_b64: null,
          mime: null,
          sha256: null,
          width: null,
          height: null,
          checked_at: nowIso,
          changed_at: nowIso,
          last_error: null,
          failing_since: null,
        });
        break;
      }
      case "not-in-directory": {
        // A separate failure that never writes a row: the person may well have a
        // photo, Slate simply cannot find them in the directory.
        counts.notInDirectory += 1;
        notInDirectory.push(user.email);
        break;
      }
      case "failed": {
        counts.failed += 1;
        if (!row) {
          failedNeverRead.push({ email: user.email, reason: read.reason });
          break;
        }
        const since = row.failing_since ?? nowIso;
        failed.push({ user_id: userId, email: user.email, last_error: read.reason, failing_since: since });
        const sinceMs = Date.parse(since);
        // parse-ok: a stored stamp that will not parse reads as failing for ever,
        // which pages (the fail safe side), never as healthy.
        if (!Number.isFinite(sinceMs) || input.nowMs - sinceMs >= FAILING_PAGE_AFTER_MS) {
          streaks.push({ email: user.email, failingSince: since, reason: read.reason });
        }
        break;
      }
    }
  }

  const deleteIds = input.full
    ? input.users.filter((u) => !u.active && rowBy.has(u.id)).map((u) => u.id)
    : [];
  counts.deleted = deleteIds.length;

  const repeated: RepeatedImage[] = [...repeatedShas].sort().map((sha) => ({
    sha256: sha,
    holders: [...holdersBySha.get(sha)!].sort(),
    held: (heldRepeated.get(sha) ?? []).sort(),
  }));

  return {
    full,
    touch,
    failed,
    failedNeverRead,
    deleteIds,
    flipGuardTripped,
    heldNone: heldNone.sort(),
    repeated,
    notInDirectory: notInDirectory.sort(),
    streaks: streaks.sort((a, b) => a.email.localeCompare(b.email)),
    counts,
  };
}
