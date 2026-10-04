import { getDelegatedToken, GMAIL_SEND_SCOPE } from "@/lib/google/dwd";
import { sendWithTokenRetry } from "@/lib/google/token-retry";
import { buildMimeMessage, type MimeMessage } from "@/lib/notify/email-mime";

/**
 * Send an email via the Gmail API, with the service account impersonating a
 * Workspace sender (domain-wide delegation, same as the calendar layer). The SA
 * needs the gmail.send scope granted in Workspace Admin; without it the token
 * mint or send 403s. Returns the Gmail message id.
 */

function b64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendGmailEmail(msg: MimeMessage): Promise<string> {
  if (msg.to.length === 0) {
    throw new Error("sendGmailEmail: no recipients");
  }
  // Distinctive boundary so it can't collide with body/attachment content.
  const boundary = `slate_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const raw = b64url(buildMimeMessage(msg, boundary));

  // #3144: a cached token Gmail refuses is replaced and the same message resent
  // once; a second refusal falls through to the throw below.
  const res = await sendWithTokenRetry(
    (refused) => getDelegatedToken(msg.from, GMAIL_SEND_SCOPE, undefined, refused),
    (token) =>
      fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(msg.from)}/messages/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw }),
      }),
  );
  if (!res.ok) {
    throw new Error(`Gmail send failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}
