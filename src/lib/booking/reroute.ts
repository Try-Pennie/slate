/**
 * Rerouting a booking into a corrected bucket (#3249, phase 3 of #3244).
 *
 * An admin picks the bucket a booking should have been in. `startReroute` finds who
 * should take it at its existing time through phase 2's `findRerouteTarget` (the
 * booker's own round robin, verify on book and tier ladder), and when that is a
 * new advisor it HOLDS them for five minutes, so nobody else can take that time
 * while the admin decides. `confirmReroute` then turns the hold into the move,
 * through the existing reassign machinery with the corrected bucket, or, when the
 * current advisor stays, corrects only the bucket and sends nothing (Dan,
 * 2026-10-04: neither the advisor nor the time changed).
 *
 * Every outcome reads distinctly (L11): a move proposal, a keep (with whether it
 * is the last resort), none, the hold ran out, the advisor was taken at confirm
 * (searched again), and a repeated confirm returning the first result. Anything
 * the system could not establish THROWS, never reads as a keep or a refusal: a keep
 * the admin confirms on a search that never ran would correct a bucket on a guess.
 *
 * Pure apart from the injected deps, so `scripts/test-reroute-service.ts` drives
 * every branch with no network; `service.ts` wires the real ones.
 */
import type { Booking, Bucket, EventType } from "../db/types.ts";
import type { PlaceRerouteHoldRefusal, ClaimRerouteHoldRefusal, RerouteSwapRefusal } from "../db/reroute-hold-refusals.ts";
import type { PlaceRerouteHoldArgs, PlaceRerouteHoldResult } from "./reroute-hold-store.ts";
import type { CurrentAgentUnavailable, RerouteTarget } from "./orchestration.ts";
import type { BookingActor, BookingEventInsert, VerifyResult } from "./core.ts";
import { bookingEventFrom, bufferedWindow } from "./core.ts";
import { tierKeyOf, tierLadder } from "../routing/tiers.ts";
import { DateTime } from "luxon";
import { formatClockTime } from "../date/parse.ts";

/** The reason every reroute records. System only: the admin adds a note, never picks it. */
export const REROUTE_REASON_CODE = "bucket_correction";

/** Why a reroute could not be started or confirmed. Each has its own message at the route. */
export type RerouteRefusal =
  | "booking_not_found"
  | "booking_inactive"
  | "agent_link"
  | "unknown_bucket"
  | "no_current_advisor"
  | "no_calendar_event"
  | "kept_off_ladder"
  | "across_worlds"
  | "current_on_time_off"
  | "current_not_free"
  | "current_no_schedule"
  | PlaceRerouteHoldRefusal
  | ClaimRerouteHoldRefusal
  | RerouteSwapRefusal;

export class RerouteRefusedError extends Error {
  readonly code: RerouteRefusal;
  constructor(code: RerouteRefusal) {
    super(`reroute refused: ${code}`);
    this.name = "RerouteRefusedError";
    this.code = code;
  }
}

/**
 * A reassign refused because its target advisor is held for another booking's
 * bucket correction (#3249). The bookings trigger (migration 0166) raises it as a
 * lost race, 23P01 under the constraint name `reroute_hold`, with the hold's end in
 * the error detail as `held_until=<ISO>`. Its own class, so the admin reassign can
 * say what is happening and when it ends rather than "something went wrong".
 */
export class AgentHeldError extends Error {
  readonly heldUntilIso: string | null;
  constructor(heldUntilIso: string | null) {
    super(heldUntilSentence(heldUntilIso));
    this.name = "AgentHeldError";
    this.heldUntilIso = heldUntilIso;
  }
}

