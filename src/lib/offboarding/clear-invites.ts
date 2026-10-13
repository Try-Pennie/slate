/**
 * Remove a departed advisor's invites before their Google account is archived (#3667).
 *
 * Offboarding archives the advisor in Google Workspace, and from a minute or two
 * after that Google refuses every change to their calendar (`403 notACalendarUser`).
 * The coverage sweep moves each call to another advisor and then deletes the old
 * invite, but it runs after the archive has landed, so every delete was refused and
 * the lead kept the departed advisor's invite beside the new advisor's one. Measured
 * on 2026-10-13: an archived organizer's delete is refused, and the guest's calendar
 * keeps the event. While the organizer still has Calendar, the same silent delete
 * removes it from a Google guest's calendar too.
 *
 * So the deactivate call clears the invites FIRST, while Google still answers. The
 * offboarding automation waits 10 seconds after telling Slate before it archives
 * (Dan, 2026-10-13), and this runs inside a budget well short of that, then returns
 * whatever it has, so the reply always lands inside the wait.
 *
 * Each invite is judged on its own (L767): one refused or slow delete never stops
 * the others. The count is the answer, never a bare success: `failed` were refused,
 * `unanswered` were still waiting on Google when the budget ran out (they may yet
 * land), and `notStarted` were never tried. Anything not cleared here is still
 * removed, or queued for the retry drain, by the sweep's own reassign, exactly as
 * before. A failed read of the bookings THROWS rather than reading as nothing to
 * clear.
 *
 * Pure: the bookings read, the delete, the clock and the wait are all passed in, so
 * the budget is driven by a test without waiting for real (L524).
 */

/** One invite on a departed advisor's calendar for a call still ahead. */
export interface LeaverInvite {
  bookingId: string;
  eventId: string;
  /** The departed advisor's address: the event lives on their calendar. */
  organizerEmail: string;
}

export interface ClearInvitesDeps {
  loadInvites: () => Promise<LeaverInvite[]>;
  /** Delete one invite without emailing the lead. Throws when Google refuses. */
  deleteInvite: (organizerEmail: string, eventId: string) => Promise<void>;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  budgetMs: number;
  concurrency: number;
}

export interface ClearInvitesResult {
  total: number;
  cleared: number;
  failed: number;
  unanswered: number;
  notStarted: number;
}

/**
 * How long the deactivate call spends clearing invites: well inside the 10 seconds
 * the offboarding automation waits before it archives the Google account, leaving
 * room for the lookup before this and the reply after it.
 */
export const CLEAR_INVITES_BUDGET_MS = 6_000;

/** Deletes in flight at once: enough that a typical leaver's handful clears in a second. */
export const CLEAR_INVITES_CONCURRENCY = 5;

export async function clearLeaverInvites(deps: ClearInvitesDeps): Promise<ClearInvitesResult> {
  // The clock starts BEFORE the reads, so a slow lookup spends the budget too and the
  // reply still lands inside the automation's wait.
  const startMs = deps.nowMs();
  const spent = () => deps.nowMs() - startMs >= deps.budgetMs;
  const remaining = () => Math.max(0, deps.budgetMs - (deps.nowMs() - startMs));
  // The read is raced against the budget too, so a hung lookup cannot hold the reply
  // past the automation's wait. It throws, which the caller reports as failed.
  const loading = deps.loadInvites();
  const loaded = await Promise.race([loading, deps.sleep(remaining()).then(() => null)]);
  if (loaded === null) {
    loading.catch(() => {}); // the read may still settle; nothing is waiting for it
    throw new Error("offboarding clear invites: the bookings read did not answer within the budget");
  }
  const invites: LeaverInvite[] = loaded;
  const total = invites.length;
  if (total === 0) return { total, cleared: 0, failed: 0, unanswered: 0, notStarted: 0 };
  let next = 0;
  let inFlight = 0;
  let cleared = 0;
  let failed = 0;

  const worker = async () => {
    while (next < invites.length && !spent()) {
      const invite = invites[next++]!;
      inFlight++;
      try {
        await deps.deleteInvite(invite.organizerEmail, invite.eventId);
        cleared++;
      } catch {
        failed++;
      } finally {
        inFlight--;
      }
    }
  };

  const workers = Promise.all(Array.from({ length: Math.min(deps.concurrency, total) }, worker));
  await Promise.race([workers, deps.sleep(remaining())]);
  // A snapshot: a delete still in flight may land after this returns, and is
  // counted as unanswered because nothing here saw it answer.
  return { total, cleared, failed, unanswered: inFlight, notStarted: total - cleared - failed - inFlight };
}
