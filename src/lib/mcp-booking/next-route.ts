/**
 * The POST handler each of Marcia's internal routes exports (#3543), one per
 * operation under `src/app/api/internal/mcp-booking/`. One route file per operation
 * so the route manifest (#3536) names each operation's route and the booking tools'
 * coverage can be checked route by route.
 */
import type { NextRequest } from "next/server";
import { marciaTokenKeySlots, mcpBookingGatewaySecret } from "@/lib/env";
import { log } from "@/lib/log";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import {
  MARCIA_FAILURE_COOLDOWN_MS,
  MARCIA_GATEWAY_REFUSED_KEY,
  marciaGatewayRefusedAlert,
  marciaTokenRefusedAlert,
  marciaTokenRefusedKey,
} from "./alert-copy.ts";
import { runMarciaOperation, type MarciaOperation } from "./operations.ts";
import { realMarciaDeps } from "./real-deps.ts";
import { handleMarciaInternal } from "./route-handler.ts";

export function marciaRoute(op: MarciaOperation): (req: NextRequest) => Promise<Response> {
  return (req) =>
    handleMarciaInternal(
      req,
      op,
      { gatewaySecret: mcpBookingGatewaySecret(), tokenKeySlots: marciaTokenKeySlots() },
      {
        nowMs: () => Date.now(),
        run: (operation, args, claims) => runMarciaOperation(operation, args, claims, realMarciaDeps()),
        alertToken: async (refusal) => {
          log.error("mcp-booking", { msg: "lead token refused", operation: op, code: refusal.code, claim: "claim" in refusal ? refusal.claim : null });
          // alert-key: marcia_token_refused:*
          await sendThrottledAlert(marciaTokenRefusedKey(refusal), MARCIA_FAILURE_COOLDOWN_MS, marciaTokenRefusedAlert(refusal));
        },
        alertGateway: async (why) => {
          log.error("mcp-booking", { msg: "gateway secret refused", operation: op, why });
          // alert-key: marcia_gateway_refused
          await sendThrottledAlert(MARCIA_GATEWAY_REFUSED_KEY, MARCIA_FAILURE_COOLDOWN_MS, marciaGatewayRefusedAlert(why));
        },
        logError: (msg, fields) => log.error("mcp-booking", { msg, ...fields }),
      },
    );
}