/** The held error inside a database error, or null when it is any other error. */
export function agentHeldFrom(
  error: { code?: string; message?: string; details?: string | null } | null | undefined,
): AgentHeldError | null {
  // Keyed on the SQLSTATE and the trigger's structured detail, never the message
  // text (L35): the message is prose for a person and can be reworded freely.
  if (!error || error.code !== "23P01") return null;
  const details = error.details ?? "";
  if (!details.startsWith("held_until=")) return null;
  const until = details.slice("held_until=".length).trim();
  return new AgentHeldError(until && Number.isFinite(Date.parse(until)) ? until : null);
}

/** "This advisor is held for a bucket correction until 3:04pm ET." */
export function heldUntilSentence(heldUntilIso: string | null): string {
  if (!heldUntilIso) return "This advisor is held for a bucket correction for a few more minutes.";
  const clock = formatClockTime(DateTime.fromISO(heldUntilIso, { zone: "America/New_York" }));
  if (!clock) return "This advisor is held for a bucket correction for a few more minutes.";
  return `This advisor is held for a bucket correction until ${clock} ET.`;
}

export interface RerouteBucket {
  id: string;
  code: string;
  name: string;
}

export interface RerouteAdvisor {
  userId: string;
  name: string;
  email: string;
}

/** What `startReroute` found, and what a reload restores. */
export type RerouteProposal =
  | {
      kind: "move";
      holdId: string;
      expiresAt: string;
      /** Server computed; the panel counts down from this, never its own clock. */
      secondsRemaining: number;
      advisor: RerouteAdvisor;
      bucket: RerouteBucket;
      requested: RerouteBucket;
      rungsDropped: number;
    }
  | {
      kind: "keep";
      /** True when nobody else anywhere could take the time (Dan: "I want to be aware"). */
      lastResort: boolean;
      advisor: RerouteAdvisor;
      bucket: RerouteBucket;
      requested: RerouteBucket;
      rungsDropped: number;
    }
  | {
      kind: "none";
      requested: RerouteBucket;
      /**
       * #3487: the current advisor was there to keep but cannot take the call (time
       * off, no schedule, not free), so nobody at all is free and there is no keep.
       * Absent when nobody holds the booking or they were the one excluded.
       */
      current?: { advisor: RerouteAdvisor; reason: CurrentAgentUnavailable };
    };

/** What a confirm did. */
export type RerouteOutcome =
  | {
      kind: "moved";
      advisor: RerouteAdvisor;
      bucket: RerouteBucket;
      /**
       * True when an EARLIER confirm of this hold made the move and this one changed
       * nothing (#3307): it read the consumed hold's stored result. Required, so a
       * move this confirm made says so rather than leaving it to a missing field.
       */
      already: boolean;
    }
  | { kind: "kept"; bucket: RerouteBucket }
  | { kind: "expired" }
  | { kind: "taken"; previous: RerouteAdvisor; proposal: RerouteProposal };

/** The swap arguments a reroute move carries into the existing reassign. */
export interface RerouteSwapArgs {
  holdId: string;
  bucketId: string;
  requestedBucketId: string;
  requestedTier: string | null;
  bookedTier: string | null;
  rungsDropped: number;
  /** The bucket the booking was in, for the history row's from_bucket_id. */
  fromBucketId: string;
}

export interface LiveHoldRecord {
  holdId: string;
  agentUserId: string;
  targetBucketId: string;
  requestedBucketId: string;
  rungsDropped: number;
  expiresAt: string;
}

