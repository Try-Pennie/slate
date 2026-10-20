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
 * The internal route is the authority on the token (`src/lib/mcp-booking/route-handler.ts`):
 * it verifies it and decides the lead. This builds the inner Request the carrier
 * describes (`src/lib/mcp-booking/carrier.ts`) and hands it to the app's handler in
 * process, the `LogShippingReceipt` precedent.
 *
 * It ALSO runs the one verifier, with the same keys, for one decision only: whether this
 * call may spend Marcia's overall limit (#3879). A token that verifies calls the MCP
 * Worker's `admit` back over the binding before anything is forwarded, so the limit is
 * spent only by calls that could be Marcia's; a token that does not is forwarded
 * UNCHARGED, so the route still refuses it by name and pages (`marcia_token_refused:*`),
 * and a forger can never use up the limit her real calls need. Why the limit is charged
 * here and not in front of verification: `AdmitCall` in `worker/mcp-booking/protocol.ts`.
 *
 * Lifted out of worker/index.ts because that file imports the generated
 * `.open-next/worker.js` and so cannot be loaded by a test; this takes its fetch and
 * logger as arguments and is driven by `scripts/test-mcp-booking-gateway.ts`.
 */
import { CRON_ORIGIN } from "./lane-run";
import { GATEWAY_SECRET_HEADER, LEAD_TOKEN_HEADER, LIMIT_ADMITTED_HEADER, marciaInternalPath } from "@/lib/mcp-booking/carrier";
import { usableTokenKeys, verifyMachineToken } from "@/lib/mcp-booking/machine-token";
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
  /** `MARCIA_TOKEN_KEY_A` and `_B`, the same slots the internal route verifies with. */
  tokenKeySlots: readonly (string | undefined)[];
  nowMs(): number;
  log: { error(tag: string, fields: LogFields, err?: unknown): void };
}

const own = (status: number, code: string, message: string): GatewayAnswer => ({
  status,
  body: { ok: false, code, class: "unexpected", message },
});

const limitUnchecked = () => own(503, "marcia_limit_unchecked", "Slate could not check Marcia's call limit just now. Try again in a minute.");

function isGatewayAnswer(v: unknown): v is GatewayAnswer {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return typeof a.status === "number" && typeof a.body === "object" && a.body !== null && !Array.isArray(a.body);
}

/**
 * Forward one booking call. Never throws: every ending is an answer.
 *
 * `admit` is the MCP Worker's limit check (`AdmitCall`), called only for a token that
 * verifies. It fails CLOSED: no `admit`, one that throws or cannot be reached, and any
 * answer but `null` all refuse, so no caller of this method can run Marcia unmetered.
 */
export async function forwardBookingCall(
  deps: GatewayDeps,
  signedToken: unknown,
  operation: unknown,
  args: unknown,
  admit: unknown,
): Promise<GatewayAnswer> {
  if (!isMarciaOperation(operation)) return own(400, "unknown_operation", "That is not one of the booking operations.");
  if (typeof signedToken !== "string" || signedToken.length === 0) {
    return own(401, "token_malformed", "No lead token was given.");
  }
  // No secret on this deployment is NOT refused here. The call goes on carrying no
  // secret header, and the internal route, reading the same deployment's secret,
  // refuses it fail closed as `gateway_unconfigured` and pages
  // `marcia_gateway_refused`. A refusal made here could only log, so a deployment
  // that never got its secret would turn every Marcia call away in silence.
  if (!deps.gatewaySecret) {
    deps.log.error("mcp-booking", { msg: "no MCP_BOOKING_GATEWAY_SECRET on this deployment; the internal route will refuse and page" });
  }
  let body: string;
  try {
    body = JSON.stringify({ args: args ?? {} });
  } catch {
    return own(400, "args_invalid", "The arguments could not be read.");
  }
  // #3879: Marcia's overall limit is spent here, after the verifier and before anything
  // runs, and only for a token that verifies. One that does not goes on uncharged, to be
  // refused and paged by the route, which verifies again on its own (L345).
  // The route refuses a verified token without the admitted mark, so a disagreement
  // between this check and the route's can only ever refuse, never run uncharged.
  const verified = await verifyMachineToken(signedToken, usableTokenKeys(deps.tokenKeySlots).keys, deps.nowMs());
  let admitted = false;
  if (verified.ok) {
    if (typeof admit !== "function") {
      deps.log.error("mcp-booking", { msg: "a verified call came with no limit check, so it was refused", operation });
      return limitUnchecked();
    }
    let refused: unknown;
    try {
      refused = await (admit as () => Promise<unknown>)();
    } catch (err) {
      deps.log.error("mcp-booking", { msg: "Marcia's limit check could not be reached, so the call was refused", operation }, err);
      return limitUnchecked();
    }
    if (refused !== null) {
      if (isGatewayAnswer(refused)) return refused;
      deps.log.error("mcp-booking", { msg: "Marcia's limit check answered something unreadable, so the call was refused", operation });
      return limitUnchecked();
    }
    admitted = true;
  }
  try {
    const res = await deps.fetch(
      new Request(`${CRON_ORIGIN}${marciaInternalPath(operation)}`, {
        method: "POST",
        headers: {
          ...(deps.gatewaySecret ? { [GATEWAY_SECRET_HEADER]: deps.gatewaySecret } : {}),
          ...(admitted ? { [LIMIT_ADMITTED_HEADER]: "1" } : {}),
          [LEAD_TOKEN_HEADER]: signedToken,
          "content-type": "application/json",
        },
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
