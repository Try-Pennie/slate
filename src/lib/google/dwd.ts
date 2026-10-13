import { googleSaClientEmail, googleSaPrivateKey } from "@/lib/env";
import { GoogleHttpError } from "@/lib/google/http-error";
import { parseGoogleErrorReason } from "@/lib/google/reachability-classify";
import { DeadlineExceededError, NO_DEADLINE, isDeadlineExceeded, type Deadline } from "@/lib/fetch-within-deadline";
import { deadlineWithinBudget, fetchWithinBudget, requestLabel } from "@/lib/call-budget";
import { makeSharedInFlight } from "@/lib/concurrency";
import { timedMint } from "@/lib/google/mint-log";

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
/** The name a mint's deadline and its errors carry. */
const MINT_LABEL = "google token mint";

/**
 * The deadline on minting a token when the caller names none (#3102). Every Gmail
 * send takes it: the 24 hour reminder email (`/api/cron/booking-reminders`) and
 * the OOO approvals digest (`/api/cron/ooo-approvals`), and so does the directory
 * photo lane (`src/lib/advisor-photos/google.ts`) and the smoke canary's event
 * cleanup (`scripts/lib/smoke-event-cleanup.ts`). A calendar call passes its OWN
 * deadline instead: `GOOGLE_CONFIRM_TIMEOUT_MS` on the confirm path and for the
 * reminder lane's invite rewrite, `CALENDAR_WRITE_TIMEOUT_MS` for the OOO writes
 * and the reminder lane's invite read, `GOOGLE_SYNC_TIMEOUT_MS` (15 seconds) on
 * the sync lanes; the first two are 8 seconds as well. The mint also waits no
 * longer than the enclosing call budget has left, so a mint on the confirm path
 * is held to what the lead can wait.
 *
 * 8 seconds was borrowed from the lead facing call budget, not measured, and two
 * mints have run out of it (#3298). Every mint now logs its duration
 * (`mint-log.ts`); size this from that reading, not from this comment.
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
 *
 * `refused` is a token Google just answered 401 to (#3144, via
 * `sendWithTokenRetry`). It is dropped from the cache only while it is still the
 * one held, so a caller reporting it late gets the replacement another caller
 * already minted rather than forcing another mint.
 */
export async function getDelegatedToken(
  email: string,
  scope: string = SCOPE,
  deadline: Deadline = DELEGATED_TOKEN_TIMEOUT_MS,
  refused?: string,
): Promise<string> {
  const cacheKey = `${scope}\n${email}`;
  if (refused !== undefined && cache.get(cacheKey)?.token === refused) cache.delete(cacheKey);
  const hit = cache.get(cacheKey);
  if (hit && hit.exp - Date.now() > 60_000) return hit.token;

  // A burst for one identity shares one mint (#3123) rather than each request
  // signing a JWT and calling Google's token endpoint. The mint runs under the
  // deadline of the caller that started it, so each caller ALSO holds the shared
  // wait to its own deadline and budget: joining a mint never lets a call wait
  // longer than it would have waited for a mint of its own.
  const { waitMs, reportAs } = deadlineWithinBudget(deadline, MINT_LABEL);
  // Each real mint writes one timing line (#3298); a cache hit and a joiner write
  // none. What it was allowed is read as it starts, in the minting caller's own
  // context, so a joiner's second attempt reports its own budget, not the leader's.
  const mint = () =>
    timedMint(() => mintToken(cacheKey, email, scope, deadline), {
      scope,
      deadlineMs: deadline,
      limitMs: mintLimit(deadline),
      request: requestLabel(),
    });
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

/** What a mint starting now may wait: 0 when the budget is already spent, as the
 *  mint's own request is then refused before it is sent. */
function mintLimit(deadline: Deadline): Deadline {
  try {
    return deadlineWithinBudget(deadline, MINT_LABEL).waitMs;
  } catch (err) {
    if (isDeadlineExceeded(err)) return 0;
    throw err;
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
    MINT_LABEL,
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
