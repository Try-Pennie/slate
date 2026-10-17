/**
 * Slate's half of Marcia's booking MCP endpoint (#3543, plan phase 4.2).
 *
 * `McpBookingGateway` (worker/index.ts) is a named entrypoint: reachable only through
 * a service binding in this account, never over HTTP, and bound by exactly one Worker,
 * `slate-booking-mcp` (`worker/mcp-booking`, `wrangler.mcp-booking.jsonc`), which binds
 * it and nothing else (plan locked decision 9). Its one method is `booking()`.
 *
 * WHO MAY CALL: the booking MCP Worker, through its binding. WHOSE DATA: the lead
 * Marcia's signed token names, as Slate verifies it; nothing an argument says.
 *
 * It does not verify the token itself: the secret lives with the app, so the internal
 * route verifies it (`src/lib/mcp-booking/route-handler.ts`). This builds the inner
 * Request the carrier describes (`src/lib/mcp-booking/carrier.ts`) and hands it to the
 * app's handler in process, the `LogShippingReceipt` precedent.
 *
 * Lifted out of worker/index.ts because that file imports the generated
 * `.open-next/worker.js` and so cannot be loaded by a test; this takes its fetch and
 * logger as arguments and is driven by `scripts/test-mcp-booking-gateway.ts`.
 */
import { CRON_ORIGIN } from "./lane-run";
import { GATEWAY_SECRET_HEADER, LEAD_TOKEN_HEADER, marciaInternalPath } from "@/lib/mcp-booking/carrier";
import { isMarciaOperation } from "@/lib/mcp-booking/operation-names";
import type { LogFields } from "@/lib/log";

/** What `booking()` answers: the internal route's status and JSON body, or a refusal of its own. */
export interface GatewayAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface GatewayDeps {
  fetch(request: Request): Response | Promise<Response>;
  gatewaySecret: string;
  log: { error(tag: string, fields: LogFields, err?: unknown): void };
}

const own = (status: number, code: string, message: string): GatewayAnswer => ({
  status,
  body: { ok: false, code, class: "unexpected", message },
});

/** Forward one booking call. Never throws: every ending is an answer. */
export async function forwardBookingCall(deps: GatewayDeps, signedToken: unknown, operation: unknown, args: unknown): Promise<GatewayAnswer> {
  if (!isMarciaOperation(operation)) return own(400, "unknown_operation", "That is not one of the booking operations.");
  if (typeof signedToken !== "string" || signedToken.length === 0) {
    return own(401, "token_malformed", "No lead token was given.");
  }
  if (!deps.gatewaySecret) {
    deps.log.error("mcp-booking", { msg: "no MCP_BOOKING_GATEWAY_SECRET on this deployment, so the booking gateway refuses every call" });
    return own(503, "gateway_unconfigured", "Slate cannot take Marcia's calls on this deployment yet.");
  }
  let body: string;
  try {
    body = JSON.stringify({ args: args ?? {} });
  } catch {
    return own(400, "args_invalid", "The arguments could not be read.");
  }
  try {
    const res = await deps.fetch(
      new Request(`${CRON_ORIGIN}${marciaInternalPath(operation)}`, {
        method: "POST",
        headers: { [GATEWAY_SECRET_HEADER]: deps.gatewaySecret, [LEAD_TOKEN_HEADER]: signedToken, "content-type": "application/json" },
        body,
      }),
    );
    const parsed: unknown = await res.json().catch(() => null);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      deps.log.error("mcp-booking", { msg: "the internal booking route answered something that is not JSON", operation, status: res.status });
      return own(502, "gateway_unreadable", "Slate answered in a shape the gateway could not read.");
    }
    return { status: res.status, body: parsed as Record<string, unknown> };
  } catch (err) {
    deps.log.error("mcp-booking", { msg: "the internal booking route threw", operation }, err);
    return own(500, "internal", "Something went wrong in Slate. Try again in a minute.");
  }
}