export interface RerouteDeps {
  loadBookingById(id: string): Promise<{ booking: Booking; bucket: Bucket; eventType: EventType } | null>;
  resolveBucketByCode(code: string): Promise<{ bucket: Bucket; eventType: EventType } | null>;
  /** `excludeUserIds`: advisors a re-search must not offer back. */
  findTarget(
    booking: Booking,
    requested: { bucket: Bucket; eventType: EventType },
    excludeUserIds?: readonly string[],
  ): Promise<RerouteTarget>;
  placeHold(args: PlaceRerouteHoldArgs): Promise<PlaceRerouteHoldResult>;
  releaseHold(bookingId: string): Promise<{ released: boolean }>;
  claimHold(
    orgId: string,
    bookingId: string,
    holdId: string,
  ): Promise<{
    refused: ClaimRerouteHoldRefusal | null;
    result: Record<string, unknown> | null;
    agentUserId: string | null;
    targetBucketId: string | null;
  }>;
  verifyFree(emails: string[], startIso: string, endIso: string): Promise<VerifyResult>;
  agentById(id: string): Promise<{ id: string; name: string | null; email: string | null } | null>;
  bucketById(id: string): Promise<Bucket | null>;
  /**
   * The existing reassign (`reassignBooking`), bound to the admin actor, with the
   * reroute swap args. "over_cap" is the held advisor having reached their daily cap
   * since the search: the reroute searches again rather than offering the manual
   * reassign's "Reassign anyway", which a reroute has no place for.
   */
  reassign(
    bookingId: string,
    agentEmail: string,
    reason: { code: string; detail: string | null },
    reroute: RerouteSwapArgs,
  ): Promise<"moved" | "over_cap">;
  /** A hold release that itself failed after a failed confirm. Never throws. */
  onReleaseFailed(bookingId: string, err: unknown): void;
  /** The bucket aware swap as a keep: the current agent, the corrected bucket, no hold. */
  keepSwap(args: {
    bookingId: string;
    userId: string;
    agentName: string | null;
    agentEmail: string;
    gcalEventId: string;
    bucketId: string;
    requestedBucketId: string;
    requestedTier: string | null;
    bookedTier: string | null;
    rungsDropped: number;
    holdId: null;
  }): Promise<{ refused: RerouteSwapRefusal | null; updated: boolean }>;
  insertBookingEvent(row: BookingEventInsert): Promise<void>;
  /**
   * #3487: why the booking's current advisor cannot take its time in `kept`, or null
   * when they can, by `currentAgentUnavailableReason`. Throws on a failed read, so a
   * keep is never committed on an answer nobody could read.
   */
  currentAdvisorUnavailable(
    booking: Booking,
    kept: { bucket: Bucket; eventType: EventType },
  ): Promise<CurrentAgentUnavailable | null>;
  readLiveHold(bookingId: string): Promise<LiveHoldRecord | null>;
  now(): number;
}

const bucketView = (b: Bucket): RerouteBucket => ({ id: b.id, code: b.code, name: b.name });

async function advisorView(deps: RerouteDeps, userId: string): Promise<RerouteAdvisor> {
  const a = await deps.agentById(userId);
  if (!a || !a.email) throw new Error(`reroute: advisor ${userId} could not be read`);
  return { userId, name: a.name ?? a.email, email: a.email };
}

async function bucketOrThrow(deps: RerouteDeps, id: string): Promise<Bucket> {
  const b = await deps.bucketById(id);
  if (!b) throw new Error(`reroute: bucket ${id} could not be read`);
  return b;
}

const secondsUntil = (iso: string, nowMs: number) => Math.max(0, Math.round((Date.parse(iso) - nowMs) / 1000));

/** The booking, refused by name when it cannot be rerouted at all. */
async function reroutableBooking(deps: RerouteDeps, bookingId: string) {
  const ctx = await deps.loadBookingById(bookingId);
  if (!ctx) throw new RerouteRefusedError("booking_not_found");
  if (ctx.booking.status === "cancelled" || ctx.booking.status === "completed") throw new RerouteRefusedError("booking_inactive");
  // The lead chose this advisor by name, so there is no bucket to correct (Dan, 2026-10-04).
  if (ctx.booking.kind === "agent_link") throw new RerouteRefusedError("agent_link");
  return ctx;
}

async function requestedBucket(deps: RerouteDeps, code: string | null) {
  const resolved = code ? await deps.resolveBucketByCode(code) : null;
  if (!resolved) throw new RerouteRefusedError("unknown_bucket");
  return resolved;
}

