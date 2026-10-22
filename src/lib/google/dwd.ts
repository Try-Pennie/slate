import { googleSaClientEmail, googleSaPrivateKey } from "@/lib/env";
import { GoogleHttpError } from "@/lib/google/http-error";
import { parseGoogleErrorReason } from "@/lib/google/reachability-classify";
import { DeadlineExceededError, NO_DEADLINE, isDeadlineExceeded, type Deadline } from "@/lib/fetch-within-deadline";
import { deadlineWithinBudget, fetchWithinBudget, requestLabel } from "@/lib/call-budget";
import { makeSharedInFlight } from "@/lib/concurrency";
import { timedMint, writeTokenReadLine } from "@/lib/google/mint-log";
import { log } from "@/lib/log";
import { TOKEN_HOLDER_BACKGROUND_MS, TOKEN_HOLDER_READ_MS, type HolderRead } from "@/lib/google/token-holder";
import { TOKEN_REFRESH_AHEAD_MS, TOKEN_REFRESH_CLAIM_MS, TOKEN_USABLE_MARGIN_MS } from "@/lib/google/token-holder-object";
import { tokenHolder, tokenHolderBackground } from "@/lib/google/token-holder-live";

/**
 * Google domain-wide delegation: mint an access token that impersonates a
 * Workspace user's calendar, using the service account — no per-agent OAuth.
 * RS256 JWT is signed with Web Crypto so this runs on the Cloudflare Worker.
 *
 * A token is read from three tiers, in order (#3512): this isolate's own cache, the
 * shared token holder (one Durable Object every isolate asks, `token-holder-object.ts`),
 * and only then a mint. The holder answers in milliseconds where a mint is a JWT signature
 * and a round trip to Google's token endpoint, which stalled for seconds on 2026-10-14
 * and failed a lead's confirm. The holder never mints and never holds the key: whoever
 * mints puts the token there, and a token near expiry is refreshed by one reader after
 * its response. A holder that is slow, failing or absent costs at most
 * `TOKEN_HOLDER_READ_MS`, and then the caller mints exactly as it always has.
 */

export const CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.readonly";
const SCOPE = CALENDAR_SCOPE;

/**
 * The scopes the shared holder keeps: the calendar's, and only that (#3512). The calendar
 * token is the one on the lead's path and the one minted about 19,000 times a day by the
 * sync lanes. A Gmail send token is minted for one or two sender addresses and a directory
 * token for one admin, each a handful of times an hour off any lead's path, so holding them
 * would save almost nothing, while they are the two most powerful tokens Slate mints (send
 * mail as an address; read the whole directory). The holder's trust boundary would not
 * widen for them either, but it holds what it exists for and no more, and those two keep
 * their behaviour exactly as before.
 */
