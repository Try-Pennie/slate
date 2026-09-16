/**
 * What Slate records about a webhook subscriber's reply (#2418).
 *
 * The sender used to keep `${res.status} ${body.slice(0, 1000)}`, which went into
 * `webhook_deliveries.last_response` AND, verbatim, into the dead letter page. So
 * when a WAF or CDN in front of the subscriber blocked Slate's shared Workers
 * egress address and answered 403 with an HTML block page, the person on call read
 * a kilobyte of `<!DOCTYPE html>...` cut off mid tag. The Ray ID their firewall log
 * can be searched by was somewhere inside it or past the cut, and nothing in the
 * message said the subscriber's API had never seen the request.
 *
 * That last part is the whole reason this file exists. A 401 from the API itself
 * and a 403 from something standing in front of it read identically once both are
 * a status plus a blob, and they send two different people to do two different
 * things: one is our API key, the other is the partner's firewall allowing our
 * egress address. A message may claim only what its check measured (L11), so the
 * check is made here, on the reply, and the claim is made by the copy builder.
 *
 * Pure and dependency free, so it is node-testable
 * (scripts/test-webhook-dead-letter-copy.ts).
 */

/** How much of a readable API reply is kept on the delivery row. */
export const REPLY_BODY_LIMIT = 1000;

export interface WebhookReplySummary {
  /**
   * Stored on `webhook_deliveries.last_response`, and shortened by
   * `shortFailureReason` on its way into the alert.
   */
  lastResponse: string;
  /**
   * True when the reply came from something in FRONT of the subscriber's API, so
   * the request never reached them.
   */
  intermediary: boolean;
}

export interface WebhookReplyInput {
  status: number;
  /** The reply's `content-type` header, or null when it carried none. */
  contentType: string | null;
  /** The reply's `cf-ray` header, or null. The handle a partner searches by. */
  cfRay: string | null;
  /**
   * The reply body, or **null** when reading it threw. Null is not the empty
   * string: a 204 and a HEAD legitimately carry no body, and a body that could not
   * be read is a different fault with a different remedy.
   */
  body: string | null;
}

/** An HTML content type, however the sender spelled its charset. */
const HTML_TYPE = /\btext\/html\b/i;

/**
 * Classify a reply.
 *
 * The intermediary test is two signals, either of which is enough:
 *
 * - the `content-type` says `text/html`, which is the sender's own statement that
 *   it sent a page rather than an API answer; and
 * - the body starts with `<`, which catches the block pages served with no
 *   content type at all.
 *
 * Deliberately NOT a content check on anything else. A genuine API error that
 * happens to be JSON or plain text keeps its own text, because that text IS the
 * diagnosis and shortening it is `shortFailureReason`'s job, not this one's. The
 * known boundary: a subscriber whose API genuinely answered XML or SOAP would be
 * read as an intermediary. Slate's one live subscriber answers JSON, and a
 * narrower test would miss the block pages that carry no content type, which is
 * the case this exists for.
 */
export function summarizeWebhookReply(input: WebhookReplyInput): WebhookReplySummary {
  const { status, contentType, cfRay, body } = input;
  const ray = cfRay ? `, cf-ray ${cfRay}` : "";

  if (HTML_TYPE.test(contentType ?? "") || body?.trimStart().startsWith("<")) {
    return { lastResponse: `${status} intermediary HTML page${ray}`, intermediary: true };
  }
  // Each of the next two is its own sentence rather than a shared "no detail",
  // because a reply Slate could not read and a reply that carried nothing are
  // different facts about the subscriber, and one answering for the other is how a
  // reader is sent to look for something that is not there (L11, L520).
  if (body === null) {
    return { lastResponse: `${status} reply body could not be read${ray}`, intermediary: false };
  }
  if (body.trim() === "") {
    return { lastResponse: `${status} no reply body`, intermediary: false };
  }
  return { lastResponse: `${status} ${body.slice(0, REPLY_BODY_LIMIT)}`, intermediary: false };
}
