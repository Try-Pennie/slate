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
import type { RerouteTarget } from "./orchestration.ts";
import type { BookingActor, BookingEventInsert, VerifyResult } from "./core.ts";
import { bookingEventFrom, bufferedWindow } from "./core.ts";
import { tierKeyOf } from "../routing/tiers.ts";
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
  | { kind: "none"; requested: RerouteBucket };

/** What a confirm did. */
export type RerouteOutcome =
  | { kind: "moved"; advisor: RerouteAdvisor; bucket: RerouteBucket }
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
  findTarget(booking: Booking, requested: { bucket: Bucket; eventType: EventType }): Promise<RerouteTarget>;
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
  /** The existing reassign (`reassignBooking`), bound to the admin actor, with the reroute swap args. */
  reassign(bookingId: string, agentEmail: string, reason: { code: string; detail: string | null }, reroute: RerouteSwapArgs): Promise<void>;
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
): Promise<RerouteProposal> {
  const target = await deps.findTarget(booking, requested);
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
  return {
    kind: "keep",
    lastResort: target.outcome === "keep-last-resort",
    advisor: await advisorView(deps, booking.assigned_user_id),
    bucket: bucketView(target.bucket),
    requested: req,
    rungsDropped: target.rungsDropped,
  };
}

/** Find who should take a booking in `bucketCode`, holding them when they are new. */
export async function startReroute(
  deps: RerouteDeps,
  input: { bookingId: string; bucketCode: string; actor: BookingActor },
): Promise<RerouteProposal> {
  const { booking } = await reroutableBooking(deps, input.bookingId);
  const requested = await requestedBucket(deps, input.bucketCode);
  return searchAndHold(deps, booking, requested, input.actor);
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
    /** A keep in a lower tier: the bucket that was asked for, and how far it dropped. */
    requestedBucketCode?: string | null;
    rungsDropped?: number;
    note: string | null;
    actor: BookingActor;
  },
): Promise<RerouteOutcome> {
  const reason = { code: REROUTE_REASON_CODE, detail: input.note && input.note.trim() ? input.note.trim() : null };

  if (input.holdId === null) return confirmKeep(deps, input, reason);

  const ctx = await deps.loadBookingById(input.bookingId);
  if (!ctx) throw new RerouteRefusedError("booking_not_found");
  const { booking, bucket: fromBucket, eventType } = ctx;

  const claim = await deps.claimHold(booking.org_id, booking.id, input.holdId);
  if (claim.refused === "hold_consumed") {
    // A repeated confirm: answer what the first one did rather than "expired".
    const r = claim.result ?? {};
    const agentId = typeof r.agent_user_id === "string" ? r.agent_user_id : null;
    const bucketId = typeof r.bucket_id === "string" ? r.bucket_id : null;
    const code = typeof r.bucket_code === "string" ? r.bucket_code : null;
    if (!agentId || !code) throw new Error("reroute: a consumed hold carried no readable result");
    const bucket = bucketId ? bucketView(await bucketOrThrow(deps, bucketId)) : { id: "", code, name: code };
    return { kind: "moved", advisor: await advisorView(deps, agentId), bucket };
  }
  if (claim.refused === "hold_expired" || claim.refused === "hold_not_found") return { kind: "expired" };
  if (claim.refused) throw new RerouteRefusedError(claim.refused);
  // From here on the hold is claimed, which extends it to a confirm lease. ANY
  // failure lets it go, so an unreadable calendar or a failed read never leaves the
  // advisor blocked for leads until the lease runs out (#3249 review).
  try {
    return await moveOnClaimedHold(deps, { booking, fromBucket, eventType }, claim, input, reason);
  } catch (err) {
    await deps.releaseHold(booking.id).catch(() => undefined);
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
  const requested = await bucketOrThrow(deps, held.requestedBucketId);

  const [fromIso, toIso] = bufferedWindow(eventType, new Date(booking.starts_at).toISOString(), new Date(booking.ends_at).toISOString());
  const verify = await deps.verifyFree([advisor.email], fromIso, toIso);
  if (verify.unverified.has(advisor.email)) {
    throw new Error(`reroute: ${advisor.email}'s calendar could not be read at confirm`);
  }
  if (!verify.free.has(advisor.email)) {
    // Booked since the hold was placed: release it and search again, so the admin
    // confirms a fresh proposal rather than a move onto somebody now busy.
    await deps.releaseHold(booking.id);
    const proposal = await searchAndHold(deps, booking, { bucket: requested, eventType }, input.actor);
    return { kind: "taken", previous: advisor, proposal };
  }

  // The reassign rolls back its own Google event on failure; the caller lets the
  // hold go.
  await deps.reassign(booking.id, advisor.email, reason, {
    holdId: input.holdId,
    bucketId: target.id,
    requestedBucketId: requested.id,
    requestedTier: tierKeyOf(requested.code),
    bookedTier: tierKeyOf(target.code),
    rungsDropped: held.rungsDropped,
    fromBucketId: fromBucket.id,
  });
  return { kind: "moved", advisor, bucket: bucketView(target) };
}

async function confirmKeep(
  deps: RerouteDeps,
  input: { bookingId: string; bucketCode: string | null; requestedBucketCode?: string | null; rungsDropped?: number; actor: BookingActor },
  reason: { code: string; detail: string | null },
): Promise<RerouteOutcome> {
  const { booking, bucket: fromBucket } = await reroutableBooking(deps, input.bookingId);
  const kept = await requestedBucket(deps, input.bucketCode);
  // A cascaded keep records what was asked for and the drop, as the move does.
  const asked = input.requestedBucketCode ? await requestedBucket(deps, input.requestedBucketCode) : kept;
  const rungs = input.rungsDropped ?? 0;
  if (!booking.assigned_user_id || !booking.agent_email || !booking.gcal_event_id) {
    throw new RerouteRefusedError("no_current_advisor");
  }
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
