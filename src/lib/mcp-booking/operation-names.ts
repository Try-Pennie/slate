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
