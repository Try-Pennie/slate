/**
 * Offboarding reap selection (#265), pure. Given the reapable candidate rows
 * (agents/managers who never logged in) and where each of them stands with
 * Salesforce, return the ids to DEACTIVATE and the rows the reap REFUSED.
 *
 * Unlike the old hard-delete reaper, there is no "skip users who manage OOO
 * history" carve-out: deactivation sets `deactivated_at` and keeps the row, so
 * manager/approver attribution on historical OOO requests stays intact. The
 * row is preserved, so a boomerang rehire can be reactivated (a flip back to
 * null) with no data loss.
 *
 * **It no longer decides anything about a shared address itself** (#2387). It used
 * to take a set of addresses Salesforce reported inactive and match on the
 * lowercased address, which deactivated a rehire whose old record was left
 * inactive beside their new active one. Where a row stands is now read ONCE, by
 * `readSalesforceStanding`, which the roster reconcile reads too, so the two can
 * no longer say opposite things about one address in one run (L263).
 */
import type { SalesforceStanding } from "@/lib/salesforce/presence";

/** One reapable Slate row, with where it stands in Salesforce already read. */
export interface ReapCandidate {
  id: string;
  email: string;
  standing: SalesforceStanding;
}

/** A row the reap declined to act on, because the address could not be settled. */
export interface ReapRefusal {
  userId: string;
  email: string;
}

export interface ReapPlan {
  /** Slate user ids to deactivate. */
  deactivate: string[];
  /**
   * Rows whose address answers to Salesforce records that disagree, with nothing
   * stored to say which one is theirs.
   *
   * Carried out rather than dropped because deactivating NOBODY in silence and
   * deactivating the WRONG person are two different failures that look identical
   * from outside (L98, L11). The caller counts these where the run's result is
   * read and pages on them beside the id conflicts they belong with.
   */
  refused: ReapRefusal[];
}

export function planReap(rows: ReapCandidate[]): ReapPlan {
  const deactivate: string[] = [];
  const refused: ReapRefusal[] = [];
  for (const row of rows) {
    // `absent` and `held` are both left alone, for different reasons that happen
    // to take the same action: absence from a Salesforce answer has never been
    // grounds for reaping (a person can be active and simply outside the slice of
    // the org a query asked about), and `held` is somebody Salesforce still has.
    if (row.standing === "departed") deactivate.push(row.id);
    else if (row.standing === "ambiguous") {
      refused.push({ userId: row.id, email: row.email });
    }
  }
  return { deactivate, refused };
}
