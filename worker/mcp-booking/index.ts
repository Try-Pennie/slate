/**
 * `slate-booking-mcp`: Marcia's booking MCP server (#3541, plan phase 4.0).
 *
 * NOT DEPLOYED. Its configuration is `wrangler.mcp-booking.jsonc`, deployed with
 * `wrangler deploy -c wrangler.mcp-booking.jsonc` once the spike's live steps are
 * done (#3541's checklist): Slate must already export `McpBookingGateway` and hold
 * the gateway secret and Marcia's token keys, then this Worker, then its hostname
 * `slate-booking-mcp.trypennie.dev` (a manual custom domain step). Until then nothing
 * reaches it.
 *
 * It holds NO secret (plan locked decision 15): it shape checks Marcia's lead token,
 * applies Marcia's overall limit, and hands each tool call to Slate's
 * `McpBookingGateway` over its one service binding, which is where the token is
 * verified. Its own invocation logs are off in its config, because the incoming
 * `Authorization` header carries the lead token and Cloudflare logs invocation
 * headers verbatim (locked decision 1); its console lines carry no token, argument
 * or answer.
 *
 * Relative imports only, and only import free modules, so the booking service and the
 * OpenNext bundle never reach this Worker (#3532's "the kit does not reach the app"
 * runs the other way here: the app does not reach this).
 */
import { log } from "../../src/lib/log.ts";
import { handleMcp, type GatewayAnswer } from "./protocol.ts";

/** The binding names in `wrangler.mcp-booking.jsonc`. */
export interface BookingMcpEnv {
  SLATE: { booking(signedToken: string, operation: string, args: unknown): Promise<GatewayAnswer> };
  MARCIA_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}

const worker = {
  async fetch(request: Request, env: BookingMcpEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    return handleMcp(request, {
      nowMs: () => Date.now(),
      booking: (token, operation, args) => env.SLATE.booking(token, operation, args),
      withinLimit: async () => {
        // A deployment without its limiter binding is misconfigured: refuse rather
        // than run Marcia unmetered (fail closed), and say so in this Worker's logs.
        if (!env.MARCIA_LIMITER) {
          log.error("mcp-booking-server", { msg: "no MARCIA_LIMITER binding, so every call is refused" });
          return false;
        }
        return (await env.MARCIA_LIMITER.limit({ key: "marcia" })).success;
      },
      logError: (msg, fields) => log.error("mcp-booking-server", { msg, ...fields }),
    });
  },
};

export default worker;
