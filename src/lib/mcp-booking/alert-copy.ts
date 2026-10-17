/**
 * The words of Marcia's failure alerts (#3543). Pure, so `pnpm preview:alerts` calls
 * this rather than holding its own copy (L41).
 *
 * Every failed Marcia write alerts, expected refusals included (plan decision 11,
 * reconfirmed as decision 39). One key per operation and code
 * (`marcia_booking_failed:<operation>:<code>`) throttled by a cooldown, so one outage
 * pages once per kind of failure per window rather than once per call (L36), and a
 * second KIND of failure inside the window still pages on its own.
 *
 * What an alert may carry is ids, the class and the code (L658): the lead's 00Q id
 * and the bucket. Never the token, the lead's name, email or phone; the full error
 * is in the log line under `tag=mcp-booking`.
 */
import type { MarciaFailure } from "./operations.ts";
import { describeTokenRefusal, type MachineTokenRefusal } from "./token-shape.ts";

/**
 * A lead token Slate refused (L688: "a token missing any claim is refused with a
 * named error and an alert"). Keyed by the refusal code, so a signer that stops
 * sending one claim pages once per window under its own name. The token itself is
 * never in the text, and a refused token's claims are not trusted enough to name a lead.
 */
export const MARCIA_TOKEN_REFUSED_KEY_PREFIX = "marcia_token_refused";

export function marciaTokenRefusedKey(r: MachineTokenRefusal): string {
  return `${MARCIA_TOKEN_REFUSED_KEY_PREFIX}:${r.code}`;
}

export function marciaTokenRefusedAlert(r: MachineTokenRefusal): string {
  return (
    `A lead token reaching Marcia's booking endpoint was refused (${r.code}): ${describeTokenRefusal(r)} ` +
    "Nothing was booked. If this repeats, Marcia's signer and Slate disagree about the token; " +
    "check it against src/lib/mcp-booking/machine-token-fixtures.json."
  );
}

/** The gateway secret was missing or wrong on the internal route: the carrier is misconfigured. */
export const MARCIA_GATEWAY_REFUSED_KEY = "marcia_gateway_refused";

export function marciaGatewayRefusedAlert(why: "unconfigured" | "mismatch"): string {
  return why === "unconfigured"
    ? "Marcia's booking route has no MCP_BOOKING_GATEWAY_SECRET on this deployment, so it refuses every call. Set the secret on the slate Worker."
    : "A call reached Marcia's internal booking route without the gateway's secret and was refused. Only McpBookingGateway can reach that route, so this is a misconfigured secret or a probe.";
}

export const MARCIA_FAILURE_KEY_PREFIX = "marcia_booking_failed";
/** One page per kind of failure per quarter hour. */
export const MARCIA_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

export function marciaFailureKey(f: Pick<MarciaFailure, "operation" | "code">): string {
  return `${MARCIA_FAILURE_KEY_PREFIX}:${f.operation}:${f.code}`;
}

export function marciaFailureAlert(f: Omit<MarciaFailure, "cause">): string {
  const verb = { find_times: "find times", book: "book", lookup: "look up a booking", move: "move a call", cancel: "cancel a call" }[f.operation];
  const kind = f.class === "expected" ? "was refused, as designed" : "failed";
  const test = f.test ? " This was a TEST lead token, on the partner test bucket." : "";
  return (
    `Marcia's attempt to ${verb} ${kind} (${f.code}) for lead ${f.salesforceId}, bucket ${f.bucketCode}.${test} ` +
    `Further ${f.code} failures in the next 15 minutes are logged under tag=mcp-booking and not paged again.`
  );
}
