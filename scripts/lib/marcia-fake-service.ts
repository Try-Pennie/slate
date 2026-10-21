// #3543: a STATEFUL fake of the booking service surface Marcia's operations call,
// so a sequence (book, cancel, book again) can be driven end to end.
//
// `booking-fakes.ts` scripts one call at a time; this one remembers. It models the
// two behaviours the idempotency tests are about, and models them the way the real
// system has them:
//
//  - a write carrying an idempotency key that an ACTIVE booking already holds is a
//    replay of that booking (`findBookingByIdempotencyKey` reads active rows only,
//    #3847);
//  - the Google event id is `deterministicEventId(key, advisor)`, the REAL function,
//    and an id whose event was deleted is a tombstone Google will not create again,
//    which is the slate#3291 defect: the fake throws on it, as the real insert fails.
//
// `keyFrom: "lead-and-slot"` is the positive control: it ignores the caller's key and
// derives one from the lead and the slot, the shape `idempotencyKeyFor` gives, so a
// suite can show its rebook test FAILS on the defect it guards.
import { deterministicEventId } from "../../src/lib/booking/core.ts";
import {
  BookingNotFoundError,
  SlotUnavailableError,
  UnknownBucketError,
  type ApiBookingInput,
  type ApiBookingResult,
  type ApiBookingView,
} from "../../src/lib/booking/orchestration.ts";
import type { AuditEntry } from "../../src/lib/audit.ts";
import type { ReasonOption } from "../../src/lib/booking/core.ts";
import { CANCEL_REASONS } from "../../src/lib/booking/core.ts";
import type { ContactFillReport, LeadContact, MarciaDeps, MarciaFailure } from "../../src/lib/mcp-booking/operations.ts";
import { bookingMatchesLookupIds, lookupStrongIds } from "../../src/lib/booking/lookup-identity.ts";
import type { BookingStatus } from "../../src/lib/db/types.ts";
import { PARTNER_BUCKET_CODE } from "../../src/lib/embed/public-test-bucket.ts";

export interface FakeBooking {
  id: string;
  org_id: string;
  bucketCode: string;
  salesforceId: string;
  /** The row's `external_id`, which a lookup id may match as well (#2657). */
  externalId: string | null;
  startsAt: string;
  status: BookingStatus;
  key: string;
  eventId: string;
  source: string | null;
  /** The zone and the attendee the write was asked for, exactly as passed. */
  timezone: string;
  attendee: ApiBookingInput["attendee"];
}

/** What a contact lookup answers in the suite: the contact, none, or a throw. */
export type FakeContactAnswer = LeadContact | null | Error;

export interface FakeServiceOpts {
  nowMs: number;
  slots: string[];
  keyFrom?: "input" | "lead-and-slot";
  /** Starts another lead has just taken, so a book of one is refused SLOT_TAKEN. */
  takenByOthers?: Set<string>;
  /** What the lead's earlier Slate bookings hold (default: nothing). */
  knownContact?: FakeContactAnswer;
  /** What the Salesforce Lead holds (default: nothing). */
  leadContact?: FakeContactAnswer;
  /** The bucket's minimum notice in minutes, as the slot read reports it (default 0). */
  minNoticeMin?: number;
  /** When true, reporting where a fill came from throws, as a broken logger might. */
  contactFilledThrows?: boolean;
}

const BUCKETS: Record<string, { is_test: boolean; org: string }> = {
  "411": { is_test: false, org: "org1" },
  [PARTNER_BUCKET_CODE]: { is_test: true, org: "org1" },
};

