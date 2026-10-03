import { NextResponse, after, type NextRequest } from "next/server";
import { refuseCredential } from "@/lib/bearer-failure";
import { regalInboundKey, regalInboundKey2 } from "@/lib/env";
import { bearerTokenMatches } from "@/lib/bearer-auth";
import { recordRegalCall } from "@/lib/regal/call-store";
import { log } from "@/lib/log";
import { readJsonCapped } from "@/lib/http/read-json-capped";

export const dynamic = "force-dynamic";

/**
 * A `call.completed` body is about two kilobytes. Anything past this is not one,
 * and reading it into memory to find that out is work an authenticated but broken
 * sender should not be able to make the Worker do.
 */
const MAX_BODY_BYTES = 64 * 1024;

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
  if (!bearerTokenMatches(req.headers.get("authorization"), [key, regalInboundKey2()])) {
    return refuseCredential(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }

  // Read under the shared capped reader (#3135): a body that DECLARES itself
  // oversized is refused before a byte of it is read, and since the declared length
  // is only a claim, what arrives is counted as it streams and the read stops at
  // the cap. An unreadable body is refused 400 without throwing: a 500 reads as
  // retriable to most senders, and this body will never parse however often it is
  // sent.
  const read = await readJsonCapped(req, MAX_BODY_BYTES);
  const body: unknown = read.tooLarge ? null : read.value;
  const status = read.tooLarge ? 413 : body === null ? 400 : 200;

  // An unreadable body is recorded as `null`, which the classifier counts as
  // body_unreadable. The raw text is never kept: it carries the lead's details.
  const recordable = status === 200 ? body : null;
  // Two rows per body (#2944): the detector's per reason row and the call outcome
  // row, each settled in its own boundary so one failing never loses the other,
  // and each logged on its own tag so a missing outcome is searched for where it
  // was lost.
  after(async () => {
    try {
      const { detector, outcome } = await recordRegalCall(recordable);
      if (detector.ok) {
        // A redelivery is logged as a duplicate and nothing else: the stored row
        // keeps the first delivery's reason, so this delivery's classification is
        // not news.
        if (detector.value.status === "duplicate") {
          log.info("regal-calls", { msg: "duplicate", event_id: detector.value.eventId });
        } else {
          log.info("regal-calls", { msg: "recorded", reason: detector.value.reason });
        }
      } else {
        // Regal will not redeliver, so a lost write is lost: say so where somebody
        // looking for missing events will search.
        log.error("regal-calls", { msg: "could not record a received call event" }, detector.error);
      }
      if (outcome.ok) {
        const o = outcome.value;
        if (o.status === "refused") {
          // A non call event is the ordinary refusal; every other one means a call
          // the show rate will not see, so it is a warning a reader can count.
          const fields = { msg: "refused", reason: o.reason, event_id: o.eventId };
          if (o.reason === "not_call_completed") log.info("regal-call-outcomes", fields);
          else log.warn("regal-call-outcomes", fields);
        } else {
          log.info("regal-call-outcomes", { msg: o.status, event_id: o.eventId });
        }
      } else {
        log.error("regal-call-outcomes", { msg: "could not store a call outcome" }, outcome.error);
      }
    } catch (err) {
      log.error("regal-calls", { msg: "could not record a received call event" }, err);
    }
  });

  if (status === 200) return NextResponse.json({ received: true });
  return NextResponse.json({ received: true, readable: false }, { status });
}
