/**
 * The booking MCP server's protocol handling (#3541): MCP over Streamable HTTP,
 * stateless, answered as `application/json` (the transport allows a JSON answer in
 * place of an event stream), with no session id because there is no session to keep:
 * every call carries the lead's signed token and stands on its own.
 *
 * Handled: `initialize`, `notifications/initialized` (and any notification: 202, no
 * body), `ping`, `tools/list`, `tools/call`. Anything else is JSON-RPC's method not
 * found. A batch is refused, as protocol 2025-06-18 removed batching.
 *
 * WHO MAY CALL: anyone who can reach the hostname, so nothing here trusts the caller:
 * the lead token is shape checked here (no secret), VERIFIED by Slate, and the JSON-RPC
 * id is never an identity (two sessions sending the same id with two nonces are two
 * attempts). WHOSE DATA: the lead the token names, as Slate decides.
 *
 * Marcia's overall limit is spent only by a call whose token Slate VERIFIED (#3879,
 * `AdmitCall` below holds why), never by a shape valid forgery.
 *
 * Pure: takes the gateway and the limiter as arguments, so
 * `scripts/test-mcp-booking-worker.ts` drives it with no Worker.
 */
import { describeTokenRefusal, parseMachineTokenShape } from "../../src/lib/mcp-booking/token-shape.ts";
import { BOOKING_TOOLS, bookingTool } from "./registry.ts";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
export const SERVER_INFO = { name: "slate-booking", version: "0.1.0" } as const;

/**
 * The window of the overall limit Marcia's calls share (decision 12), stated in its
 * refusal. A second copy of `period` in `wrangler.mcp-booking.jsonc`, held equal to it
 * by `scripts/test-mcp-booking-worker.ts` (#3879).
 */
export const MARCIA_LIMIT_PERIOD_SEC = 60;

/** The over limit refusal, built from the period so it can only name the one configured. */
export function marciaOverLimitText(periodSec: number = MARCIA_LIMIT_PERIOD_SEC): string {
  return `Marcia has made too many booking calls just now; try again within ${periodSec} seconds.`;
}

export interface GatewayAnswer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Marcia's overall limit, asked by Slate's gateway ONLY once the call's token has
 * verified (#3879). Null means go ahead; any answer is the refusal to return as it is.
 *
 * Why the limit is charged from inside Slate rather than here, before the call: this
 * Worker holds no key (locked decision 15), so all it can check is a token's SHAPE, and
 * anyone who can reach the hostname can make a shape valid token with a forged
 * signature. Charged here, sixty of those a minute refused every call Marcia made. The
 * other way out, a per source limit in front, cannot separate the two: Marcia's calls
 * may all leave OpenAI from one address, so a per source limit lower than her own budget
 * would throttle her, and one at or above it lets a single forging source spend the
 * whole shared limit; a caller can even send its calls through OpenAI's own connectors
 * and share her addresses. Only the verifier can tell her calls from a forger's, so the
 * gateway verifies and then calls this back over the service binding (a function passed
 * over Workers RPC is a stub the callee can call), and the binding, its namespace and its
 * fail closed handling all stay in this Worker.
 */
export type AdmitCall = () => Promise<GatewayAnswer | null>;

export interface ProtocolDeps {
  nowMs(): number;
  /**
   * `McpBookingGateway.booking` over the `SLATE` binding, handed `admit`, which Slate
   * calls only for a token it verified, and before anything runs.
   */
  booking(signedToken: string, operation: string, args: unknown, admit: AdmitCall): Promise<GatewayAnswer>;
  /** True when the call may go ahead under Marcia's overall limit. */
  withinLimit(): Promise<boolean>;
  logError(msg: string, fields: Record<string, string | number | boolean | null>): void;
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The lead token, read from the connection's `Authorization: Bearer` header. */
export function leadTokenOf(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") && h.length > 7 ? h.slice(7) : null;
}

function isRequest(v: unknown): v is JsonRpcRequest {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return r.jsonrpc === "2.0" && typeof r.method === "string";
}

/** A refusal of Marcia's overall limit, in the gateway's answer shape so it reads like Slate's own. */
const limitRefusal = (status: number, code: string, cls: "expected" | "unexpected", message: string): GatewayAnswer => ({
  status,
  body: { ok: false, code, class: cls, message },
});

/** A tool answer: the gateway's JSON as text, and an error flag a model can read. */
function toolResult(answer: GatewayAnswer) {
  const ok = answer.body.ok === true;
  return {
    content: [{ type: "text", text: JSON.stringify(answer.body) }],
    structuredContent: answer.body,
    isError: !ok,
  };
}

export async function handleMcp(request: Request, deps: ProtocolDeps): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("This endpoint answers MCP over POST only.", { status: 405, headers: { allow: "POST" } });
  }
  // The token comes first, for every method: an endpoint that lists its tools to a
  // caller with no lead is answering somebody Marcia did not send.
  const token = leadTokenOf(request);
  const shape = parseMachineTokenShape(token, deps.nowMs());
  if (!shape.ok) {
    return json(rpcError(null, -32001, describeTokenRefusal(shape.refusal)), 401, {
      "www-authenticate": `Bearer error="invalid_token", error_description="${shape.refusal.code}"`,
    });
  }
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return json(rpcError(null, -32700, "The body is not JSON."), 400);
  }
  if (Array.isArray(message)) return json(rpcError(null, -32600, "Batches are not supported."), 400);
  if (!isRequest(message)) return json(rpcError(null, -32600, "Not a JSON-RPC 2.0 request."), 400);
  // A notification carries no id and gets no answer.
  if (message.id === undefined) return new Response(null, { status: 202 });
  const id = message.id;

  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      const version = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
      return json(rpcResult(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO }));
    }
    case "ping":
      return json(rpcResult(id, {}));
    case "tools/list":
      return json(
        rpcResult(id, {
          tools: BOOKING_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        }),
      );
    case "tools/call": {
      const tool = bookingTool(message.params?.name);
      if (!tool) return json(rpcError(id, -32602, "No such tool."));
      // Called back by Slate once the token verified (`AdmitCall`, #3879). It never
      // throws: a limiter that cannot answer refuses, the same as one that says no, so
      // Marcia is never run unmetered and the caller gets an answer, not a bare 500.
      const admit: AdmitCall = async () => {
        let within: boolean;
        try {
          within = await deps.withinLimit();
        } catch {
          deps.logError("Marcia's overall limit could not be checked, so the call was refused", { tool: tool.name });
          return limitRefusal(503, "marcia_limit_unchecked", "unexpected", "Slate could not check Marcia's call limit just now. Try again in a minute.");
        }
        return within ? null : limitRefusal(429, "marcia_over_limit", "expected", marciaOverLimitText());
      };
      try {
        // `token` is the shape checked header value; Slate verifies it.
        const answer = await deps.booking(token as string, tool.name, message.params?.arguments ?? {}, admit);
        return json(rpcResult(id, toolResult(answer)));
      } catch {
        // Logged without the token, the arguments or the answer (L222).
        deps.logError("the Slate booking gateway could not be reached", { tool: tool.name });
        return json(
          rpcResult(id, {
            content: [{ type: "text", text: "Slate could not be reached just now. Try again in a minute." }],
            isError: true,
          }),
        );
      }
    }
    default:
      return json(rpcError(id, -32601, "Method not found."));
  }
}
