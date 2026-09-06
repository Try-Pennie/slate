import { unstable_isUnrecognizedActionError } from "next/navigation";

/**
 * Whether a failed save failed because the page is older than the deployment
 * serving it (#1994).
 *
 * ## The failure
 *
 * A browser submitting a server action names it by an id minted at BUILD time.
 * A deploy lands under a page somebody already has open, that name no longer
 * exists, and Next replies 404 with `x-nextjs-action-not-found`
 * (`handleUnrecognizedFetchAction`). The client turns that into an
 * `UnrecognizedActionError`, and a `<form action={serverAction}>` with nothing
 * catching it sends it straight to the error boundary, which says it cannot tell
 * what happened. Dan hit it twice in one morning, both times 60 seconds to five
 * minutes after a deploy.
 *
 * It is entirely a staff problem: the lead facing booker goes through the API.
 * It matters now because the parallel run is asking 121 agents to set their real
 * working hours on exactly these pages, on a page a person leaves open while
 * they think, and we deploy several times an hour.
 *
 * ## Why this is its own module
 *
 * `unstable_isUnrecognizedActionError` is unstable by name and can go or change
 * between Next versions. If it did, the recovery would quietly stop working and
 * the crash screen would come back, with nothing failing in between: the
 * predicate would simply answer `false` forever and every stale save would look
 * like an ordinary error again.
 *
 * So it is imported in ONE place and pinned by `scripts/test-stale-action.ts`,
 * which asserts the export still exists on the installed Next. That test fails on
 * an upgrade that removes it, which is the whole point of keeping the import
 * here rather than at each call site.
 */
export function isStaleActionError(err: unknown): boolean {
  return unstable_isUnrecognizedActionError(err);
}

/**
 * What the person is told, and it is deliberately three facts rather than an
 * apology.
 *
 * The error boundary's own sentence was "this page did not finish loading, and
 * this screen cannot tell whether it did", which is honest and useless: it
 * cannot separate a click that never reached the server from a week the server
 * refused, and those need opposite responses. This one is only ever shown when
 * the cause is known exactly.
 *
 * It says NOTHING WAS SAVED, because that is the fact the person needs and it is
 * certain: the request never reached Slate's own code, which is why no audit row
 * was written for either of Dan's two crashes.
 */
export const STALE_ACTION_NOTICE =
  "Slate updated while this page was open, so nothing was saved. Reload the page and press save again. What you typed is kept.";

/** The heading above it, on a surface that has room for one. */
export const STALE_ACTION_TITLE = "Slate updated while this page was open";
