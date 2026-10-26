/**
 * The ONE place `users.bookable` and `users.deactivated_at` are written, and the
 * one place a bookable trait is owed to Regal from (#2085).
 *
 * ## Why the emit lives inside the write
 *
 * Regal has to know whether Slate can route a lead to an agent, and three writes
 * can change that: the bookable flip (the admin toggle, `POST
 * /api/users/bookable` and the hourly Salesforce activation all share it, #2071),
 * the offboarding departure and return (#1324), the Salesforce reap's batch
 * departure (#2386), and the sync lane taking out an advisor Google refuses (#3700,
 * `refused-pool-exit.ts`). A behaviour every writer has to remember to opt into is
 * enforced by nothing, and a site that never opts in looks exactly like a site
 * where the condition never arises (L621). So the helper OWNS the write: it reads
 * the rows before, performs the write, reads what it wrote back from the same
 * statement, and emits for every row whose derived value moved.
 * `scripts/test-routable-write-owner.ts` fails the build on any other `src/`
 * site that writes either column.
 *
 * ## What is sent
 *
 * The derived value routing itself uses, `isRoutable` (bookable AND not
 * deactivated), decided by `planTraitEmissions`. Only on a change, so a repeat is
 * silent and so are a reactivation and a flip on a departed row.
 *
 * ## How it is delivered
 *
 * Through the existing webhook delivery path (`emitWebhook`), so a trait inherits
 * the durable delivery row, the retry sweep, the delivery log at /admin/webhooks
 * and the dead letter alerting. A test agent's trait is recorded as SUPPRESSED:
 * a terminal row that no send path can pick up (#459's rule). The POST itself is
 * deferred past the response, because the row is what the retry sweep stands on
 * and it is written before this returns.
 *
 * A failed or refused POST is therefore not handled here at all: the delivery
 * row records it and the sweep retries it. Whether a trait that never reaches
 * Regal should PAGE on its own was left open by the issue; the answer shipped is
 * the existing dead letter page (`webhook_dead:<endpoint>`) and no new one, since
 * nothing in Regal routes on the trait yet.
 *
 * ## What it cannot see
 *
 * SQL run by hand in the Supabase editor, which the application layer never
 * sees (L593). A database trigger would have covered it at the cost of a table
 * and a drain lane on the shared cron budget, and was declined in the issue. The
 * backfill (`pnpm backfill:bookable-trait`) is the repair for that residual.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { emitWebhook } from "@/lib/webhooks/emit";
import { afterResponse } from "@/lib/after-response";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { bookableTraitUnrecordedAlert } from "@/lib/notify/misc-alert-copy";
import { deactivationPatch, reactivationPatch } from "@/lib/offboarding/lifecycle-write";
import type { ThrottledNotify } from "@/lib/monitor/alert-deps";
import {
  ROUTABLE_STATE_COLUMNS,
  planTraitEmissions,
  type RoutableStateRow,
  type TraitEmission,
} from "@/lib/bookable/routable-trait";

/**
 * One page per agent per day at most. It is an incident about one change that
 * will never be retried, so a second failure for the same agent inside the day
 * adds nothing the first did not say, and the backfill repairs both.
 */
export const BOOKABLE_TRAIT_UNRECORDED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The writes this module owns. Each is the whole write for its purpose. */
export type RoutableWrite =
  /** The bookable flip. Also settles `bookable_pending_since` (#2071). */
  | { kind: "bookable"; userId: string; bookable: boolean }
  /**
   * A departure, for one agent (offboarding) or a batch (the Salesforce reap).
   * A compare and swap on `deactivated_at is null`, so a row already departed
   * keeps the stamp that records when they actually left.
   */
  | { kind: "depart"; userIds: string[]; stampIso: string }
  /** A return. A compare and swap on `deactivated_at is not null`. */
  | { kind: "return"; userId: string }
  /**
   * Out of the pool with a return owed (#3700): Google has refused the advisor's
   * calendar for a sustained period, so they cannot take a call, but this is not a
   * departure and `deactivated_at` is never stamped. The pending mark is written in
   * the same statement, which is what hands the way back to the existing activation
   * gate: the hourly roster run retries every marked row, and the gate admits them
   * only once every calendar of theirs reads. A compare and swap on `bookable` true
   * and not departed, so a second run, or a person who turned them off first,
   * matches nothing and gets no row back.
   */
  | { kind: "hold-out"; userId: string; stampIso: string };

export interface RoutableWriteDeps {
  /** Record one trait for Regal. Throws when it could not be recorded. */
  emit: (e: TraitEmission) => Promise<void>;
  /** Throttled alert, for a trait that could not be recorded. */
  notify: ThrottledNotify;
}

export const defaultRoutableWriteDeps: RoutableWriteDeps = {
  emit: (e) =>
    emitWebhook(
      e.orgId,
      "agent.bookable_changed",
      { user_id: e.userId, email: e.email, slate_bookable: e.slateBookable },
      // At least once, deliberately: every send states the agent's CURRENT value
      // (`payloadForSend`), so a duplicate delivery is harmless, and a dedupe key
      // could only ever drop a real change.
      null,
      e.suppressed,
      (work) => afterResponse("bookable-trait", work),
    ),
  // alert-key: bookable_trait_unrecorded:*
  notify: (key, cooldownMs, text, repeat) => sendThrottledAlert(key, cooldownMs, text, repeat),
};

function idsOf(w: RoutableWrite): string[] {
  return w.kind === "depart" ? w.userIds : [w.userId];
}