export function makeMarciaFake(opts: FakeServiceOpts) {
  const bookings: FakeBooking[] = [];
  const events = new Map<string, "live" | "deleted">();
  const audits: { entry: AuditEntry; attempt: string; atMs: number }[] = [];
  const alerts: MarciaFailure[] = [];
  const outcomes: { outcome: string; bucketCode: string; errorCode: string | null }[] = [];
  const missed: string[] = [];
  const contactReads: { source: "bookings" | "salesforce"; salesforceIds: string[]; isTest: boolean | null }[] = [];
  // Ownership as the real lookup, by id, move and cancel judge it: every supplied id,
  // against EITHER of the row's id columns (`lookup-identity.ts`, the real functions).
  const owns = (x: FakeBooking, identity: { externalId?: string | null; salesforceId?: string | null }) =>
    bookingMatchesLookupIds({ external_id: x.externalId, salesforce_id: x.salesforceId }, lookupStrongIds({ externalId: identity.externalId ?? null, salesforceId: identity.salesforceId ?? null }));
  const contactFailures: { source: "bookings" | "salesforce"; err: unknown }[] = [];
  const contactFills: ContactFillReport[] = [];
  const answerContact = async (a: FakeContactAnswer | undefined): Promise<LeadContact | null> => {
    if (a instanceof Error) throw a;
    return a ?? null;
  };
  let now = opts.nowMs;
  let seq = 0;

  const active = (b: FakeBooking) => b.status === "confirmed" || b.status === "rescheduled";
  const toView = (b: FakeBooking): ApiBookingView =>
    ({
      id: b.id,
      externalId: b.externalId,
      salesforceId: b.salesforceId,
      startsAt: b.startsAt,
      endsAt: b.startsAt,
      status: b.status,
      agent: { name: "Advisor A", email: "advisor.a@example.com" },
      manageUrl: `https://slate.example/booking/${b.id}`,
      isTest: BUCKETS[b.bucketCode]!.is_test,
      partnerSubmissionId: null,
      partnerLeadId: null,
    }) as unknown as ApiBookingView;

  const deps: MarciaDeps = {
    nowMs: () => now,
    slotSecret: "a-gateway-secret-for-the-suite-only-0000000000",
    // Ignores `from` on purpose. The real read judges its tier and offered days from it
    // (#4014, pinned in `slot-cache.test.ts`), but the operations apply `from` to the
    // offer themselves whatever the reader does, and this keeps that floor under test.
    readSlots: async (code, _from, allowTest) => {
      const b = BUCKETS[code];
      if (!b || (b.is_test && !allowTest)) return null;
      const held = new Set(bookings.filter((x) => active(x) && x.bucketCode === code).map((x) => x.startsAt));
      return { slots: opts.slots.filter((s) => !held.has(s)), minNoticeMin: opts.minNoticeMin ?? 0, computedAt: "2026-06-01T00:00:00.000Z" };
    },
    book: async (input: ApiBookingInput): Promise<ApiBookingResult> => {
      const b = BUCKETS[input.bucketCode];
      if (!b || (b.is_test && !input.allowTestBuckets)) throw new UnknownBucketError();
      const key =
        opts.keyFrom === "lead-and-slot" ? `${input.bucketCode}|${input.startIso}|${input.salesforceId}` : (input.idempotencyKey ?? "");
      const replay = bookings.find((x) => active(x) && x.key === key);
      const result = (x: FakeBooking, outcome: ApiBookingResult["outcome"]): ApiBookingResult =>
        ({
          outcome,
          booking: { id: x.id, org_id: x.org_id, starts_at: x.startsAt, ends_at: x.startsAt, status: x.status, agent_name: "Advisor A", external_id: x.externalId, salesforce_id: x.salesforceId },
          manageUrl: `https://slate.example/booking/${x.id}`,
        }) as unknown as ApiBookingResult;
      if (replay) return result(replay, "created");
      // The person decision fetches and grades by the same strong ids (`personIdentityOf`).
      const mine = bookings.find((x) => active(x) && owns(x, input));
      if (mine) {
        if (!input.confirmReschedule) return result(mine, "confirm_required");
        if (mine.startsAt === input.startIso) return result(mine, "deduped");
        mine.startsAt = input.startIso;
        mine.status = "rescheduled";
        mine.timezone = input.timezone;
        mine.attendee = input.attendee;
        return result(mine, "rescheduled");
      }
      if (opts.takenByOthers?.has(input.startIso)) throw new SlotUnavailableError();
      const eventId = await deterministicEventId(key, "advisor-a");
      // Google keeps a deleted event's id: inserting it again is refused (#3291).
      if (events.get(eventId) === "deleted") throw new Error("calendar refused the event id: it belongs to a deleted event");
      events.set(eventId, "live");
      const row: FakeBooking = {
        id: `bk${++seq}`,
        org_id: b.org,
        bucketCode: input.bucketCode,
        salesforceId: input.salesforceId ?? "",
        externalId: input.externalId ?? null,
        startsAt: input.startIso,
        status: "confirmed",
        key,
        eventId,
        source: input.mcpChannel ? `mcp-${input.mcpChannel}` : null,
        timezone: input.timezone,
        attendee: input.attendee,
      };
      bookings.push(row);
      return result(row, "created");
    },
    cancel: async ({ bookingId, identity }) => {
      const b = bookings.find((x) => x.id === bookingId && active(x) && owns(x, identity));
      if (!b) throw new BookingNotFoundError();
      b.status = "cancelled";
      events.set(b.eventId, "deleted");
      return toView(b);
    },
    lookup: async (identity) => bookings.filter((x) => active(x) && owns(x, identity)).map(toView),
    bookingById: async ({ bookingId, identity, status }) => {
      const b = bookings.find((x) => x.id === bookingId && owns(x, identity));
      if (!b || (status && b.status !== status)) throw new BookingNotFoundError();
      return toView(b);
    },
    cancelReasons: async (): Promise<ReasonOption[]> => CANCEL_REASONS,
    recentChanges: async (salesforceId, sinceMs) =>
      audits.filter(
        (a) =>
          a.atMs >= sinceMs &&
          a.entry.details?.salesforce_id === salesforceId &&
          (a.entry.action === "booking.rescheduled" || a.entry.action === "booking.cancelled"),
      ).length,
    bookingFacts: async (bookingId) => {
      const b = bookings.find((x) => x.id === bookingId);
      if (!b) throw new Error("no such booking");
      return { orgId: b.org_id, isTest: BUCKETS[b.bucketCode]!.is_test };
    },
    attemptBooking: async (attempt) => {
      const row = audits.find((a) => a.attempt === attempt);
      return row ? String(row.entry.details?.booking_id) : null;
    },
    audit: async (entry, attempt) => {
      if (audits.some((a) => a.attempt === attempt && a.entry.action === entry.action)) return;
      audits.push({ entry, attempt, atMs: now });
    },
    auditMissed: async (action, bookingId) => {
      missed.push(`${action}:${bookingId}`);
    },
    recordOutcome: (outcome, bucketCode, errorCode) => {
      outcomes.push({ outcome, bucketCode, errorCode });
    },
    alert: async (f) => {
      alerts.push(f);
    },
    knownContact: async (salesforceIds, isTest) => {
      contactReads.push({ source: "bookings", salesforceIds: [...salesforceIds], isTest });
      return answerContact(opts.knownContact);
    },
    leadContact: async (salesforceId) => {
      contactReads.push({ source: "salesforce", salesforceIds: [salesforceId], isTest: null });
      return answerContact(opts.leadContact);
    },
    contactLookupFailed: (source, err) => {
      contactFailures.push({ source, err });
    },
    contactFilled: (report) => {
      contactFills.push(report);
      if (opts.contactFilledThrows) throw new Error("the fill report could not be logged");
    },
  };

  return {
    deps,
    bookings,
    events,
    audits,
    alerts,
    outcomes,
    missed,
    contactReads,
    contactFailures,
    contactFills,
    /** A booking some OTHER channel wrote (the embed, the #250 API), with its own id spellings. */
    seedBooking(b: { salesforceId: string; externalId: string | null; startsAt: string; bucketCode?: string }) {
      bookings.push({
        id: `seed${++seq}`,
        org_id: "org1",
        bucketCode: b.bucketCode ?? "411",
        salesforceId: b.salesforceId,
        externalId: b.externalId,
        startsAt: b.startsAt,
        status: "confirmed",
        key: `seed-key-${seq}`,
        eventId: `seed-event-${seq}`,
        source: null,
        timezone: "America/Chicago",
        attendee: {},
      });
    },
    advance(ms: number) {
      now += ms;
    },
  };
}
