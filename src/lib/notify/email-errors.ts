/**
 * What a failed Gmail send can prove about the message (2026-10-05 incident).
 *
 * A send can fail at four points, and they mean different things to a caller that
 * has to decide whether trying again could deliver a second copy:
 *
 *   compose  - the message was never built (no recipients, a MIME fault). Nothing
 *              left Slate.
 *   token    - the delegated token for the sender's mailbox could not be had. The
 *              token is minted BEFORE the Gmail POST, so nothing reached Gmail. The
 *              same holds after a first POST answered 401, because a 401 is refused
 *              at authentication and acts on nothing (`token-retry.ts` relies on it).
 *   post     - the POST itself: no answer, or an answer that is not a success.
 *   response - reserved for a success whose body could not be read. It does not
 *              throw today (the message was accepted), and is named so a later
 *              change that does throw has a stage that says delivery happened.
 *
 * The OUTCOME is the fact a caller acts on:
 *
 *   never_sent - nothing reached Gmail, so a retry cannot duplicate anything.
 *   refused    - Gmail answered and refused the message (400, 403, a second 401,
 *                429), so it was not delivered.
 *   unknown    - the request may have been accepted: no answer at all, or a 5xx,
 *                which Google can return after acting. A retry here is the one
 *                path that can deliver twice.
 *
 * `transient` says whether the same call could succeed if made again shortly (a
 * token deadline, a network fault, a 429 or 5xx), as opposed to needing a repair
 * (a refused delegation, a rejected address).
 *
 * The outcome is set by STAGE, never inferred from an error's class: a deadline
 * during the mint and a deadline during the POST are the same class of error and
 * opposite answers to "could this have been delivered".
 *
 * Pure, no imports, so node tests load it directly.
 */

export type EmailSendOutcome = "never_sent" | "refused" | "unknown";
export type EmailSendStage = "compose" | "token" | "post" | "response";

export class EmailSendError extends Error {
  readonly outcome: EmailSendOutcome;
  readonly stage: EmailSendStage;
  /** The HTTP status that decided it (the token endpoint's or Gmail's), or null. */
  readonly status: number | null;
  readonly transient: boolean;
  constructor(
    message: string,
    init: {
      outcome: EmailSendOutcome;
      stage: EmailSendStage;
      status?: number | null;
      transient: boolean;
      cause?: unknown;
    },
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "EmailSendError";
    this.outcome = init.outcome;
    this.stage = init.stage;
    this.status = init.status ?? null;
    this.transient = init.transient;
  }
}

/**
 * The error as an `EmailSendError`, or null.
 *
 * Checked by shape as well as by class, because a node test and the module under
 * test can load this file under two specifiers, and an `instanceof` across two
 * copies of one class answers false. A false here is not harmless: every caller
 * reads null as "nothing is known", which keeps the claim and costs the retry.
 */
export function asEmailSendError(err: unknown): EmailSendError | null {
  if (err instanceof EmailSendError) return err;
  if (typeof err !== "object" || err === null) return null;
  const e = err as Partial<EmailSendError>;
  if (e.name !== "EmailSendError") return null;
  if (e.outcome !== "never_sent" && e.outcome !== "refused" && e.outcome !== "unknown") return null;
  if (e.stage !== "compose" && e.stage !== "token" && e.stage !== "post" && e.stage !== "response") return null;
  if (typeof e.transient !== "boolean") return null;
  return err as EmailSendError;
}
