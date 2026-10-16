/**
 * A page raised after a booking has committed, sent past the lead's answer when a
 * lead is waiting for one (#3266).
 *
 * The booking exists by the time these run, so nothing in the answer reads them,
 * and awaiting them inside the confirm's budget only cost the lead: a slow Slack or
 * alert_state write held the answer of a booking that was already made, and once the
 * budget was spent the page itself was refused ("slack did not answer within 0ms",
 * 2026-10-04 21:31 UTC). Handed to the work that runs after the response, the page
 * runs outside every call budget (`afterResponse`, #3232), so it neither waits on
 * the lead nor dies with their budget.
 *
 * Why after the response rather than under the owed cleanup allowance
 * (`withinOwedCleanup`): the allowance would make the page sendable again, but the
 * lead would still wait for it, up to the two seconds the allowance holds, for a
 * message nothing in their answer reads. The allowance is for work a request OWES
 * before it may answer (a lease handed back, an event rolled back); a page is not.
 *
 * The scheduler is passed only on a lead's request. The cron drains carry no budget
 * and nobody waiting, and #503 keeps their work inline so the shared minute
 * invocation is not held open past its own answer, so there the page is awaited as
 * it always was.
 *
 * `send` must settle rather than reject: every caller ends its send in
 * `.catch(logAlertSendFailure(key))`, which records a failed page as an error by
 * its key (#3098). `afterResponse` logs anything that still escapes, at warn.
 *
 * Imports nothing, so the node tested booking orchestration can use it as well as
 * the live wiring.
 */
export type PageScheduler = (context: string, send: () => Promise<unknown>) => void;

export async function pageAfterAnswer(
  defer: PageScheduler | undefined,
  context: string,
  send: () => Promise<void>,
): Promise<void> {
  if (defer) {
    defer(context, send);
    return;
  }
  await send();
}
