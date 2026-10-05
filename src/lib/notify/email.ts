import { getDelegatedToken, GMAIL_SEND_SCOPE } from "@/lib/google/dwd";
import { sendWithTokenRetry, TOKEN_REFUSED_STATUS } from "@/lib/google/token-retry";
import { buildMimeMessage, type MimeMessage } from "@/lib/notify/email-mime";
import { EmailSendError } from "@/lib/notify/email-errors";
import { GoogleHttpError } from "@/lib/google/http-error";
import { isDeadlineExceeded } from "@/lib/fetch-within-deadline";
import { log } from "@/lib/log";

/**
 * Send an email via the Gmail API, with the service account impersonating a
 * Workspace sender (domain-wide delegation, same as the calendar layer). The SA
 * needs the gmail.send scope granted in Workspace Admin; without it the token
 * mint or send 403s. Returns the Gmail message id.
 *
 * Every failure is thrown as an `EmailSendError` saying what it proves about
 * delivery (`email-errors.ts`), decided by the STAGE it happened at. The wrapping
 * lives here rather than in `sendWithTokenRetry`, because the calendar callers of
 * that helper branch on `instanceof GoogleHttpError` and must keep receiving one.
 */

function b64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A token failure, which delivered nothing unless a POST was still in flight.
 *
 * The message names the status and Google's machine reason only. The mint's own
 * error quotes the impersonated address and the token endpoint's body, which is
 * right for the log (it travels as the `cause`) and wrong for anything a page
 * carries. A missed deadline keeps the deadline's own sentence, so the short
 * reason formatter still finds it and says it in words.
 */
function tokenFailure(err: unknown, postInFlight: boolean): EmailSendError {
  const outcome = postInFlight ? "unknown" : "never_sent";
  if (err instanceof GoogleHttpError) {
    const transient = err.status === 429 || err.status >= 500;
    return new EmailSendError(
      `Gmail token unavailable: ${err.status}${err.reason ? ` ${err.reason}` : ""}`,
      { outcome, stage: "token", status: err.status, transient, cause: err },
    );
  }
  if (isDeadlineExceeded(err)) {
    return new EmailSendError((err as Error).message, { outcome, stage: "token", transient: true, cause: err });
  }
  // `fetch` rejects with a TypeError when the token endpoint cannot be reached at
  // all. Anything else (a key that will not import, a signing fault) is ours and
  // will fail the same way next time, so it is not transient.
  const transient = err instanceof TypeError;
  const detail = err instanceof Error ? err.message : String(err);
  return new EmailSendError(`Gmail token unavailable: ${detail}`, { outcome, stage: "token", transient, cause: err });
}

export async function sendGmailEmail(msg: MimeMessage): Promise<string> {
  let raw: string;
  try {
    if (msg.to.length === 0) {
      throw new Error("sendGmailEmail: no recipients");
    }
    // Distinctive boundary so it can't collide with body/attachment content.
    const boundary = `slate_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    raw = b64url(buildMimeMessage(msg, boundary));
  } catch (err) {
    throw new EmailSendError(err instanceof Error ? err.message : String(err), {
      outcome: "never_sent",
      stage: "compose",
      transient: false,
      cause: err,
    });
  }

  // On just before each POST, and off again when that POST is answered 401, which
  // Google refuses at authentication without acting on (`token-retry.ts`). A token
  // failure while it is off delivered nothing; one while it is on could follow a
  // POST nobody can vouch for, which no caller today produces and which would be
  // reported as unknown rather than guessed at.
  let postInFlight = false;

  // #3144: a cached token Gmail refuses is replaced and the same message resent
  // once; a second refusal falls through to the throw below.
  let res: Response;
  try {
    res = await sendWithTokenRetry(
      async (refused) => {
        try {
          return await getDelegatedToken(msg.from, GMAIL_SEND_SCOPE, undefined, refused);
        } catch (err) {
          throw tokenFailure(err, postInFlight);
        }
      },
      async (token) => {
        postInFlight = true;
        let answer: Response;
        try {
          answer = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(msg.from)}/messages/send`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ raw }),
            },
          );
        } catch (err) {
          // No answer at all: the request may have been accepted before the
          // connection dropped, so this cannot be called undelivered.
          throw new EmailSendError(`Gmail send failed: no response (${err instanceof Error ? err.message : String(err)})`, {
            outcome: "unknown",
            stage: "post",
            transient: true,
            cause: err,
          });
        }
        if (answer.status === TOKEN_REFUSED_STATUS) postInFlight = false;
        return answer;
      },
    );
  } catch (err) {
    if (err instanceof EmailSendError) throw err;
    // Nothing else reaches here today; a fault nobody predicted keeps the safe
    // reading, which is that it may have gone out.
    throw new EmailSendError(err instanceof Error ? err.message : String(err), {
      outcome: "unknown",
      stage: "post",
      transient: false,
      cause: err,
    });
  }

  if (!res.ok) {
    // swallow-ok: the body only decorates a failure that is thrown either way; one
    // that cannot be read must not replace the status with a read error.
    const body = await res.text().catch(() => "(body unreadable)");
    const status = res.status;
    // A 5xx can arrive after Google acted, so it proves nothing about delivery. A
    // 4xx is Gmail refusing the request, 401 here being the SECOND refusal after a
    // fresh token, and only 429 among them could succeed if sent again shortly.
    const outcome = status >= 400 && status < 500 ? "refused" : "unknown";
    const transient = status === 429 || status >= 500;
    throw new EmailSendError(`Gmail send failed: ${status} ${body}`, { outcome, stage: "post", status, transient });
  }

  // Accepted. A body that cannot be read changes nothing about that, so it is
  // logged and the send resolves: throwing would report a delivered message as
  // failed, and a caller that retried on it would send the second copy. The id is
  // then the empty string, which no caller reads; it is never invented.
  try {
    const data = (await res.json()) as { id?: unknown };
    if (typeof data?.id === "string" && data.id) return data.id;
    log.warn("gmail-send", { msg: "sent, and the reply carried no message id", status: res.status });
    return "";
  } catch (err) {
    log.warn("gmail-send", { msg: "sent, and the reply body could not be read", status: res.status }, err);
    return "";
  }
}
