// The Twilio half of the hourly roster job (#2097).
//
// Twilio TaskRouter is where managers actually tag agents, and it is what feeds
// cal.com. `Redistribute` means the agent should not be taking booked calls (Dan,
// 2026-09-08) and exists nowhere else, so this is the only way Slate can learn it.
//
// EVERY FLIP GOES THROUGH `applyBookable`, never a direct update. Leaving the pool
// also has to stop the agent's Google calendar watches and prune their cached busy
// time (#239/#248), and it is where the audit row and the log line come from. A raw
// write would leave Google notifying Slate about somebody it no longer books.
//
// THE ORDER OF EACH FLIP'S TWO WRITES IS THE CRASH SAFETY, and the two directions
// are deliberately opposite (assume it runs twice):
//
//  - turning somebody OFF writes the mark FIRST. A crash in between leaves a
//    bookable agent who is marked, and the planner turns them off again next hour.
//  - turning them back ON flips FIRST and clears the mark only once the flip
//    SETTLED. A crash in between leaves a bookable agent still marked, which the
//    planner plans again and the flip settles as a noop. Clearing the mark first
//    would drop a refused agent out of the feature for good, and a refusal is the
//    expected case: the activation gate turns down anybody with no reachable Google
//    calendar.
//
// COST, derived rather than assumed: one Twilio call for the whole roster (142
// workers against a page size of 200), one roster read, and per flip about 6
// subrequests through the bookable service. The twelve agent backlog this ships
// against is one run of roughly 80; steady state is nought or one flip an hour.
// Subrequests are not a constraint at the 10,000 ceiling
// (`docs/cloudflare-platform-notes.md`), and no per run cap is imposed because a cap
// would hide a backlog rather than report one.
import { fetchTwilioWorkers, TwilioReadError } from "@/lib/twilio/client";
import { mergeWorkers, readWorker, LEGAL_ELIGIBLE_YES, type TwilioSide } from "@/lib/twilio/roster";
import { planTwilioRoster, type TwilioRosterRow } from "@/lib/twilio/roster-plan";
import { applyBookableByUserId, type BookableResult } from "@/lib/bookable/service";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { ensureDefaultOrg } from "@/lib/provision";
import { recordAudit } from "@/lib/audit";
import { log } from "@/lib/log";
import type { Attributes } from "@/lib/db/types";
import type { TwilioWorker } from "@/lib/twilio/client";

export interface TwilioSyncDeps {
  orgId: string;
  fetchWorkers: () => Promise<TwilioWorker[]>;
  loadRoster: () => Promise<TwilioRosterRow[]>;
  applyBookable: (userId: string, bookable: boolean) => Promise<BookableResult>;
  writeAttributes: (userId: string, attributes: Attributes) => Promise<void>;
  recordAudit: typeof recordAudit;
}

export interface TwilioSyncResult {
  /** How many workers Twilio answered with. Zero never gets this far. */
  workers: number;
  /** How many distinct addresses those workers covered. */
  addresses: number;
  /** Emails taken out of the bookable pool because Twilio carries the tag. */
  turnedOff: string[];
  /** Emails put back in because Twilio no longer carries it. */
  turnedBackOn: string[];
  /**
   * Emails whose reactivation the activation gate REFUSED, because they have no
   * reachable Google calendar. The mark survives and next hour tries again.
   *
   * Counted so the person who pressed sync reads it on the page rather than
   * learning it from Slack an hour later (Dan, 2026-09-08).
   */
  reactivationRefused: string[];
  /** Marked by Slate, and Twilio holds no worker for them, so nothing was done. */
  markedWithNoWorker: string[];
  /**
   * Emails whose stored legal eligibility was written to Y, and to N (#2098).
   *
   * Counted only once the write LANDED. A refused reactivation writes nothing at
   * all, and claiming the legal value moved there would be a count of a write that
   * never happened (#1134).
   */
  legalEligible: string[];
  legalExcluded: string[];
  /**
   * Every in scope Slate row Twilio holds no worker for.
   *
   * They are written to N like everybody else, because the default is N, so this
   * is a count of values written on an ABSENCE. It is also the only visible shape
   * of a PARTIAL Twilio read: a read that returned nothing is refused outright,
   * and one that returned half the roster would quietly exclude the other half.
   */
  withoutWorker: string[];
  /**
   * Legal writes that threw, so the run carried on with the rest (L73).
   *
   * Its own count rather than folded into `flipFailures`, because the two send a
   * reader to different places: a flip failure leaves somebody bookable who should
   * not be, and this leaves a stored value the next hour will write again.
   */
  legalWriteFailures: number;
  /** Workers whose `attributes` string is not JSON: a fault in Twilio's data. */
  corruptAttributes: number;
  /** Valid JSON carrying no email, which is usually a queue entity and ordinary. */
  noEmail: number;
  /** Tags this mapping does not know, reported so a new tier is never invisible. */
  unmappedTags: string[];
  /**
   * Flips that threw, so the run carried on with the rest (L73).
   *
   * Counted rather than swallowed, and NOT added to `turnedOff` or `turnedBackOn`,
   * because a report of twelve agents taken out of the pool is the only evidence
   * anybody will look at and one of those twelve still being bookable is the whole
   * fault. The outcome is paged by `bookable-not-routable` (#2088), which watches for
   * an agent who is bookable in Slate and withheld in cal.com whatever the cause; the
   * next hour retries, since the plan is a pure function of the current state.
   */
  flipFailures: number;
}