/**
 * Search and, for a new advisor, hold. Shared by a fresh start and by the search a
 * confirm re-runs after its held advisor was taken.
 */
async function searchAndHold(
  deps: RerouteDeps,
  booking: Booking,
  requested: { bucket: Bucket; eventType: EventType },
  actor: BookingActor,
  excludeUserIds: readonly string[] = [],
): Promise<RerouteProposal> {
  const target = await deps.findTarget(booking, requested, excludeUserIds);
  const req = bucketView(requested.bucket);

  if (target.outcome === "move-in-requested" || target.outcome === "move-cascaded") {
    const placed = await deps.placeHold({
      orgId: booking.org_id,
      bookingId: booking.id,
      agentUserId: target.userId,
      requestedBucketId: requested.bucket.id,
      targetBucketId: target.bucket.id,
      rungsDropped: target.rungsDropped,
      createdBy: actor.userId ?? null,
    });
    if (!placed.placed) throw new RerouteRefusedError(placed.refused);
    return {
      kind: "move",
      holdId: placed.holdId,
      expiresAt: placed.expiresAt,
      secondsRemaining: secondsUntil(placed.expiresAt, deps.now()),
      advisor: await advisorView(deps, target.userId),
      bucket: bucketView(target.bucket),
      requested: req,
      rungsDropped: target.rungsDropped,
    };
  }

  // No move, so no advisor needs holding: an earlier search's hold for this booking
  // is let go, or its advisor stays blocked and a reload restores a stale move.
  await deps.releaseHold(booking.id);

  // A keep needs somebody to keep. A booking nobody holds, with nobody free
  // anywhere, is "none": correcting the bucket of an unassigned call onto nobody
  // is not a keep (#3244 Done when: "refused, nobody at all").
  if (!booking.assigned_user_id) return { kind: "none", requested: req };
  // "Look for a different advisor" excluded the current one (#3596). A keep lands on
  // the current advisor, so when they are the excluded one a keep means nobody ELSE
  // was free: report that as "none" rather than a keep of the very advisor the admin
  // asked to move off.
  if (excludeUserIds.includes(booking.assigned_user_id)) return { kind: "none", requested: req };
  // #3487: nobody else is free and the current advisor cannot take it either. Said
  // as that, never as a keep of the advisor who is out.
  if (target.outcome === "none-current-unavailable") {
    return {
      kind: "none",
      requested: req,
      current: { advisor: await advisorView(deps, booking.assigned_user_id), reason: target.reason },
    };
  }
  return {
    kind: "keep",
    lastResort: target.outcome === "keep-last-resort",
    advisor: await advisorView(deps, booking.assigned_user_id),
    bucket: bucketView(target.bucket),
    requested: req,
    rungsDropped: target.rungsDropped,
  };
}

/**
 * Find who should take a booking in `bucketCode`, holding them when they are new.
 *
 * `excludeCurrent` is "look for a different advisor" (#3596): the search leaves out the
 * booking's current advisor, so a keep they would otherwise win becomes a move to the
 * next eligible advisor, or `none` when nobody else is free. The excluded id is resolved
 * from the stored booking, never taken from the caller, so a request cannot name an
 * arbitrary exclusion.
 */
export async function startReroute(
  deps: RerouteDeps,
  input: { bookingId: string; bucketCode: string; actor: BookingActor; excludeCurrent?: boolean },
): Promise<RerouteProposal> {
  const { booking, bucket } = await reroutableBooking(deps, input.bookingId);
  const requested = await requestedBucket(deps, input.bucketCode);
  sameWorld(bucket, requested.bucket);
  const excludeUserIds =
    input.excludeCurrent && booking.assigned_user_id ? [booking.assigned_user_id] : [];
  return searchAndHold(deps, booking, requested, input.actor, excludeUserIds);
}

