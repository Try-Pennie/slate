/**
 * The booking MCP server's tool registry (#3541, #3543, plan decision 17).
 *
 * Five tools, one per booking operation, each declaring the ONE gateway method it
 * calls and the internal Slate route that answers it. The registry is the source the
 * MCP server lists from, the route coverage check (#3536) reads its covered routes
 * from, and #3544's isolation suite holds against `McpBookingGateway`'s own methods,
 * so the three cannot drift apart.
 *
 * No tool takes a lead: the lead is the connection's signed token. The model may
 * pass a time zone, a slot id it was given, a reason from Slate's list and a booking
 * id, and nothing else reaches Slate.
 *
 * Relative imports only, and only import free modules: this Worker is bundled from
 * its own config and must never pull in the booking service.
 */
import { marciaInternalPath } from "../../src/lib/mcp-booking/carrier.ts";
import { MARCIA_OPERATIONS, type MarciaOperation } from "../../src/lib/mcp-booking/operation-names.ts";

/** The gateway methods this Worker calls on its `SLATE` binding: exactly one. */
export const BOOKING_GATEWAY_METHODS = ["booking"] as const;
export type BookingGatewayMethod = (typeof BOOKING_GATEWAY_METHODS)[number];

export interface BookingTool {
  name: MarciaOperation;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  /** The gateway method the tool calls. */
  gatewayMethod: BookingGatewayMethod;
  /** The Slate route that answers it, for the route coverage check. */
  route: string;
}

const timeZone = {
  type: "string",
  description:
    "The lead's IANA time zone, only if it differs from the one Marcia signed or the answer said the zone was assumed (time_zone_note), e.g. America/Denver.",
};
const slotId = { type: "string", description: "A slot_id exactly as find_times returned it. Never a time you wrote yourself." };

/** Book and move take the same arguments: a slot id find_times gave, and optionally a zone. */
const slotSchema: BookingTool["inputSchema"] = {
  type: "object",
  properties: { slot_id: slotId, time_zone: timeZone },
  required: ["slot_id"],
  additionalProperties: false,
};

/** Per operation, so `tsc` refuses an operation added without its tool. */
const TOOLS: Record<MarciaOperation, Omit<BookingTool, "name" | "gatewayMethod" | "route">> = {
  find_times: {
    description: "Find up to five open times for this lead's call, already written out in the lead's time zone. Offer them as written.",
    inputSchema: {
      type: "object",
      properties: { time_zone: timeZone, from: { type: "string", description: "Look from this date (YYYY-MM-DD in the lead's zone) instead of now." } },
      additionalProperties: false,
    },
  },
  book: {
    description: "Book the lead's call at one of the times find_times offered, by its slot_id. If the time was just taken, offer the alternatives in the answer.",
    inputSchema: slotSchema,
  },
  lookup: {
    description: "Look up the lead's booked call: when it is and with which advisor.",
    inputSchema: { type: "object", properties: { time_zone: timeZone }, additionalProperties: false },
  },
  move: {
    description: "Move the lead's booked call to another time find_times offered, by its slot_id.",
    inputSchema: slotSchema,
  },
  cancel: {
    description:
      "Cancel the lead's booked call with one of Slate's reasons. For a schedule conflict, first offer new times with find_times; cancel only once the lead declines them, passing the slot_ids they declined.",
    inputSchema: {
      type: "object",
      properties: {
        reason_code: { type: "string", description: "One of Slate's cancel reasons, e.g. no_longer_interested or schedule_conflict." },
        reason_detail: { type: "string", description: "Only for reason_code other: a short note in the lead's own words." },
        booking_id: { type: "string", description: "The booking to cancel, when the lead holds more than one." },
        declined_slot_ids: { type: "array", items: { type: "string" }, description: "For a schedule conflict: the slot_ids offered and declined." },
        time_zone: timeZone,
      },
      required: ["reason_code"],
      additionalProperties: false,
    },
  },
};

export const BOOKING_TOOLS: readonly BookingTool[] = MARCIA_OPERATIONS.map((name) => ({
  name,
  ...TOOLS[name],
  gatewayMethod: "booking",
  route: marciaInternalPath(name),
}));

export function bookingTool(name: unknown): BookingTool | undefined {
  return BOOKING_TOOLS.find((t) => t.name === name);
}
