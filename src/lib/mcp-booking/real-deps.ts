/**
 * The production wiring of Marcia's booking operations (#3543): the same service
 * functions the #250 direct booking API calls, the slot cache the embed reads, the
 * audit trail, the outcome tally and the alert dispatcher.
 *
 * Kept apart from `operations.ts` so the operations stay drivable with fakes, and
 * from the route file so a Next route module exports only its handlers.
 */
import { getBucketSlotsWithFallback } from "@/lib/availability/slot-cache";
import { recordAudit, AUDIT_WRITE_FAILED_KEY, AUDIT_WRITE_FAILED_COOLDOWN_MS } from "@/lib/audit";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { bookViaApi, cancelDirectBooking, getPersonBookingById, lookupPersonBookings, readKnownContact } from "@/lib/booking/service";
import { readWithinDeadline } from "@/lib/read-within-deadline";
import { readLeadContactLive } from "@/lib/salesforce/lead-contact";
import { unwrap, unwrapCount } from "@/lib/db/result";
import { mcpBookingGatewaySecret } from "@/lib/env";
import { log } from "@/lib/log";
import { recordApiOutcome } from "@/lib/monitor/record-api-outcome";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { shortErrorReason } from "@/lib/notify/error-text";
import { auditWriteFailedAlert } from "@/lib/notify/misc-alert-copy";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { MARCIA_FAILURE_COOLDOWN_MS, marciaFailureAlert, marciaFailureKey } from "./alert-copy.ts";
import type { MarciaDeps } from "./operations.ts";

const MARCIA_CHANGE_ACTIONS = ["booking.rescheduled", "booking.cancelled"];

/**
 * How long a book or move waits for the Salesforce Lead's details before booking
 * without them. The lead is on a live call while the model waits on this tool, and
 * a slow Salesforce must cost them a missing invite address, never the booking.
 * The same bound the lead facing calling number read uses (`CALLING_NUMBER_DEADLINE_MS`).
 */
const LEAD_CONTACT_DEADLINE_MS = 2_500;