/**
 * A reroute stays in the world the booking is in (#2660, #3251). The search walks
 * only buckets in the REQUESTED bucket's world, so a test call asked into a real
 * bucket would hold a real advisor away from leads, and a keep would leave a test
 * call in a real bucket or a real lead's call in a test one, where its webhooks
 * are suppressed. The reassign beneath a move refuses the advisor too, but only
 * after the hold, and a keep never reaches that check at all.
 */
function sameWorld(stored: Bucket, asked: Bucket): void {
  if (Boolean(stored.is_test) !== Boolean(asked.is_test)) throw new RerouteRefusedError("across_worlds");
}

/**
 * Confirm a reroute. With a hold it is a move: claim the hold FIRST (which extends
 * it to a confirm lease, so a confirm started at 4:58 cannot expire mid Google
 * call), verify the held advisor live over the BUFFERED window, then run the
 * existing reassign with the corrected bucket. Without a hold it is a keep of the
 * current advisor into `bucketCode`.
 */
export async function confirmReroute(
  deps: RerouteDeps,
  input: {
    bookingId: string;
    holdId: string | null;
    /** A keep: the bucket the advisor is kept in. */
    bucketCode: string | null;
    /** A keep in a lower tier: the bucket that was asked for. The drop is worked
     *  out from the two codes, never taken from the caller. */
    requestedBucketCode?: string | null;
    note: string | null;
    actor: BookingActor;
  },
): Promise<RerouteOutcome> {
  const reason = { code: REROUTE_REASON_CODE, detail: input.note && input.note.trim() ? input.note.trim() : null };

  if (input.holdId === null) return confirmKeep(deps, input, reason);

  // The same booking checks start and keep apply, before any hold is claimed.
  const { booking, bucket: fromBucket, eventType } = await reroutableBooking(deps, input.bookingId);

  const claim = await deps.claimHold(booking.org_id, booking.id, input.holdId);
  if (claim.refused === "hold_consumed") {
    // A repeated confirm: answer what the first one did rather than "expired", and
    // say it was the first one (#3307). The swap consumed this hold under its row
    // lock, so a hold is moved at most once whoever confirms it; this confirm reads
    // the stored result and touches nothing, no calendar read and no release, since
    // the consumed row is the record of the move.
    const r = claim.result ?? {};
    const agentId = typeof r.agent_user_id === "string" ? r.agent_user_id : null;
    const bucketId = typeof r.bucket_id === "string" ? r.bucket_id : null;
    const code = typeof r.bucket_code === "string" ? r.bucket_code : null;
    if (!agentId || !code) throw new Error("reroute: a consumed hold carried no readable result");
    const bucket = bucketId ? bucketView(await bucketOrThrow(deps, bucketId)) : { id: "", code, name: code };
    return { kind: "moved", advisor: await advisorView(deps, agentId), bucket, already: true };
  }
  if (claim.refused === "hold_expired" || claim.refused === "hold_not_found") return { kind: "expired" };
  if (claim.refused) throw new RerouteRefusedError(claim.refused);
  // From here on the hold is claimed, which extends it to a confirm lease. ANY
  // failure lets it go, so an unreadable calendar or a failed read never leaves the
  // advisor blocked for leads until the lease runs out (#3249 review).
  try {
    return await moveOnClaimedHold(deps, { booking, fromBucket, eventType }, claim, input, reason);
  } catch (err) {
    // The confirm's own error is the one surfaced; a release that fails too is
    // reported, since its advisor then stays blocked until the lease runs out.
    await deps.releaseHold(booking.id).catch((releaseErr) => deps.onReleaseFailed(booking.id, releaseErr));
    throw err;
  }
}

