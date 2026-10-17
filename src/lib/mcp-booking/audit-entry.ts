/**
 * The audit row for one of Marcia's booking writes (#3542, plan phase 4.1a).
 *
 * Marcia is Pennie's automated booker, reaching Slate through her own MCP endpoint
 * (`worker/mcp-booking`, #3541) and the `McpBookingGateway` entrypoint (#3543). Plan
 * decision 11 puts every such write in Slate's existing audit trail, tagged with the
 * channel, with "the bot plus the lead's 00Q id" as the actor. So:
 *
 *  - `actor_id` is null: the column is nullable, and Marcia is not a Slate user, so
 *    there is no `users` row it could name;
 *  - `org_id` is the booking's, which `createBooking` takes from the bucket it routed
 *    into, because the column is NOT NULL;
 *  - `details` carries the channel (through `AuditEntry.channel`, its one home), the
 *    lead's 00Q id, the booking id and the TEST MARK.
 *
 * The test mark is the booking's bucket `is_test`, passed in by the caller from the
 * same booking it recorded, never from the token's test claim: the plan's one
 * predicate for "not real" is the bucket (L261), and the Regal hold (0066) and the
 * monitoring exclusion already read that same flag.
 *
 * Pure: no database, so it is driven by `scripts/test-audit-channel.ts`.
 */
import type { AuditAction, AuditEntry } from "@/lib/audit";

/** The trail actions a Marcia write records, one per write operation. */
export const MARCIA_AUDIT_ACTIONS = [
  "booking.created",
  "booking.rescheduled",
  "booking.cancelled",
] as const satisfies readonly AuditAction[];
export type MarciaAuditAction = (typeof MARCIA_AUDIT_ACTIONS)[number];

export interface MarciaAuditInput {
  action: MarciaAuditAction;
  /** The booking the write made, moved or cancelled. */
  booking: { id: string; org_id: string };
  /** The lead's Salesforce 00Q id, from the verified token. */
  salesforceId: string;
  /** The booking's bucket `is_test`: the one "not real" predicate. */
  isTest: boolean;
}

export function marciaAuditEntry(input: MarciaAuditInput): AuditEntry {
  return {
    orgId: input.booking.org_id,
    actorId: null,
    action: input.action,
    channel: "marcia",
    details: {
      booking_id: input.booking.id,
      salesforce_id: input.salesforceId,
      test: input.isTest,
    },
  };
}