export function realMarciaDeps(): MarciaDeps {
  return {
    nowMs: () => Date.now(),
    slotSecret: mcpBookingGatewaySecret(),
    readSlots: async (code, fromIso, allowTest, nowMs) => {
      // #4014: the tier and the offered days are judged from the day the lead asked
      // for, not from now. An unreadable from is refused by find_times before it gets
      // here; if one did arrive, reading from now would answer another question.
      const lookFromMs = Date.parse(fromIso);
      if (!Number.isFinite(lookFromMs)) throw new Error("find_times reached the slot read with a from it cannot read");
      const r = await getBucketSlotsWithFallback(code, fromIso, allowTest, nowMs, undefined, { lookFromMs });
      return r ? { slots: r.slots, minNoticeMin: r.eventType.min_notice_min, computedAt: r.computedAt } : null;
    },
    book: (input) => bookViaApi(input),
    cancel: (input) => cancelDirectBooking(input),
    lookup: (identity) => lookupPersonBookings(identity),
    bookingById: (input) => getPersonBookingById(input),
    cancelReasons: async () => (await loadReasonOptions()).cancel.all,
    recentChanges: async (salesforceId, sinceMs) =>
      unwrapCount(
        await supabaseAdmin()
          .from("audit_log")
          .select("id", { count: "exact", head: true })
          .in("action", MARCIA_CHANGE_ACTIONS)
          .contains("details", { channel: "marcia", salesforce_id: salesforceId })
          .gte("created_at", new Date(sinceMs).toISOString()),
        "marcia recent changes",
      ),
    bookingFacts: async (bookingId) => {
      const row = unwrap(
        await supabaseAdmin().from("bookings").select("org_id, buckets(is_test)").eq("id", bookingId).maybeSingle(),
        "marcia booking facts",
      ) as { org_id: string; buckets: { is_test: boolean } | null } | null;
      if (!row || !row.buckets) throw new Error("the booking or its bucket could not be read");
      return { orgId: row.org_id, isTest: row.buckets.is_test === true };
    },
    attemptBooking: async (attempt) => {
      // cap-safe: limit(1); at most one row is wanted, the first one this attempt wrote.
      const rows = unwrap(
        await supabaseAdmin().from("audit_log").select("details").contains("details", { attempt }).limit(1),
        "marcia attempt booking",
      ) as { details: { booking_id?: unknown } }[] | null;
      const id = rows?.[0]?.details?.booking_id;
      return typeof id === "string" ? id : null;
    },
    audit: async (entry, attempt) => {
      // One row per attempt: a retry of an attempt that already wrote its row records
      // nothing new. Read first, then write; two retries racing in the same second can
      // both write, which leaves a duplicate row naming the same attempt, never a lost one.
      const seen = unwrapCount(
        await supabaseAdmin()
          .from("audit_log")
          .select("id", { count: "exact", head: true })
          .eq("action", entry.action)
          .contains("details", { attempt }),
        "marcia audit seen",
      );
      // recordAudit never throws: a refused insert pages audit_write_failed itself, so a
      // row that did not land is reported there, not through `auditMissed`.
      if (seen === 0) await recordAudit(entry);
    },
    auditMissed: async (action, bookingId, err) => {
      log.error("mcp-booking", { msg: "a Marcia write landed and its audit row did not", action, booking_id: bookingId }, err);
      // alert-key: audit_write_failed
      // alert-text-ok: shortErrorReason returns one short human line; the full error is in the log line above.
      await sendThrottledAlert(AUDIT_WRITE_FAILED_KEY, AUDIT_WRITE_FAILED_COOLDOWN_MS, auditWriteFailedAlert(action, shortErrorReason(err)));
    },
    recordOutcome: (outcome, bucketCode, errorCode) =>
      recordApiOutcome(outcome, bucketCode, errorCode, { by: "bucket", code: bucketCode, host: { prefill: {}, referrer_origin: null } }),
    alert: async (f) => {
      const { cause, ...fields } = f;
      log.error(
        "mcp-booking",
        { msg: "Marcia operation failed", operation: f.operation, code: f.code, class: f.class, salesforce_id: f.salesforceId, bucket: f.bucketCode, test: f.test },
        cause,
      );
      // alert-key: marcia_booking_failed:*
      await sendThrottledAlert(marciaFailureKey(fields), MARCIA_FAILURE_COOLDOWN_MS, marciaFailureAlert(fields));
    },
    knownContact: (salesforceIds, isTest) => readKnownContact(salesforceIds, { isTest }, "marcia known contact"),
    leadContact: async (salesforceId) => {
      // A refusal and a timeout both reach the operation as a throw, so the one place
      // that reports a failed lookup (`contactLookupFailed`) sees both.
      let failed = false;
      let failure: unknown;
      const found = await readWithinDeadline(() => readLeadContactLive(salesforceId), LEAD_CONTACT_DEADLINE_MS, (err) => {
        failed = true;
        failure = err;
      });
      if (failed) throw failure instanceof Error ? failure : new Error("the Salesforce Lead read failed");
      return found;
    },
    contactLookupFailed: (source, err) => {
      // The source and the error, never a value: the lead's details stay out of the logs.
      log.warn("mcp-booking", { msg: "a lead contact lookup failed, so the booking goes ahead without what it would have filled", source }, err);
    },
    contactFilled: (report) => {
      // #4006: where each missing field came from, by field NAME, so a move's fill can
      // be traced to the bookings or the Salesforce Lead without a value in the log.
      log.info("mcp-booking", {
        msg: "a lead's missing contact fields were looked up",
        from_bookings: report.bookings.join(",") || null,
        from_salesforce: report.salesforce.join(",") || null,
        still_missing: report.missing.join(",") || null,
      });
    },
  };
}
