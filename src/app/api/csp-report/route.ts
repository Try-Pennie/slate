import { NextResponse, type NextRequest } from "next/server";
import { log } from "@/lib/log";
import { allowRequest, clientIp, CSP_REPORT_RATE_RULES } from "@/lib/rate-limit";
import { CSP_REPORT_ADDRESS_POLICY } from "@/lib/rate-limit-core";
import { summariseViolation } from "@/lib/csp";

export const dynamic = "force-dynamic";

/**
 * Where a browser posts a Content Security Policy violation (#2565).
 *
 * The policy ships REPORT ONLY first, so for now a violation is information
 * rather than an incident: it says what an enforcing policy WOULD have broken.
 * That is the whole point of the phase, and it is why this writes a log line and
 * sends nothing to Slack. A public endpoint that could page would be a way for
 * anyone to wake somebody up, and a real finding here is read deliberately, by
 * querying `tag=csp-report`, not at 3am.
 *
 * WHO CAN CALL THIS: anyone. A browser posts a report with no credentials and no
 * way to add any, so there is no honest alternative.
 * WHAT DATA IT CAN TOUCH: nothing. No read and no write of any customer, agent or
 * org record. Its whole effect is a log line.
 *
 * Three deliberate refusals, the first two taken straight from the client error
 * beacon (#1368), which is the same shape of public unauthenticated beacon:
 *
 *  - It FAILS CLOSED on the rate limiter. Dropping one report costs a line in a
 *    log nobody is waiting on; an unmetered public path that writes costs more.
 *  - It returns 204 with NO BODY on every path, refusal included, so the response
 *    cannot be used as an oracle for what the server accepts.
 *  - It REDACTS before it logs. A report carries `document-uri`, `referrer` and
 *    `blocked-uri`, and on the manage page the URL is the booking's credential.
 *    #2564 took that token out of the warehouse; an endpoint the whole internet
 *    can post to must not walk it into the logs instead.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // 204 on every path: refusal and success are indistinguishable from outside.
  const done = () => new NextResponse(null, { status: 204 });

  const allowed = await allowRequest(
    { kind: "address", ip: clientIp(req.headers), policy: CSP_REPORT_ADDRESS_POLICY },
    CSP_REPORT_RATE_RULES,
  ).catch(() => false);
  if (!allowed) return done();

  const body = await req.json().catch(() => null);
  const violation = summariseViolation(body);
  // A body we could not read is not a violation of anything in particular, and
  // recording it as one would send somebody to fix a directive no browser named.
  if (violation.directive === "(unreadable)") return done();

  log.warn("csp-report", {
    msg: "policy violation (report only)",
    directive: violation.directive,
    blocked: violation.blocked,
    document: violation.document,
    referrer: violation.referrer,
  });
  return done();
}