const HELD_SCOPES: ReadonlySet<string> = new Set([CALENDAR_SCOPE]);
const HOLDER_LABEL = "google token holder";
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
 * cleanup (`scripts/lib/smoke-event-cleanup.ts`), and the mint made after a
 * response to refresh an ageing token (`backgroundMint`). A calendar call passes
 * its OWN deadline instead: `GOOGLE_CONFIRM_TIMEOUT_MS` on the confirm path and
 * for the reminder lane's invite rewrite, `CALENDAR_WRITE_TIMEOUT_MS` for the OOO
 * writes and the reminder lane's invite read, `GOOGLE_SYNC_TIMEOUT_MS` (15
 * seconds) on the sync lanes; the first two are 8 seconds as well. The mint also
 * waits no longer than the enclosing call budget has left, so a mint on the
 * confirm path is held to what the lead can wait.
 *
 * Measured, and kept (#3298, #3980): every mint logged from 2026-10-15 15:00 to
 * 2026-10-22 15:00 UTC, seven full days after the shared holder (#3512) took most
 * mints off the confirm path (an earlier six day reading agreed). No 8 second mint
 * timed out on any lane:
 *   - a lead's confirm (`request="the booking confirm"`, new bookings and
 *     reschedules): 302 mints, median 132ms, slowest 338ms, and only 3.0% of its
 *     9,745 token reads needed a mint at all (79.5% the isolate, 17.5% the holder);
 *   - the other calendar calls (`google freeBusy.many`, `events.get`, insert,
 *     delete: the cron drains and the monitor lane, NOT the confirm, whose calls
 *     all carry the confirm's label): 1,262 mints, slowest 3.3s;
 *   - 2,977 Gmail mints, slowest 6.5s; 2,997 after response refreshes, slowest
 *     6.7s (four started together).
 * The 15 second sync lanes had 22 of 148,846 over 8s and one timeout, in bursts
 * of several in one minute, so that tail follows how many mints run at once (the
 * holder misses of #3979) more than Google's own speed. Nobody waits on any of
 * these: a missed sync mint heals on the next minute's run, and a reminder email
 * that fails is retried on the next. A shorter limit on the confirm cannot help a
 * lead either, since a cut mint fails the confirm.
 *
 * Across that week every lane but the confirm's got slower in its tail (sync p99
 * 218ms on the first day, 1.8s on the last; Gmail 287ms to 1.9s), still far
 * inside its limit. Re-measure before changing either number: list
 * `tag=google-token-mint` lines one hour at a time (`scripts/logs.ts --lines`),
 * weight each by its `weight=` (Cloudflare samples busy hours), and group by
 * `request` and `deadline_ms`; one window across several days, not on day
 * boundaries, counted 12% more lines than its own hours did.
 */
export const DELEGATED_TOKEN_TIMEOUT_MS = 8000;

// In-memory token cache per impersonated email (tokens last ~1h).
const cache = new Map<string, { token: string; exp: number }>();
// In flight mints per cache key (#3123). A failed mint is forgotten as it settles,
// so the next caller retries rather than inheriting the failure.
const mintShared = makeSharedInFlight<string, string>();
// In flight holder reads per cache key (#3512): a burst for one advisor on one isolate
// asks the holder once. A read never rejects, so nothing failed is ever shared on.
const holderShared = makeSharedInFlight<string, HolderRead>();
// When this isolate may next ask the holder about an ageing token it holds itself, per
// cache key, so a token read on every call in its last minutes asks once a minute.
const nudgeAfter = new Map<string, number>();

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
 * already minted rather than forcing another mint. It also skips the shared holder
 * (#3512), which may still be holding that very token; the fresh mint, expiring later,
 * replaces it there.
 */
export async function getDelegatedToken(
  email: string,
  scope: string = SCOPE,
  deadline: Deadline = DELEGATED_TOKEN_TIMEOUT_MS,
  refused?: string,
): Promise<string> {
  const cacheKey = `${scope}\n${email}`;
  if (refused !== undefined && cache.get(cacheKey)?.token === refused) cache.delete(cacheKey);
  const startedAt = Date.now();
  const held = HELD_SCOPES.has(scope);

  // Tier 1: this isolate's own cache.
  const hit = cache.get(cacheKey);
  if (hit && hit.exp - startedAt > TOKEN_USABLE_MARGIN_MS) {
    if (held && refused === undefined) nudgeIfAgeing(cacheKey, email, scope, hit.exp, startedAt);
    const request = requestLabel();
    if (request !== undefined) writeTokenReadLine({ tier: "isolate", scope, ms: 0, request });
    return hit.token;
  }

  // Tier 2: the shared holder, within its own small deadline. Anything but a hit (a
  // miss, a timeout, an error, no binding) is answered by tier 3, exactly as before.
  let holder: string;
  if (!held) holder = "not-held";
  else if (refused !== undefined) holder = "refused";
  else {
    const read = await readHolder(cacheKey, deadline);
    if (read.kind === "hit") {
      remember(cacheKey, read.token, read.expMs);
      if (read.refresh) refreshAfterResponse(cacheKey, email, scope, "refresh");
      writeTokenReadLine({ tier: "holder", scope, ms: Date.now() - startedAt, request: requestLabel() });
      return read.token;
    }
    holder = read.kind;
  }

  // Tier 3: a mint.
  const token = await mintForCaller(cacheKey, email, scope, deadline, holder);
  writeTokenReadLine({ tier: "mint", scope, ms: Date.now() - startedAt, holder, request: requestLabel() });
  return token;
}

/** Keep a token in this isolate unless it already holds one expiring later. */
function remember(cacheKey: string, token: string, exp: number): void {
  const current = cache.get(cacheKey);
  if (current && current.exp >= exp && current.token !== token) return;
  cache.set(cacheKey, { token, exp });
}

/**
 * Ask the shared holder for a token, never longer than `TOKEN_HOLDER_READ_MS`, nor than
 * the caller's own deadline, nor than what the enclosing budget has left. A burst for one
 * advisor on this isolate shares one read. Never rejects: a holder that cannot answer is
 * logged here, once per read, and the caller mints.
 */
async function readHolder(cacheKey: string, deadline: Deadline): Promise<HolderRead | { kind: "no-budget" }> {
  const client = tokenHolder();
  if (!client) return { kind: "unbound" };
  const own = typeof deadline === "number" ? Math.min(TOKEN_HOLDER_READ_MS, deadline) : TOKEN_HOLDER_READ_MS;
  let waitMs: number;
  try {
    waitMs = deadlineWithinBudget(own, HOLDER_LABEL).waitMs;
  } catch (err) {
    // The budget is already spent: the mint that follows refuses with the budget's own
    // error, exactly as it did before the holder existed.
    if (isDeadlineExceeded(err)) return { kind: "no-budget" };
    throw err;
  }
  return holderShared(cacheKey, async () => {
    const read = await client.read(cacheKey, waitMs);
    const msg = "holder did not answer; minting instead";
    if (read.kind === "timeout") log.warn("google-token-holder", { msg, outcome: "timeout", waited_ms: read.waitedMs });
    else if (read.kind === "error") log.warn("google-token-holder", { msg, outcome: "error", reason: read.reason });
    else if (read.kind === "expired") log.warn("google-token-holder", { msg, outcome: "expired" });
    return read;
  });
}

/**
 * Mint after the response, off whatever path asked, to replace an ageing token (#3512).
 * Shares any mint already in flight for the key on this isolate. Held to the default mint
 * deadline and outside every call budget (`afterResponse`), and the new token is put into
 * the holder by `mintToken` like any other. A failure is logged by its mint line and by
 * the background job; the token it was replacing goes on being served while it is usable,
 * and the holder offers the refresh to another reader once this one's claim lapses.
 */
function refreshAfterResponse(cacheKey: string, email: string, scope: string, why: "refresh" | "nudge"): void {
  tokenHolderBackground("google-token-refresh", () => mintShared(cacheKey, () => backgroundMint(cacheKey, email, scope, why)));
}

function backgroundMint(cacheKey: string, email: string, scope: string, why: "refresh" | "nudge"): Promise<string> {
  return timedMint(() => mintToken(cacheKey, email, scope, DELEGATED_TOKEN_TIMEOUT_MS), {
    scope,
    deadlineMs: DELEGATED_TOKEN_TIMEOUT_MS,
    limitMs: DELEGATED_TOKEN_TIMEOUT_MS,
    holder: why,
  });
}

/**
 * This isolate holds a token inside its last `TOKEN_REFRESH_AHEAD_MS`. It is still served
 * from here, and after the response the holder is asked, at most once a minute per key:
 * a newer token it already has is adopted, and when it hands this reader the refresh
 * claim (or has lost its memory) the token is minted afresh. Without this an isolate that
 * keeps answering from its own copy would never tell the holder its token was ageing.
 */
function nudgeIfAgeing(cacheKey: string, email: string, scope: string, exp: number, now: number): void {
  if (exp - now > TOKEN_REFRESH_AHEAD_MS) return;
  if ((nudgeAfter.get(cacheKey) ?? 0) > now) return;
  const client = tokenHolder();
  if (!client) return;
  nudgeAfter.set(cacheKey, now + TOKEN_REFRESH_CLAIM_MS);
  tokenHolderBackground("google-token-nudge", async () => {
    const read = await client.read(cacheKey, TOKEN_HOLDER_BACKGROUND_MS);
    if (read.kind === "hit") {
      if (read.expMs > exp) remember(cacheKey, read.token, read.expMs);
      if (!read.refresh) return;
    } else if (read.kind !== "miss" && read.kind !== "expired") {
      throw new Error(`the holder did not answer an ageing token's check (${read.kind})`);
    }
    await mintShared(cacheKey, () => backgroundMint(cacheKey, email, scope, "nudge"));
  });
}

/**
 * The mint itself, for a caller waiting on it. Unchanged by the holder (#3512) apart from
 * the `holder` field its timing line carries: why the holder did not answer instead.
 */
async function mintForCaller(cacheKey: string, email: string, scope: string, deadline: Deadline, holder: string): Promise<string> {
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
      holder,
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
  const exp = Date.now() + data.expires_in * 1000;
  cache.set(cacheKey, { token: data.access_token, exp });
  if (HELD_SCOPES.has(scope)) putAfterResponse(cacheKey, data.access_token, exp);
  return data.access_token;
}

/**
 * Hand a freshly minted token to the shared holder (#3512), after the response so it
 * never delays the caller. A put that fails is logged by the background job and costs
 * only a later mint somewhere else, which is what every read cost before the holder.
 */
function putAfterResponse(cacheKey: string, token: string, exp: number): void {
  const client = tokenHolder();
  if (!client) return;
  tokenHolderBackground("google-token-holder-put", () => client.put(cacheKey, token, exp));
}
