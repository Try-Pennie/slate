/**
 * One advisor photo refresh run (#3027): read the directory, read each photo,
 * plan, and (unless this is a dry run) write.
 *
 * Every collaborator is injected, so the daily lane, the admin's manual trigger,
 * the per agent "Refresh from Google" and `pnpm verify:advisor-photos` all run
 * THIS function, guards included. The verify command passes `writes: null`, so
 * it sees exactly what a real run would refuse and never writes.
 */
import {
  isRetriableStatus,
  planRefresh,
  readPhotoResponse,
  type FailedPhotoRow,
  type FullPhotoRow,
  type PhotoRead,
  type PhotoSubjectUser,
  type RefreshPlan,
  type StoredPhotoState,
} from "./core.ts";

/** The directory's answer for one account, as `users.list` returns it. */
export interface DirectoryAccount {
  primaryEmail: string;
  emails?: { address?: string }[];
}

/**
 * A directory call that answered with an HTTP status. `refused` covers both a
 * 401/403 and a token the subject could not be issued (`invalid_grant`,
 * `unauthorized_client`), which mean the same thing to whoever has to act: the
 * subject is not allowed to read the directory.
 */
export class DirectoryReadError extends Error {
  readonly status: number | null;
  readonly refused: boolean;
  constructor(message: string, status: number | null, refused: boolean) {
    super(message);
    this.name = "DirectoryReadError";
    this.status = status;
    this.refused = refused;
  }
}

export interface PhotoWrites {
  writeFull(rows: FullPhotoRow[]): Promise<void>;
  touch(userIds: string[], nowIso: string): Promise<void>;
  markFailed(rows: FailedPhotoRow[]): Promise<void>;
  deleteRows(userIds: string[]): Promise<void>;
}

export interface RefreshDeps {
  /** `DIRECTORY_ADMIN_SUBJECT`, raw; missing or blank refuses by name. */
  subject: string | undefined;
  listUsers(): Promise<PhotoSubjectUser[]>;
  listRows(): Promise<StoredPhotoState[]>;
  /** Every account in the directory, all domains. Throws `DirectoryReadError`. */
  listDirectory(subject: string): Promise<DirectoryAccount[]>;
  /** One `photos.get`. Throws `DirectoryReadError` on a token refusal, anything else on a network fault. */
  getPhoto(subject: string, email: string): Promise<{ status: number; body: string }>;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
  /** Null on a dry run: everything is decided and nothing is written. */
  writes: PhotoWrites | null;
}

export interface RefreshOptions {
  /** Refresh one person only, by user id. */
  only?: string;
}

/** How a rate limit or a server error is retried (finite, L110). */
export const PHOTO_RETRY = { attempts: 3, backoffMs: 2_000 } as const;

export type RefusedWhy =
  /** `DIRECTORY_ADMIN_SUBJECT` is missing or blank. */
  | "no-subject"
  /** Slate's own users or photo rows could not be read. */
  | "slate-unreadable"
  /** The subject is not allowed to read the directory. */
  | "subject-refused"
  /** The directory listing failed for another reason (5xx, timeout, rate limit). */
  | "directory-unreadable"
  /** The listing worked and every photo read failed, so nothing was measured. */
  | "nothing-read"
  /** The one person asked about is not in Slate, or is deactivated. */
  | "unknown-user";

export type RefreshOutcome =
  | { status: "refused"; why: RefusedWhy; detail: string }
  | {
      status: "measured";
      plan: RefreshPlan;
      /** False on a dry run. */
      applied: boolean;
      /** A full run that read something and did not trip the flip guard. */
      verdict: boolean;
    };

function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

/** Every address the directory holds, primary and alias, lower case. */
export function directoryAddresses(accounts: DirectoryAccount[]): Set<string> {
  const out = new Set<string>();
  for (const a of accounts) {
    if (a.primaryEmail) out.add(normEmail(a.primaryEmail));
    for (const e of a.emails ?? []) if (e.address) out.add(normEmail(e.address));
  }
  return out;
}

