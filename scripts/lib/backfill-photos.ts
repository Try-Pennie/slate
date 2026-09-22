/**
 * The decision half of the advisor photo backfill (#2600), separated from the
 * wiring so it can be driven with no network, no database and no real waiting.
 *
 * The sleep is INJECTED rather than a bare setTimeout, so the rate limit
 * retry can be tested by reading back the delays it asked for instead of a
 * suite that genuinely waits seconds to prove a backoff exists (L524).
 */
import type { DirectoryPhoto } from "@/lib/google/directory";

export interface BackfillUser {
  id: string;
  email: string;
  avatar_url: string | null;
}

export interface BackfillDeps {
  /** Every ACTIVE user, whatever their photo state. */
  listUsers: () => Promise<BackfillUser[]>;
  photoFor: (email: string) => Promise<DirectoryPhoto>;
  /** Resolves to an error message when the write failed, else null. */
  write: (id: string, url: string) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  apply: boolean;
}

export interface BackfillTuning {
  paceMs: number;
  backoffMs: number;
  maxRetries: number;
}

/** Measured 2026-09-22: an unpaced run met 429 on roughly a third of the roster. */
export const DEFAULT_TUNING: BackfillTuning = { paceMs: 250, backoffMs: 1_500, maxRetries: 4 };

export interface BackfillResult {
  active: number;
  alreadyHad: number;
  hadNone: number;
  /** Written, or that would be written on a dry run. */
  filled: number;
  /** The directory answered, and this agent has no photo. */
  noPhoto: number;
  /** Nobody asked successfully, so this is NOT a fact about the agent. */
  couldNotRead: string[];
  writeFailed: string[];
}

export async function runBackfill(
  deps: BackfillDeps,
  tuning: BackfillTuning = DEFAULT_TUNING,
): Promise<BackfillResult> {
  const users = await deps.listUsers();
  const has = (u: BackfillUser) => (u.avatar_url ?? "").trim().length > 0;
  const empty = users.filter((u) => !has(u));

  const out: BackfillResult = {
    active: users.length,
    alreadyHad: users.length - empty.length,
    hadNone: empty.length,
    filled: 0,
    noPhoto: 0,
    couldNotRead: [],
    writeFailed: [],
  };

  for (const user of empty) {
    let got: DirectoryPhoto | null = null;
    for (let attempt = 0; ; attempt++) {
      got = await deps.photoFor(user.email);
      // Finite, because a read that retries for ever hangs the run (L110). The
      // branch is on the STATUS rather than the message, so an unknown failure
      // is never classified as a known one (L35).
      if (got.ok || got.status !== 429 || attempt >= tuning.maxRetries) break;
      await deps.sleep(tuning.backoffMs * (attempt + 1));
    }
    await deps.sleep(tuning.paceMs);

    if (!got.ok) {
      // NOT counted as having no photo: nobody asked. Named, so a second run can
      // be pointed at exactly these (L11).
      out.couldNotRead.push(`${user.email}: ${got.reason}`);
      continue;
    }
    if (got.url === null) {
      out.noPhoto++;
      continue;
    }
    if (!deps.apply) {
      out.filled++;
      continue;
    }
    const failure = await deps.write(user.id, got.url);
    if (failure) out.writeFailed.push(`${user.email}: ${failure}`);
    else out.filled++;
  }

  return out;
}

/**
 * The exit code. A run that read NOBODY has measured nothing and must not read
 * as a clean sweep (L98), and that is distinct from a run whose writes failed.
 */
export function backfillExitCode(result: BackfillResult, apply: boolean): number {
  // "Nothing was READ" is about the directory, not about what was written. The
  // first version asked whether anything had been FILLED, which reported a run
  // whose reads all succeeded and whose writes were all refused as having read
  // nobody: a true statement about the outcome and a false one about the cause,
  // sending somebody to look at Google when the problem was the database (L11).
  if (result.hadNone > 0 && result.couldNotRead.length === result.hadNone) return 2;
  if (apply && result.writeFailed.length > 0) return 1;
  return 0;
}
