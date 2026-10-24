import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { googleAccountMismatchAlert } from "@/lib/notify/misc-alert-copy";
import { log } from "@/lib/log";
import {
  GOOGLE_ACCOUNT_MISMATCH_COOLDOWN_MS,
  googleAccountMismatchAlertKey,
  type GoogleAccountMismatchError,
} from "@/lib/auth/google-identity";

/**
 * Tell Pennie that a sign in, or a live session, was refused as somebody other
 * than the person the Slate account belongs to (#3526).
 *
 * ONE reporter for both places the refusal happens: the sign in callback, and
 * `realCurrentUser` on every request (a session can reach a row without ever
 * passing the callback, by exchanging the sign in code directly). Both say the same
 * thing on the same key, so a takeover tried either way pages once an hour per
 * account, not once per request.
 *
 * Never throws: the refusal has already happened and stands whether or not Slack
 * heard about it, and the warning names the account either way.
 */
export async function reportGoogleAccountRefusal(
  err: GoogleAccountMismatchError,
  tag: string,
  authUserId: string,
): Promise<void> {
  log.warn(tag, {
    msg: "refused a different google account",
    auth_user_id: authUserId,
    user_id: err.userId,
    reason: err.reason,
  });
  try {
    // alert-key: sign_in_google_account_mismatch:*
    await sendThrottledAlert(
      googleAccountMismatchAlertKey(err.userId),
      GOOGLE_ACCOUNT_MISMATCH_COOLDOWN_MS,
      googleAccountMismatchAlert(err.email, err.reason),
    );
  } catch (alertErr) {
    log.error(tag, { msg: "different google account alert failed", user_id: err.userId }, alertErr);
  }
}
