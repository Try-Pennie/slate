/**
 * Marcia's internal booking route, judged inside Next (#3543, plan phase 4.2).
 *
 * Reached ONLY by the `McpBookingGateway` entrypoint's in process inner Request
 * (`carrier.ts`); the public fetch handler refuses the path first. This route checks
 * everything itself anyway, so neither check leans on the other (L345):
 *
 *  1. the gateway secret, constant time, failing CLOSED when the deployment has
 *     none (an unconfigured deployment refuses everything, it never waves calls on);
 *  2. Marcia's signed lead token, by the one verifier (`machine-token.ts`), with the
 *     lead taken from it and from nothing else;
 *  3. the gateway's mark that Marcia's overall limit admitted the call (#3879), so a
 *     verified call the gateway did not charge is refused rather than run unmetered;
 *  4. then the operation, which never throws (`runMarciaOperation`).
 *
 * WHO MAY CALL: a holder of the gateway secret, which is only the Slate Worker
 * itself. WHOSE DATA: the one lead the verified token names.
 *
 * The route reads no cookie and no session: there is no person here, only Marcia.
 */
import { timingSafeEqual } from "@/lib/bearer-auth";
import { GATEWAY_SECRET_HEADER, LEAD_TOKEN_HEADER, LIMIT_ADMITTED_HEADER } from "./carrier.ts";
import { usableTokenKeys, verifyMachineToken } from "./machine-token.ts";
import { describeTokenRefusal, type MachineTokenRefusal, type MarciaLeadClaims } from "./token-shape.ts";
import type { MarciaAnswer, MarciaOperation } from "./operations.ts";

export interface MarciaRouteEnv {
  gatewaySecret: string | undefined;
  tokenKeySlots: readonly (string | undefined)[];
}

export interface MarciaRouteDeps {
  nowMs(): number;
  run(op: MarciaOperation, args: unknown, claims: MarciaLeadClaims): Promise<MarciaAnswer>;
  alertToken(refusal: MachineTokenRefusal): Promise<void>;
  alertGateway(why: "unconfigured" | "mismatch"): Promise<void>;
  logError(msg: string, fields: Record<string, string | number | boolean | null>): void;
}

/** The refusal body for anything that stops before an operation runs. */
function refusal(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, code, class: "unexpected", message, ...extra }, { status });
}

export async function handleMarciaInternal(req: Request, op: MarciaOperation, env: MarciaRouteEnv, deps: MarciaRouteDeps): Promise<Response> {
  const secret = (env.gatewaySecret ?? "").trim();
  if (!secret) {
    await deps.alertGateway("unconfigured").catch(() => undefined);
    return refusal(503, "gateway_unconfigured", "Slate cannot take Marcia's calls on this deployment yet.");
  }
  const presented = req.headers.get(GATEWAY_SECRET_HEADER) ?? "";
  if (!presented || !timingSafeEqual(presented, secret)) {
    await deps.alertGateway("mismatch").catch(() => undefined);
    // The same 404 an unknown path gets: a caller without the secret learns nothing.
    return new Response("Not found", { status: 404 });
  }

  const { keys, fixtureKeyConfigured } = usableTokenKeys(env.tokenKeySlots);
  if (fixtureKeyConfigured) {
    deps.logError("a token key slot holds the public fixture key, which is never a key", { operation: op });
  }
  const verified = await verifyMachineToken(req.headers.get(LEAD_TOKEN_HEADER), keys, deps.nowMs());
  if (!verified.ok) {
    await deps.alertToken(verified.refusal).catch(() => undefined);
    return refusal(401, verified.refusal.code, describeTokenRefusal(verified.refusal), {
      ...("claim" in verified.refusal ? { claim: verified.refusal.claim } : {}),
    });
  }
  // #3879: Marcia's overall limit is charged by the gateway for a token IT verified. A
  // token this route verified but the gateway did not charge means the two disagree
  // (their key reads, say), and the call would run unmetered: refuse it instead.
  if (req.headers.get(LIMIT_ADMITTED_HEADER) !== "1") {
    deps.logError("a verified Marcia call arrived without the gateway's limit mark, so it was refused", { operation: op });
    return refusal(503, "marcia_limit_unchecked", "Slate could not check Marcia's call limit just now. Try again in a minute.");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const args = typeof body === "object" && body !== null && "args" in body ? (body as { args: unknown }).args : undefined;
  const answer = await deps.run(op, args, verified.claims);
  return Response.json(answer, { status: answer.status });
}