async function readOne(deps: RefreshDeps, subject: string, email: string): Promise<PhotoRead> {
  for (let attempt = 1; ; attempt++) {
    let res: { status: number; body: string };
    try {
      res = await deps.getPhoto(subject, email);
    } catch (err) {
      if (err instanceof DirectoryReadError) {
        return { kind: "failed", reason: err.message, status: err.status, refused: err.refused };
      }
      const reason = err instanceof Error ? err.message : String(err);
      if (attempt < PHOTO_RETRY.attempts) {
        await deps.sleep(PHOTO_RETRY.backoffMs * attempt);
        continue;
      }
      return { kind: "failed", reason: `no answer: ${reason}`, status: null, refused: false };
    }
    if (isRetriableStatus(res.status) && attempt < PHOTO_RETRY.attempts) {
      await deps.sleep(PHOTO_RETRY.backoffMs * attempt);
      continue;
    }
    return readPhotoResponse(res.status, res.body);
  }
}

export async function runPhotoRefresh(deps: RefreshDeps, opts: RefreshOptions = {}): Promise<RefreshOutcome> {
  const subject = deps.subject?.trim();
  if (!subject) {
    return {
      status: "refused",
      why: "no-subject",
      detail: "DIRECTORY_ADMIN_SUBJECT is not set, so there is nobody to read the directory as",
    };
  }

  let users: PhotoSubjectUser[];
  let rows: StoredPhotoState[];
  try {
    [users, rows] = await Promise.all([deps.listUsers(), deps.listRows()]);
  } catch (err) {
    return { status: "refused", why: "slate-unreadable", detail: err instanceof Error ? err.message : String(err) };
  }

  const full = !opts.only;
  let targets = users.filter((u) => u.active);
  if (opts.only) {
    targets = targets.filter((u) => u.id === opts.only);
    if (targets.length === 0) {
      return { status: "refused", why: "unknown-user", detail: "that person is not an active Slate user" };
    }
  }

  // A full run asks the directory who exists first, so a "no photo" answer is only
  // ever believed for somebody the listing confirmed. One person's refresh skips
  // the listing: its own 404 body already says which of the two it is.
  let inDirectory: Set<string> | null = null;
  if (full) {
    try {
      inDirectory = directoryAddresses(await deps.listDirectory(subject));
    } catch (err) {
      const refused = err instanceof DirectoryReadError && err.refused;
      return {
        status: "refused",
        why: refused ? "subject-refused" : "directory-unreadable",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (inDirectory.size === 0) {
      return { status: "refused", why: "directory-unreadable", detail: "the directory listing came back empty" };
    }
  }

  const reads = new Map<string, PhotoRead>();
  for (const u of targets) {
    if (inDirectory && !inDirectory.has(normEmail(u.email))) {
      reads.set(u.id, { kind: "not-in-directory" });
      continue;
    }
    reads.set(u.id, await readOne(deps, subject, u.email));
  }

  const asked = [...reads.values()].filter((r) => r.kind !== "not-in-directory");
  const learned = asked.filter((r) => r.kind === "photo" || r.kind === "none");
  if (asked.length > 0 && learned.length === 0) {
    const allRefused = asked.every((r) => r.kind === "failed" && r.refused);
    const first = asked[0] as Extract<PhotoRead, { kind: "failed" }>;
    return {
      status: "refused",
      why: allRefused ? "subject-refused" : "nothing-read",
      detail: `${asked.length} photo ${asked.length === 1 ? "read" : "reads"} failed, the first with: ${first.reason}`,
    };
  }

  const plan = planRefresh({ nowMs: deps.nowMs(), users, rows, reads, full });

  if (deps.writes) {
    const nowIso = new Date(deps.nowMs()).toISOString();
    if (plan.full.length) await deps.writes.writeFull(plan.full);
    if (plan.touch.length) await deps.writes.touch(plan.touch, nowIso);
    if (plan.failed.length) await deps.writes.markFailed(plan.failed);
    if (plan.deleteIds.length) await deps.writes.deleteRows(plan.deleteIds);
  }

  return {
    status: "measured",
    plan,
    applied: deps.writes !== null,
    verdict: full && learned.length > 0 && !plan.flipGuardTripped,
  };
}

/** Whether a measured run left anything a person has to look at. */
export function needsAttention(plan: RefreshPlan): boolean {
  return (
    plan.flipGuardTripped ||
    plan.repeated.length > 0 ||
    plan.streaks.length > 0 ||
    // Somebody never read has no row to carry a streak, so the run their read
    // fails on is the only one that can name them.
    plan.failedNeverRead.length > 0 ||
    plan.notInDirectory.length > 0
  );
}