/**
 * Perform one owned write, then record a trait for every row whose derived value
 * it moved. Returns the rows the write actually changed, as they now stand.
 *
 * THROWS when the before state cannot be read (nothing has been written yet) or
 * when the write is refused (#2482), exactly as the writes it replaces did.
 * Never throws for a trait: the write has committed by then, and failing it would
 * report a change that happened as one that did not.
 */
export async function writeRoutableState(
  w: RoutableWrite,
  deps: RoutableWriteDeps = defaultRoutableWriteDeps,
): Promise<RoutableStateRow[]> {
  const ids = idsOf(w);
  if (ids.length === 0) return [];
  const db = supabaseAdmin();

  // The BEFORE state, read by primary key. `users` is roster bounded, and the
  // caller's batch is what the write itself already addresses with `.in`.
  const before = (unwrap(
    await db.from("users").select(ROUTABLE_STATE_COLUMNS).in("id", ids),
    "routable-write.before",
  ) ?? []) as RoutableStateRow[];

  const { data, error } = await applyWrite(db, w).select(ROUTABLE_STATE_COLUMNS);
  if (error) {
    throw new Error(`${describe(w)} failed: ${error.message}`);
  }
  const after = (data ?? []) as RoutableStateRow[];

  for (const e of planTraitEmissions(before, after)) {
    await recordTrait(e, deps);
  }
  return after;
}

function applyWrite(db: ReturnType<typeof supabaseAdmin>, w: RoutableWrite) {
  const users = db.from("users");
  switch (w.kind) {
    case "bookable":
      // Any explicit bookable write answers the question the pending mark asks
      // (#2071), whether the sync finally succeeded or a person decided.
      return users.update({ bookable: w.bookable, bookable_pending_since: null }).eq("id", w.userId);
    case "depart":
      return users.update(deactivationPatch(w.stampIso)).in("id", w.userIds).is("deactivated_at", null);
    case "return":
      return users.update(reactivationPatch()).eq("id", w.userId).not("deactivated_at", "is", null);
    case "hold-out":
      return users
        .update({ bookable: false, bookable_pending_since: w.stampIso })
        .eq("id", w.userId)
        .eq("bookable", true)
        .is("deactivated_at", null);
  }
}

function describe(w: RoutableWrite): string {
  switch (w.kind) {
    case "bookable":
      return `bookable write for ${w.userId}`;
    case "depart":
      return `deactivation of ${w.userIds.length} user(s)`;
    case "return":
      return `reactivation of ${w.userId}`;
    case "hold-out":
      return `pool exit with a return owed for ${w.userId}`;
  }
}

async function recordTrait(e: TraitEmission, deps: RoutableWriteDeps): Promise<void> {
  try {
    await deps.emit(e);
  } catch (err) {
    // The change is saved and its delivery row was never written, so nothing will
    // retry it and nothing downstream can tell. Logged in full, paged in short.
    log.error(
      "bookable-trait",
      { msg: "trait not recorded", user_id: e.userId, slate_bookable: e.slateBookable },
      err,
    );
    await deps
      .notify(
        `bookable_trait_unrecorded:${e.userId}`,
        BOOKABLE_TRAIT_UNRECORDED_COOLDOWN_MS,
        bookableTraitUnrecordedAlert(e.email, e.slateBookable),
      )
      .catch((notifyErr) => {
        log.error("bookable-trait", { msg: "unrecorded trait alert failed", user_id: e.userId }, notifyErr);
      });
  }
}

/**
 * Depart a batch of users by id, for the hourly Salesforce reap (#2386).
 *
 * FAILS LOUD. The reap used to discard this statement's result, so a refused
 * deactivation reported `deactivated: N` and the lane reported a clean hour while
 * the leaver stayed in the roster (L12, L98). The run is idempotent and the reap
 * re-selects its candidates every hour, so throwing costs one retry and never a
 * lost departure.
 *
 * A compare and swap over the batch (`deactivated_at is null`), matching the
 * single row departure: somebody deactivated between the reap's candidate read
 * and this write keeps the stamp that records when they actually left.
 *
 * It deliberately does NOT revoke sessions or enqueue a coverage sweep. Sessions
 * are converged after the reap by `offboarding/session-convergence.ts` (#2459),
 * from the end state, so a failed ban is retried rather than lost with the row
 * that no longer matches the reap. The coverage sweep is the caller's (#1678,
 * `coverReapDepartures`), which is why this returns the rows THIS write departed,
 * each with the stamp it now carries: a row somebody else departed first is left
 * out by the compare and swap, so it is never swept from here. This is only the
 * write, and the Regal trait every write here carries (#2085).
 */
export async function deactivateUsersByIds(
  userIds: string[],
  stampIso: string,
  deps: RoutableWriteDeps = defaultRoutableWriteDeps,
): Promise<{ id: string; deactivatedAtIso: string }[]> {
  if (!userIds.length) return [];
  let changed: Awaited<ReturnType<typeof writeRoutableState>>;
  try {
    changed = await writeRoutableState({ kind: "depart", userIds, stampIso }, deps);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`reap deactivation failed for ${userIds.length} user(s): ${detail}`);
  }
  return changed.flatMap((r) => (r.deactivated_at ? [{ id: r.id, deactivatedAtIso: r.deactivated_at }] : []));
}

/**
 * The bookable flip by user id (#281). Kept under its old name because every
 * caller already knows it by that one; it is this module's `bookable` write.
 */
export async function writeBookable(userId: string, bookable: boolean): Promise<void> {
  await writeRoutableState({ kind: "bookable", userId, bookable });
}
