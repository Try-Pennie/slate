import { scrubContactData, withoutUrlQuery } from "@/lib/api/client-error-scrub";

/**
 * Tell the server a page's error boundary caught something (#1974).
 *
 * ## Why this exists
 *
 * The boundary already LOGS every catch, tagged, with the digest that ties a
 * screen somebody read to a line in the Worker's logs. That is the right
 * forensic trail and it is not a detector: nothing speaks. One stray error and a
 * deploy that broke a page for everybody arrive on the same path and look
 * identical, and the second is invisible for exactly as long as it lasts (L77).
 * Retention is seven days with no alerting on top, so past that there is nothing
 * at all.
 *
 * ## Why it reuses the beacon rather than adding a channel
 *
 * `/api/client-errors` already exists for the failure that removes the evidence
 * of itself, and it already scrubs contact data server side, rate limits by
 * address, fails closed, and throttles the alert it sends. A second path would
 * be a second set of all of those, and the one that got less attention would be
 * the public one.
 *
 * It also settles the open question the issue leads with, which was whether a
 * client `log.error` reaches Cloudflare at all. It does not need answering: this
 * does not depend on the browser's log line arriving anywhere, it depends on a
 * request, which either lands or does not.
 *
 * ## What it deliberately does not do
 *
 * It never throws and never rejects. It runs inside a screen that is already
 * showing somebody a failure, so a monitoring error surfacing there would be the
 * second thing to go wrong in front of them, and there is nowhere left to report
 * it to.
 */
export function reportBoundaryCatch(input: {
  /** The route the boundary is standing in for, not `window.location`, so a
   *  query string carrying an address or a token cannot travel with it. */
  page: string;
  /** Next's digest for the error, which is the only thing tying this to the log
   *  line. Absent when the framework did not mint one. */
  digest?: string;
  /** The error's own message, scrubbed. Absent on a server thrown error in
   *  production, where the framework has already redacted it. */
  message?: string;
}): void {
  try {
    const message = scrubContactData(
      (input.message ?? "").trim() || `boundary caught${input.digest ? "" : " an error with no digest"}`,
    ).slice(0, 500);
    // deadline-ok: runs in the browser (error boundaries are client components), not the Worker
    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // keepalive, because the commonest next thing a person does on this screen
      // is press the button that navigates away from it.
      keepalive: true,
      body: JSON.stringify({
        kind: "boundary",
        message,
        // #3046: cut any query string here as well, whatever a caller passes.
        page: withoutUrlQuery(input.page),
        source: input.digest ? `digest ${input.digest}` : null,
        line: null,
        col: null,
      }),
      // swallow-ok: the same reasoning as the beacon's own post. A rejected
      // report is an unhandled rejection, which is a thing this system reports,
      // which would post again. There is also nowhere to report it TO, since
      // reporting is what just failed, and the person is already looking at an
      // error screen.
    }).catch(() => {});
  } catch {
    // As above: a throw here would replace the error screen with a worse one.
  }
}