async function moveOnClaimedHold(
  deps: RerouteDeps,
  ctx: { booking: Booking; fromBucket: Bucket; eventType: EventType },
  claim: { agentUserId: string | null; targetBucketId: string | null },
  input: { holdId: string | null; actor: BookingActor },
  reason: { code: string; detail: string | null },
): Promise<RerouteOutcome> {
  const { booking, fromBucket, eventType } = ctx;
  if (!claim.agentUserId || !claim.targetBucketId || !input.holdId) {
    throw new Error("reroute: a claimed hold named no advisor or bucket");
  }
  const advisor = await advisorView(deps, claim.agentUserId);
  const target = await bucketOrThrow(deps, claim.targetBucketId);
  // The requested bucket and the drop live only on the hold row. A hold that cannot
  // be read back moments after its claim is a fault, never a reason to record the
  // corrected bucket as the requested one with no drop (#3249 review).
  const held = await deps.readLiveHold(booking.id);
  if (!held) throw new Error(`reroute: the claimed hold for booking ${booking.id} could not be read back`);
  if (held.holdId !== input.holdId) {
    throw new Error(`reroute: booking ${booking.id} holds ${held.holdId}, not the claimed ${input.holdId}`);
  }
  const requested = await bucketOrThrow(deps, held.requestedBucketId);

  const [fromIso, toIso] = bufferedWindow(eventType, new Date(booking.starts_at).toISOString(), new Date(booking.ends_at).toISOString());
  const verify = await deps.verifyFree([advisor.email], fromIso, toIso);
  if (verify.unverified.has(advisor.email)) {
    throw new Error(`reroute: ${advisor.email}'s calendar could not be read at confirm`);
  }
  // Booked since the hold was placed, or now at their daily cap: release it and
  // search again, so the admin confirms a fresh proposal rather than a move onto
  // somebody who can no longer take it.
  const searchAgain = async (): Promise<RerouteOutcome> => {
    await deps.releaseHold(booking.id);
    // Never offer back the advisor who just fell through: cached day counts can lag
    // the cap the reassign enforces, and the search would pick them again.
    const proposal = await searchAndHold(deps, booking, { bucket: requested, eventType }, input.actor, [advisor.userId]);
    return { kind: "taken", previous: advisor, proposal };
  };
  if (!verify.free.has(advisor.email)) return searchAgain();

  // The reassign rolls back its own Google event on failure; the caller lets the
  // hold go.
  let moved: "moved" | "over_cap";
  try {
    moved = await deps.reassign(booking.id, advisor.email, reason, {
      holdId: input.holdId,
      bucketId: target.id,
      requestedBucketId: requested.id,
      requestedTier: tierKeyOf(requested.code),
      bookedTier: tierKeyOf(target.code),
      rungsDropped: held.rungsDropped,
      fromBucketId: fromBucket.id,
    });
  } catch (err) {
    // The hold ran out (or was replaced) by the time the swap ran: the same answer
    // as when the claim finds it so, never a 409 for one and "expired" for the other.
    if (err instanceof RerouteRefusedError && (err.code === "hold_expired" || err.code === "hold_not_found")) {
      return { kind: "expired" };
    }
    throw err;
  }
  if (moved === "over_cap") return searchAgain();
  return { kind: "moved", advisor, bucket: bucketView(target), already: false };
}

/** The refusal a keep confirm answers for each reason its advisor cannot take the call. */
const UNAVAILABLE_REFUSAL: Record<CurrentAgentUnavailable, RerouteRefusal> = {
  time_off: "current_on_time_off",
  not_free: "current_not_free",
  no_schedule: "current_no_schedule",
};