/**
 * Read Twilio, flip whoever changed, and say what happened.
 *
 * THROWS on every way of learning nothing: the read's five refusals come straight
 * back out by name, and a roster read that produced no rows is refused here for the
 * mirror reason. The caller turns that into an alert and a banner line; what it must
 * never do is treat it as a quiet run, because a Twilio half that silently does
 * nothing has every symptom of a healthy one.
 */
export async function syncTwilioRedistribute(deps: TwilioSyncDeps): Promise<TwilioSyncResult> {
  const workers = await deps.fetchWorkers();

  const byEmail = new Map<string, TwilioSide[]>();
  // Counted apart, because they are different faults and one message cannot name
  // both honestly (L11).
  let corruptAttributes = 0;
  let noEmail = 0;
  for (const w of workers) {
    const read = readWorker(w.attributes);
    if (!read.ok) {
      if (read.why === "unreadable-attributes") corruptAttributes++;
      else noEmail++;
      continue;
    }
    byEmail.set(read.side.email, [...(byEmail.get(read.side.email) ?? []), read.side]);
  }
  // Duplicates are unioned, exactly as the Pipedream job unions them, so this acts
  // on what cal.com actually receives. The duplication itself is a Twilio
  // configuration fault and is reported by `pnpm verify:twilio-parity` (exit 12).
  const merged = new Map<string, TwilioSide>();
  for (const [email, sides] of byEmail) merged.set(email, mergeWorkers(sides).merged);

  const roster = await deps.loadRoster();
  if (roster.length === 0) {
    // The mirror of the client's empty listing refusal. An empty roster makes every
    // marked agent look absent from Slate, flips nobody, and reports a clean run
    // (L98).
    throw new Error("Twilio sync read no Slate users at all, so nothing was judged and no agent was flipped");
  }

  const plan = planTwilioRoster(roster, merged);
  const turnedOff: string[] = [];
  const turnedBackOn: string[] = [];
  const reactivationRefused: string[] = [];
  const legalEligible: string[] = [];
  const legalExcluded: string[] = [];
  const legal = { eligible: legalEligible, excluded: legalExcluded };

  let flipFailures = 0;
  for (const flip of plan.flips) {
    // Its own boundary. This ships against a backlog of twelve, so one agent whose
    // flip throws (a database blip, a Google refusal the service does not catch) must
    // not leave the other eleven bookable while the run reports a Twilio read
    // failure, which is a different fault in a different system.
    try {
      await runFlip(flip, deps, { turnedOff, turnedBackOn, reactivationRefused, legal });
    } catch (err) {
      flipFailures++;
      log.error("twilio-sync", { msg: "flip failed, carrying on with the rest", user_id: flip.userId, action: flip.action }, err);
    }
  }

  // The legal values for everybody the run is not flipping. Their own boundary,
  // one row at a time, for the same reason the flips have one: this is the write
  // that touches the WHOLE roster, so one bad row must not take the rest with it.
  let legalWriteFailures = 0;
  for (const write of plan.legalWrites) {
    try {
      await deps.writeAttributes(write.userId, write.attributes);
      (write.value === LEGAL_ELIGIBLE_YES ? legalEligible : legalExcluded).push(write.email);
    } catch (err) {
      legalWriteFailures++;
      log.error("twilio-sync", { msg: "legal eligibility write failed, carrying on", user_id: write.userId }, err);
    }
  }

  const unmappedTags = [...new Set([...merged.values()].flatMap((s) => s.unmappedTags))].sort();
  if (unmappedTags.length > 0) {
    // Logged rather than put in the admin banner. A tag nobody mapped is Twilio
    // configuration a manager cannot act on from the roster page, and
    // `pnpm verify:twilio-parity` already reports it as its own verdict (exit 13);
    // saying it in both places would be the same fact twice (L605).
    log.warn("twilio-sync", { msg: "Twilio tags this mapping does not know", tags: unmappedTags.join(", ") });
  }
  if (plan.withoutWorker.length > 0) {
    // Not in the admin banner. A Slate row with no Twilio worker is Twilio
    // configuration a manager cannot act on from the roster page, and the count
    // matters most when it is LARGE, which is what a partial read looks like.
    log.warn("twilio-sync", {
      msg: "Slate rows Twilio holds no worker for, written to legal excluded on an absence",
      count: plan.withoutWorker.length,
    });
  }
  if (plan.markedWithNoWorker.length > 0) {
    log.warn("twilio-sync", {
      msg: "marked redistribute and Twilio holds no worker for them, so nothing was done",
      count: plan.markedWithNoWorker.length,
    });
  }

  return {
    workers: workers.length,
    addresses: merged.size,
    turnedOff,
    turnedBackOn,
    reactivationRefused,
    markedWithNoWorker: plan.markedWithNoWorker,
    legalEligible,
    legalExcluded,
    withoutWorker: plan.withoutWorker,
    legalWriteFailures,
    corruptAttributes,
    noEmail,
    unmappedTags,
    flipFailures,
  };
}

