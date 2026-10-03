import { googleSaClientEmail, googleSaPrivateKey } from "@/lib/env";
import { GoogleHttpError } from "@/lib/google/http-error";
import { parseGoogleErrorReason } from "@/lib/google/reachability-classify";
import { DeadlineExceededError, NO_DEADLINE, isDeadlineExceeded, type Deadline } from "@/lib/fetch-within-deadline";
import { deadlineWithinBudget, fetchWithinBudget } from "@/lib/call-budget";
import { makeSharedInFlight } from "@/lib/concurrency";

/**
 * Google domain-wide delegation: mint an access token that impersonates a
 * Workspace user's calendar, using the service account — no per-agent OAuth.
 * RS256 JWT is signed with Web Crypto so this runs on the Cloudflare Worker.
 */

const SCOPE =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.readonly";
/** Send-only Gmail scope for the daily OOO-approvals digest (no read access). */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * The deadline on minting a token when the caller names none (#3102): the Gmail
 * digest and the directory photo lane. A calendar call passes its OWN deadline
 * instead, and the mint also waits no longer than the enclosing call budget has
 * left, so a mint on the confirm path is held to what the lead can wait.
 */
export const DELEGATED_TOKEN_TIMEOUT_MS = 8000;

// In-memory token cache per impersonated email (tokens last ~1h).
const cache = new Map<string, { token: string; exp: number }>();
// In flight mints per cache key (#3123). A failed mint is forgotten as it settles,
// so the next caller retries rather than inheriting the failure.
const mintShared = makeSharedInFlight<string, string>();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlString(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

function pemToPkcs8(pem: string): ArrayBuffer {
  // Keep only the base64 between the BEGIN/END markers — robust to stray quotes,
  // commas, or whitespace that may have been pasted around the key.
  const body = pem
    .replace(/^[\s\S]*-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----[\s\S]*$/, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function signJwt(subject: string, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlString(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlString(
    JSON.stringify({
      iss: googleSaClientEmail(),
      sub: subject,
      scope,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const input = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(googleSaPrivateKey()),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(sig)}`;
}

/**
 * Returns a delegated access token impersonating `email` (cached ~55 min).
 * Defaults to the calendar scopes; pass GMAIL_SEND_SCOPE for the digest mailer.
 * The cache is keyed by scope too, so calendar and Gmail tokens never collide.
 * A cached token answers at once; only a real mint can wait, up to `deadline`.
 */
export async function getDelegatedToken(
  email: string,
  scope: string = SCOPE,
  deadline: Deadline = DELEGATED_TOKEN_TIMEOUT_MS,
): Promise<string> {
  const cacheKey = `${scope}\n${email}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.exp - Date.now() > 60_000) return hit.token;

  // A burst for one identity shares one mint (#3123) rather than each request
  // signing a JWT and calling Google's token endpoint. The mint runs under the
  // deadline of the caller that started it, so each caller ALSO holds the shared
  // wait to its own deadline and budget: joining a mint never lets a call wait
  // longer than it would have waited for a mint of its own.
  const { waitMs, reportAs } = deadlineWithinBudget(deadline, "google token mint");
  const mint = () => mintToken(cacheKey, email, scope, deadline);
  let led = false;
  // The load runs synchronously up to its first await, so `led` is settled before
  // the next line reads it.
  const joined = mintShared(cacheKey, () => ((led = true), mint()));
  // A joined mint that ran out of the LEADER's time says nothing about ours: when
  // the leader's deadline was the shorter one, this caller mints again under its
  // own (shared, so any other waiting joiners share the second attempt too). Any
  // other failure would have been ours as well, so it is passed through.
  const shared = led
    ? joined
    : joined.catch((err: unknown) => {
        if (!isDeadlineExceeded(err)) throw err;
        return mintShared(cacheKey, mint);
      });
  if (waitMs === NO_DEADLINE || !Number.isFinite(waitMs)) return shared;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DeadlineExceededError(reportAs.label, reportAs.timeoutMs, reportAs.budget)),
      waitMs,
    );
  });
  try {
    return await Promise.race([shared, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function mintToken(
  cacheKey: string,
  email: string,
  scope: string,
  deadline: Deadline,
): Promise<string> {
  const assertion = await signJwt(email, scope);
  const res = await fetchWithinBudget(
    fetch,
    TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    },
    deadline,
    "google token mint",
  );
  if (!res.ok) {
    const text = await res.text();
    throw new GoogleHttpError(
      `Delegated token failed for ${email}: ${res.status} ${text}`,
      res.status,
      parseGoogleErrorReason(text),
    );
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cache.set(cacheKey, {
    token: data.access_token,
    exp: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}
