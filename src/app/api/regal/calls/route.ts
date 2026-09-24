import { NextResponse, after, type NextRequest } from "next/server";
import { regalInboundKey } from "@/lib/env";
import { bearerTokenMatches } from "@/lib/bearer-auth";
import { recordRegalCall } from "@/lib/regal/call-store";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * A `call.completed` body is about two kilobytes. Anything past this is not one,
 * and reading it into memory to find that out is work an authenticated but broken
 * sender should not be able to make the Worker do.
 */
const MAX_BODY_CHARS = 64 * 1024;

/**
 * Regal's reporting webhook (#2090): one POST per completed call.
 *
 * Auth is a static `Authorization: Bearer <REGAL_INBOUND_KEY>` header, set in
 * Regal under Settings > Integrations, verified through the one shared constant
 * time verifier. An unset secret is refused BY NAME with a 503, never read as
 * "accept everything", the shape `/api/users/bookable` uses.
 *
 * Regal gives each delivery FIVE SECONDS and does not retry: an event it has no
 * answer to is dropped with nothing anywhere recording that it happened. So the
 * reply never waits on the database. The body is parsed here (cheap, and it
 * decides the status) and the user lookup and the write run in `after()`, which
 * keeps the Worker alive until they settle. A bare floating promise is cut off
 * once the response is sent on the Cloudflare runtime (#191).
 *
 * Every authenticated post is recorded, the unreadable ones included, under the
 * one reason it was kept or dropped (`src/lib/regal/inbound-call.ts`), because a
 * feed whose bodies stopped being readable must count as broken rather than read
 * as a quiet day.
 */
export async function POST(req: NextRequest) {
  const key = regalInboundKey();
  if (!key) {
    return NextResponse.json(
      { error: "regal call feed not configured: REGAL_INBOUND_KEY is unset" },
      { status: 503 },
    );
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), key)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // A body that DECLARES itself oversized is refused before a byte of it is read,
  // so a broken sender cannot make the Worker buffer it. The declared length is
  // only a claim, so what arrives is measured again below: a missing header, or
  // one that lies, still cannot get a large body parsed.
  const declared = Number(req.headers.get("content-length") ?? "");
  const oversizedByHeader = Number.isFinite(declared) && declared > MAX_BODY_CHARS;
  const text = oversizedByHeader ? null : await req.text().catch(() => null);
  let body: unknown = null;
  let status = 200;
  if (oversizedByHeader) status = 413;
  else if (text === null) status = 400;
  else if (text.length > MAX_BODY_CHARS) status = 413;
  else {
    try {
      body = JSON.parse(text);
    } catch {
      // Refused without throwing: a 500 reads as retriable to most senders, and
      // this body will never parse however often it is sent.
      status = 400;
    }
  }

  // An unreadable body is recorded as `null`, which the classifier counts as
  // body_unreadable. The raw text is never kept: it carries the lead's details.
  const recordable = status === 200 ? body : null;
  after(async () => {
    try {
      const outcome = await recordRegalCall(recordable);
      // A redelivery is logged as a duplicate and nothing else: the stored row keeps
      // the first delivery's reason, so this delivery's classification is not news.
      if (outcome.status === "duplicate") {
        log.info("regal-calls", { msg: "duplicate", event_id: outcome.eventId });
      } else {
        log.info("regal-calls", { msg: "recorded", reason: outcome.reason });
      }
    } catch (err) {
      // Regal will not redeliver, so a lost write is lost: say so where somebody
      // looking for missing events will search.
      log.error("regal-calls", { msg: "could not record a received call event" }, err);
    }
  });

  if (status === 200) return NextResponse.json({ received: true });
  return NextResponse.json({ received: true, readable: false }, { status });
}
