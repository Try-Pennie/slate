import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { authenticateBearer, CANARY_CALLERS } from "@/lib/booking/api-auth";
import { configuredBookingApiKeys } from "@/lib/booking/api-keys";
import { BURST_LIMITER_BINDING } from "@/lib/rate-limit-burst";
import {
  BURST_PROBE_REASON,
  BURST_VERIFY_KEY,
  readBurstCountReply,
} from "@/lib/monitor/burst-counter-probe";
import { shortErrorReason } from "@/lib/notify/error-text";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * The hand that reaches the burst counter for `pnpm verify:burst-counter` (#1564).
 *
 * A Durable Object is reachable only through a binding inside the Worker, so a command run from
 * a laptop cannot ask it anything directly. This endpoint is that one step: it reports ONE
 * request against a fixed monitor key and answers with the count the object now holds. Called
 * twice, a rising count proves the counter answers AND counts, which is the half the monitor
 * lane deliberately cannot prove (#1558: a presence read creates no object, spends no
 * subrequest, and leaves no alarm, at the cost of a bound-but-unreachable counter reading as
 * fine).
 *
 * WHO MAY CALL IT: the booking API Bearer key, the same key the smoke canary already holds, so
 * this needs no new secret. Fails CLOSED with 503 when no key is configured; 401 for a wrong or
 * missing one. Same contract as its siblings `/api/smoke/version` and `/api/smoke/heartbeat`.
 *
 * WHAT IT MAY TOUCH: exactly one key, `BURST_VERIFY_KEY`, which is a constant here and is never
 * taken from the request. That is a security property and not tidiness: a caller who could name
 * the key could report requests against a real lead's count and push them toward a ceiling, and
 * the thing at the far end of an inflated count is a lead being refused. There is no parameter
 * to add later without re-reading this comment.
 *
 * It writes nothing anybody else can see. The one object it creates holds a count for a key no
 * real caller's `burstKey` can produce, and the object's own alarm deletes it two windows after
 * the last report.
 *
 * Each way of learning nothing answers differently (L11): an unreadable context, an absent
 * binding, an object that did not answer, and an answer with no count are four different things
 * to go and do, and the command exits on a different code for each.
 */
interface DurableObjectishNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> };
}

export async function POST(req: NextRequest) {
  // #2645, #2854: the canary's own key only, never a partner's.
  const keys = configuredBookingApiKeys(CANARY_CALLERS);
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let env: Record<string, unknown> | null = null;
  try {
    env = getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch {
    env = null;
  }
  if (!env) {
    // Reported apart from a missing binding on purpose. Nothing looked for the counter here, so
    // saying it is absent would send the reader to a deploy that is not the problem. It is also
    // what a local dev server answers, which is worth being able to tell from production.
    return NextResponse.json({ reason: BURST_PROBE_REASON.contextUnreadable }, { status: 503 });
  }

  const ns = env[BURST_LIMITER_BINDING] as DurableObjectishNamespace | undefined;
  if (!ns) {
    return NextResponse.json({ reason: BURST_PROBE_REASON.bindingMissing }, { status: 503 });
  }

  let raw: unknown;
  try {
    const stub = ns.get(ns.idFromName(BURST_VERIFY_KEY));
    const res = await stub.fetch("https://burst-limiter.slate/count", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bump: 1 }),
    });
    if (!res.ok) {
      return NextResponse.json(
        {
          reason: BURST_PROBE_REASON.objectUnreachable,
          detail: `the counter answered ${res.status}`,
        },
        { status: 502 },
      );
    }
    raw = await res.json();
  } catch (err) {
    // The full error goes to the logs, where Cloudflare keeps it serialized; the reply carries a
    // short human reason, the same split every alert here makes (#1133).
    log.error("burst-counter-probe", { msg: "the burst counter did not answer" }, err);
    return NextResponse.json(
      { reason: BURST_PROBE_REASON.objectUnreachable, detail: shortErrorReason(err) },
      { status: 502 },
    );
  }

  const read = readBurstCountReply(raw);
  if (!read.ok) {
    log.error("burst-counter-probe", { msg: "the burst counter answered without a count" });
    return NextResponse.json(
      { reason: BURST_PROBE_REASON.noCount, detail: read.detail },
      { status: 502 },
    );
  }

  return NextResponse.json({
    reason: BURST_PROBE_REASON.counted,
    count: read.count,
    windowStartMs: read.windowStartMs,
    // Echoed so a reader of the output can see which key was reported without going to the
    // source. It is a constant, never anything the caller sent.
    key: BURST_VERIFY_KEY,
  });
}