async function confirmKeep(
  deps: RerouteDeps,
  input: { bookingId: string; bucketCode: string | null; requestedBucketCode?: string | null; actor: BookingActor },
  reason: { code: string; detail: string | null },
): Promise<RerouteOutcome> {
  const { booking, bucket: fromBucket } = await reroutableBooking(deps, input.bookingId);
  const kept = await requestedBucket(deps, input.bucketCode);
  // A cascaded keep records what was asked for and the drop, as the move does,
  // derived here rather than taken from the request (the move reads its drop off
  // the hold the server placed). Both buckets come from the request, so each is
  // held to the booking's world.
  const asked = input.requestedBucketCode ? await requestedBucket(deps, input.requestedBucketCode) : kept;
  sameWorld(fromBucket, kept.bucket);
  sameWorld(fromBucket, asked.bucket);
  // The drop is the kept bucket's position on the ladder the search walks from the
  // bucket asked for, the same measure a move records, so a keep and a move of the
  // same distance read alike in the history. A code the search could never have
  // reached from it is refused rather than recorded.
  const rungs = tierLadder(asked.bucket.code).indexOf(kept.bucket.code);
  if (rungs < 0) throw new RerouteRefusedError("kept_off_ladder");
  if (!booking.assigned_user_id || !booking.agent_email) throw new RerouteRefusedError("no_current_advisor");
  if (!booking.gcal_event_id) throw new RerouteRefusedError("no_calendar_event");
  // #3487: a keep confirm names only buckets, so it can arrive for an advisor who has
  // since gone on time off, or from a panel the search never offered a keep on. The
  // advisor is judged again here, in the bucket they would be kept in, by the rule
  // the search uses, so no confirm commits a keep onto somebody who cannot take it.
  const unavailable = await deps.currentAdvisorUnavailable(booking, kept);
  if (unavailable) throw new RerouteRefusedError(UNAVAILABLE_REFUSAL[unavailable]);
  const { refused, updated } = await deps.keepSwap({
    bookingId: booking.id,
    userId: booking.assigned_user_id,
    agentName: booking.agent_name,
    agentEmail: booking.agent_email,
    gcalEventId: booking.gcal_event_id,
    bucketId: kept.bucket.id,
    requestedBucketId: asked.bucket.id,
    requestedTier: tierKeyOf(asked.bucket.code),
    bookedTier: tierKeyOf(kept.bucket.code),
    rungsDropped: rungs,
    holdId: null,
  });
  if (refused) throw new RerouteRefusedError(refused);
  // A swap that wrote nothing gives a reason today; one that ever did not must never
  // read as a correction made (L12).
  if (!updated) throw new Error(`reroute: the keep swap for booking ${booking.id} wrote nothing`);
  // One history row; nothing is sent, because neither the advisor nor the time changed.
  await deps.insertBookingEvent(
    bookingEventFrom({
      bookingId: booking.id,
      action: "bucket_corrected",
      initiator: "admin",
      reason,
      fromStartsIso: booking.starts_at,
      toStartsIso: booking.starts_at,
      fromAgentUserId: booking.assigned_user_id,
      toAgentUserId: booking.assigned_user_id,
      fromBucketId: fromBucket.id,
      toBucketId: kept.bucket.id,
      actorUserId: input.actor.userId,
      actingAsUserId: input.actor.actingAsUserId,
      nowMs: deps.now(),
    }),
  );
  return { kind: "kept", bucket: bucketView(kept.bucket) };
}

/** Cancel, or the admin walking away: let the held advisor go. */
export async function releaseReroute(deps: RerouteDeps, bookingId: string): Promise<{ released: boolean }> {
  return deps.releaseHold(bookingId);
}

/** The booking's live hold as the proposal it was, so a reload restores the confirm panel. */
export async function currentReroute(deps: RerouteDeps, bookingId: string): Promise<RerouteProposal | null> {
  const hold = await deps.readLiveHold(bookingId);
  if (!hold) return null;
  const [advisor, bucket, requested] = await Promise.all([
    advisorView(deps, hold.agentUserId),
    bucketOrThrow(deps, hold.targetBucketId),
    bucketOrThrow(deps, hold.requestedBucketId),
  ]);
  return {
    kind: "move",
    holdId: hold.holdId,
    expiresAt: hold.expiresAt,
    secondsRemaining: secondsUntil(hold.expiresAt, deps.now()),
    advisor,
    bucket: bucketView(bucket),
    requested: bucketView(requested),
    rungsDropped: hold.rungsDropped,
  };
}
