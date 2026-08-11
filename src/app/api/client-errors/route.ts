import { NextResponse, type NextRequest } from "next/server";
import { reportInternalError } from "@/lib/api/errors";
import { allowRequest, clientIp, CLIENT_ERROR_RATE_RULES } from "@/lib/rate-limit";
import {
  normalizeClientError,
  clientErrorSignature,
} from "@/lib/api/client-error-scrub";

export const dynamic = "force-dynamic";

/**
 * The client error beacon (#1368).
 *
 * A broken client bundle loses bookings SILENTLY. Every other detector Slate has
 * is downstream of a request the browser managed to send: the booking failure
 * rate (#1313) counts attempts that REACHED the server, so a bundle that throws
 * before submit produces no attempt at all and the share it measures stays
 * perfectly healthy while nobody can book. The smoke canary exercises the
 * booking API, not the bundle. This is the one failure that removes all the
 * evidence of itself, which is why it needs its own channel.
 *
 * WHO CAN CALL THIS: anyone. It is reachable by whoever can load the booker,
 * which is the whole internet, and there is no honest way around that (a page
 * that is failing to run its own JavaScript cannot be relied on to authenticate).
 * WHAT DATA IT CAN TOUCH: nothing. It performs no read and no write of any
 * customer, agent or org record. Its entire effect is a log line and a throttled
 * alert.
 *
 * Given that, three deliberate refusals:
 *
 *  - It FAILS CLOSED on the rate limiter, unlike the booking paths which fail
 *    open. There, a limiter hiccup blocking a real booking is the worse outcome.
 *    Here it is the reverse: dropping a beacon report costs a log line, while
 *    letting an unmetered public path to Slack stay open costs the pager.
 *  - It returns 204 with NO BODY, ever, on every path including refusal. A
 *    response that varied would make it an oracle for what the server accepts.
 *  - It accepts nothing unbounded and re-scrubs contact data server side, since
 *    the page having scrubbed already says nothing about what a forged or stale
 *    client sends.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // 204 on every path: refusal and success are indistinguishable from outside.
  const done = () => new NextResponse(null, { status: 204 });

  // Fail CLOSED: a limiter that cannot vouch for this caller means the report is
  // dropped, not forwarded. Everything below this line can cause a Slack message.
  const allowed = await allowRequest(clientIp(req.headers), CLIENT_ERROR_RATE_RULES).catch(
    () => false,
  );
  if (!allowed) return done();

  const body = await req.json().catch(() => null);
  const report = normalizeClientError(body);
  if (!report) return done();

  // The alert carries a short, bounded reason; the full report goes to the log,
  // which Cloudflare keeps complete (#1133: the alert is read on a phone, the
  // detail belongs where there is room for it).
  const where = [report.source, report.line, report.col].filter((p) => p !== null).join(":");
  const err = new Error(
    `${report.kind} on ${report.page}: ${report.message}${where ? ` (${where})` : ""}`,
  );
  err.stack = report.stack ?? undefined;

  await reportInternalError(err, clientErrorSignature(report));
  return done();
}
