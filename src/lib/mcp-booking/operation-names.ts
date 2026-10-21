/**
 * The names of Marcia's five booking operations (#3543, decision 17: find times,
 * book, look up the lead's booking, move, cancel), import free so the Worker entry
 * and the booking MCP Worker can name them without bundling the booking service.
 *
 * `operations.ts` re-exports these and implements each one; the MCP Worker's tool
 * registry declares which operation each tool calls, and #3544's isolation suite
 * holds the two to each other.
 */
export const MARCIA_OPERATIONS = ["find_times", "book", "lookup", "move", "cancel"] as const;
export type MarciaOperation = (typeof MARCIA_OPERATIONS)[number];

export function isMarciaOperation(v: unknown): v is MarciaOperation {
  return typeof v === "string" && (MARCIA_OPERATIONS as readonly string[]).includes(v);
}

/**
 * The arguments each operation takes, and nothing else (#4013). The tool registry
 * the MCP Worker lists (`worker/mcp-booking/registry.ts`) declares exactly these, and
 * the operations refuse any other argument by name rather than ignore it: live on
 * 2026-10-21 a declared `from` that nothing read moved a lead to the wrong day.
 * `scripts/test-marcia-tool-arguments.ts` holds the registry to this list and proves
 * each argument here changes what its operation does.
 */
export const MARCIA_OPERATION_ARGS = {
  find_times: ["time_zone", "from", "near"],
  book: ["slot_id", "time_zone"],
  lookup: ["time_zone"],
  move: ["slot_id", "time_zone"],
  cancel: ["reason_code", "reason_detail", "booking_id", "declined_slot_ids", "time_zone"],
} as const satisfies Record<MarciaOperation, readonly string[]>;
