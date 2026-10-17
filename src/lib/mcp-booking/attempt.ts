/**
 * One ATTEMPT's identity, and the idempotency key it books under (#3543, L747, L186).
 *
 * The key a write collapses onto must name one attempt, never one lead or one slot:
 *
 *  - a RETRY of one attempt (OpenAI re-sending the same tool call, which Marcia
 *    re-signs with the same nonce) must adopt the same booking and the same Google
 *    event, so it carries the same key;
 *  - a NEW attempt after a cancel must get a fresh key, because the Google event id
 *    is derived from the key plus the advisor (`deterministicEventId`). A key derived
 *    from the lead and the slot (`idempotencyKeyFor`) gives a rebook of the same slot
 *    with the same advisor the cancelled event's id, Google answers with the
 *    tombstone, and the lead is told they are booked with no invite (slate#3291).
 *
 * So the key is the operation, the lead's 00Q id and Marcia's per attempt nonce, and
 * nothing a model or a JSON-RPC session supplies: the same JSON-RPC id from two
 * sessions with two nonces is two attempts.
 *
 * Spike #3541 records whether OpenAI retries really keep the nonce. If they re-sign
 * with a new one, this is the one function that changes (to a per attempt id Marcia
 * carries in its own signed claim).
 */
import type { MarciaLeadClaims } from "./token-shape.ts";

export const MARCIA_WRITE_OPERATIONS = ["book", "move", "cancel"] as const;
export type MarciaWriteOperation = (typeof MARCIA_WRITE_OPERATIONS)[number];

/** The prefix every Marcia idempotency key carries, so a key names its channel. */
export const MARCIA_KEY_PREFIX = "mcp-marcia";

export function attemptKey(operation: MarciaWriteOperation, claims: Pick<MarciaLeadClaims, "salesforce_id" | "nonce">): string {
  return `${MARCIA_KEY_PREFIX}:${operation}:${claims.salesforce_id}:${claims.nonce}`;
}