/** One flip, both directions, with the two writes in the order the header explains. */
async function runFlip(
  flip: ReturnType<typeof planTwilioRoster>["flips"][number],
  deps: TwilioSyncDeps,
  out: {
    turnedOff: string[];
    turnedBackOn: string[];
    reactivationRefused: string[];
    legal: { eligible: string[]; excluded: string[] };
  },
): Promise<void> {
  // Counted where the write LANDS, never where it is planned, so a payload that
  // never reached the database cannot be reported as a value that changed.
  const countLegal = () => {
    if (!flip.legal.changed) return;
    (flip.legal.value === LEGAL_ELIGIBLE_YES ? out.legal.eligible : out.legal.excluded).push(flip.email);
  };

  if (flip.action === "turn-off") {
    // Mark first. See the header for why this order and not the other. The legal
    // value rides in the SAME payload rather than a second write over the same
    // column, which would build from a base this one has already changed (L443).
    await deps.writeAttributes(flip.userId, flip.attributes);
    countLegal();
    const result = await deps.applyBookable(flip.userId, false);
    if (result.status === "applied") {
      out.turnedOff.push(flip.email);
      await deps.recordAudit({
        orgId: deps.orgId,
        actorId: null,
        action: "agent.bookable",
        targetUserId: flip.userId,
        details: { bookable: false, via: "twilio-sync", reason: "redistribute" },
      });
    } else if (result.status !== "noop") {
      // A flip the service could not perform. Said rather than counted as done,
      // because a report of twelve agents turned off is the only evidence anybody
      // will look at.
      log.warn("twilio-sync", { msg: "flip out of the pool did not apply", user_id: flip.userId, status: result.status });
    }
    return;
  }

  // Flip first, and clear the mark only once it settled.
  const result = await deps.applyBookable(flip.userId, true);
  if (result.status === "blocked") {
    out.reactivationRefused.push(flip.email);
    log.warn("twilio-sync", {
      msg: "reactivation refused, mark kept for next hour",
      user_id: flip.userId,
      reason: result.reason,
    });
    return;
  }
  if (result.status === "not_found") {
    log.warn("twilio-sync", { msg: "flip into the pool found no row", user_id: flip.userId });
    return;
  }
  await deps.writeAttributes(flip.userId, flip.attributes);
  countLegal();
  // A noop is a STALE MARK, not a change: somebody an admin had already turned
  // back on. The mark still had to go, and nothing else changed, so it is neither
  // reported as a flip nor audited.
  if (result.status === "applied") {
    out.turnedBackOn.push(flip.email);
    await deps.recordAudit({
      orgId: deps.orgId,
      actorId: null,
      action: "agent.bookable",
      targetUserId: flip.userId,
      details: { bookable: true, via: "twilio-sync", reason: "redistribute-removed" },
    });
  }
}

/**
 * The production wiring: live Twilio, the live roster, the shared bookable service.
 *
 * The roster read takes `attributes` because the flip's write is a read modify write
 * over them, and `unwrap` rather than a swallowed error because an empty answer here
 * is indistinguishable from a roster where nobody is tagged (#277, L105).
 */
export async function defaultTwilioSyncDeps(orgId?: string): Promise<TwilioSyncDeps> {
  const id = orgId ?? (await ensureDefaultOrg()).id;
  return {
    orgId: id,
    fetchWorkers: () => fetchTwilioWorkers(),
    loadRoster: async () => {
      // cap-safe: users is a roster-bounded table, ~148 rows against a 200-agent design target
      const rows = (unwrap(
        await supabaseAdmin()
          .from("users")
          .select("id, email, bookable, deactivated_at, is_test, attributes")
          .eq("org_id", id),
        "twilio-sync.roster",
      ) ?? []) as {
        id: string;
        email: string;
        bookable: boolean;
        deactivated_at: string | null;
        is_test: boolean;
        attributes: Attributes | null;
      }[];
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        bookable: r.bookable === true,
        deactivated: r.deactivated_at !== null,
        isTest: r.is_test === true,
        attributes: r.attributes,
      }));
    },
    applyBookable: (userId, bookable) => applyBookableByUserId(userId, bookable),
    writeAttributes: async (userId, attributes) => {
      const { error } = await supabaseAdmin().from("users").update({ attributes }).eq("id", userId);
      if (error) throw new Error(`Twilio attribute write failed: ${error.message}`);
    },
    recordAudit,
  };
}

export { TwilioReadError };
