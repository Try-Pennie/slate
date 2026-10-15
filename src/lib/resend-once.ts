/**
 * Send a request once more when its connection dropped, and only once (#3566).
 *
 * A lead whose press never reached Slate used to see "something went wrong" and
 * have to press again. Dan, 2026-10-14: a lead should not see an error because
 * their connection dropped once. So the booker's confirm sends it again by itself,
 * after a short pause, and the load driver does the same so a run measures what a
 * lead meets. One rule for both, here, so the two cannot drift apart.
 *
 * Safe because a confirm collapses onto the first one by its idempotency key
 * (`stableKeyFor`, #2638): a resend of a press that DID reach Slate is answered
 * with the booking it made, never a second one.
 *
 * The caller decides what "dropped" means, because the two callers record a reply
 * differently, and each passes the pause so a test never waits on a real timer.
 * What is never resent: any answer at all (a refusal is an answer) and a request
 * the caller cut off at its own timeout, where the server may still be working and
 * the lead has already waited.
 */

/** How long to wait before the one resend: long enough for a blip to clear, too short to notice. */
export const RESEND_PAUSE_MS = 500;

export interface ResendOutcome<T> {
  /** The answer that stands: the first, or the resend's when the first dropped. */
  result: T;
  /** The first send's reply when it dropped and was resent, so a caller can report it; else null. */
  firstFailure: T | null;
}

/** The real pause, in its own export so a component test can replace it. */
export function pauseBeforeResend(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resendOnce<T>(
  send: () => Promise<T>,
  dropped: (reply: T) => boolean,
  pause: (ms: number) => Promise<void>,
): Promise<ResendOutcome<T>> {
  const first = await send();
  if (!dropped(first)) return { result: first, firstFailure: null };
  await pause(RESEND_PAUSE_MS);
  return { result: await send(), firstFailure: first };
}
