/**
 * Snowflake SQL REST API client for the archival mirror export lane (#1097).
 *
 * Ported near-verbatim from the proven Bidspoke exporter
 * (apps/worker/src/lib/snowflake.ts). Auth is a key-pair JWT (RS256): the
 * SLATE_SERVICE user carries the RSA public key in Snowflake; the matching
 * private key lives only in the SNOWFLAKE_PRIVATE_KEY Worker secret. See
 * docs/snowflake-setup.md.
 *
 * Two deliberate correctness properties carried over from Bidspoke:
 *   - A 202 (statement still running) is NEVER treated as success. It is polled
 *     to a terminal state, so the caller only advances an export watermark after
 *     a confirmed terminal response.
 *   - Retries resubmit the SAME requestId with retry=true, Snowflake's
 *     idempotency contract, so a request that died before we saw its response is
 *     safe to resend (Snowflake will not re-run a statement that already ran).
 */

import { createJwtCache, type JwtIdentity } from "./jwt-cache";

export interface SnowflakeConfig {
  account: string; // e.g. 'ab12345.us-east-1' (URL prefix: locator plus region)
  user: string; // e.g. 'SLATE_SERVICE'
  privateKeyPem: string; // RSA private key in PEM (PKCS#1 or PKCS#8)
  database: string;
  schema: string;
  warehouse: string;
  role: string;
}

export interface SnowflakeStatementResponse {
  resultSetMetaData?: {
    numRows?: number;
    rowType?: Array<{ name: string; type: string }>;
  };
  data?: unknown[][];
  message?: string;
  code?: string;
  statementHandle?: string;
  statementStatusUrl?: string;
}

// ============================================================
// Public API
// ============================================================

/**
 * The one JWT cache for this isolate (#1141).
 *
 * Signing is four asymmetric operations for a token valid an hour, and it used to
 * happen per statement. The cache is keyed on the whole signing identity, so a
 * rotated key or a different user signs again immediately rather than being served
 * the previous token, and it is invalidated the moment Snowflake refuses a token.
 */
const jwtCache = createJwtCache({
  sign: async (identity: JwtIdentity) => {
    const privateKey = await importPrivateKey(identity.privateKeyPem);
    return signSnowflakeJwt({ account: identity.account, user: identity.user }, privateKey);
  },
});

function authHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "slate-worker/1.0",
    "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
  };
}

/** Test seam: drop the cached token so a suite cannot inherit one (#1141). */
export function resetSnowflakeJwtCache(): void {
  jwtCache.invalidate();
}

/**
 * How many times the signer has actually run (#1141).
 *
 * This exists because reuse is otherwise UNOBSERVABLE. RS256 over the same payload
 * is deterministic and the token's `iat` has second granularity, so a token
 * re-signed in the same second is byte for byte identical to the one it replaced.
 * A test comparing Authorization headers therefore passes whether the cache works
 * or not, in both directions, which is worse than having no test.
 */
export function snowflakeJwtSignCount(): number {
  return jwtCache.signCount();
}

export async function executeStatement(
  config: SnowflakeConfig,
  statement: string,
  bindings?: unknown[],
): Promise<SnowflakeStatementResponse> {
  const identity: JwtIdentity = {
    account: config.account,
    user: config.user,
    privateKeyPem: config.privateKeyPem,
  };
  const url = `https://${snowflakeHost(config.account)}/api/v2/statements`;
  // Snowflake stores unquoted identifiers uppercase. Send uppercase to match
  // regardless of how the config is set.
  const body: Record<string, unknown> = {
    statement,
    timeout: 60,
    database: config.database.toUpperCase(),
    schema: config.schema.toUpperCase(),
    warehouse: config.warehouse.toUpperCase(),
    role: config.role.toUpperCase(),
  };
  if (bindings && bindings.length > 0) {
    const bindMap: Record<string, { type: string; value: string }> = {};
    for (let i = 0; i < bindings.length; i++) {
      bindMap[String(i + 1)] = { type: "TEXT", value: bindings[i] == null ? "" : String(bindings[i]) };
    }
    body.bindings = bindMap;
  }

  let headers = authHeaders(await jwtCache.get(identity));

  // A fresh requestId per statement. Resubmitting the SAME requestId with
  // retry=true is Snowflake's idempotency contract: it will not execute a
  // statement that already succeeded, which is what makes retrying a request
  // that died before we saw its response safe.
  const requestId = crypto.randomUUID();
  const payload = JSON.stringify(body);
  let posted: { status: number; text: string };
  try {
    posted = await postStatementWithRetry(url, headers, payload, requestId);
  } catch (err) {
    // A token this isolate has been reusing can be refused for reasons a fresh one
    // fixes: clock skew against Snowflake, or the key having been rotated in
    // Snowflake while our copy still signs. Without this the cache would go on
    // resending the refused token for the whole reuse window, so it would turn one
    // auth blip into thirty minutes of failed exports. Exactly one re-sign: a
    // second 401 is a real auth problem and must surface rather than loop.
    if (!isAuthRejection(err)) throw err;
    jwtCache.invalidate();
    headers = authHeaders(await jwtCache.get(identity));
    posted = await postStatementWithRetry(url, headers, payload, requestId, { resubmit: true });
  }
  return resolveStatementResult(config, headers, posted.status, posted.text);
}

/**
 * A non-2xx from Snowflake, carrying the STATUS rather than only a message.
 *
 * #1141 needs to tell an auth rejection apart from anything else so it can re-sign
 * and resubmit once. Reading that back out of the message text would be a decision
 * made on a substring (L35), and the message is copy, not a contract.
 */
export class SnowflakeHttpError extends Error {
  // Written out rather than as constructor parameter properties: node's
  // strip-only type stripping (which runs every scripts/test-*.ts) rejects those,
  // so the shorthand typechecks and lints cleanly while breaking the node suites.
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Snowflake ${status}: ${body}`);
    this.name = "SnowflakeHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Is this Snowflake refusing the TOKEN, as opposed to refusing the statement?
 *
 * 401 only. A 403 is an authorization problem (the role cannot touch the object),
 * and a fresh signature cannot fix it, so resubmitting on 403 would spend a second
 * round trip to be told the same thing and would hide a real grant error behind it.
 */
export function isAuthRejection(err: unknown): boolean {
  return err instanceof SnowflakeHttpError && err.status === 401;
}

// Statuses worth resubmitting. 429/503/504 are Snowflake's own documented
// retryable set; 502 is the same Envoy-proxy class ("upstream connect error or
// disconnect/reset before headers"). 500 is deliberately NOT here: it can mean
// the statement itself failed server-side, and retrying would just hide a real
// error behind a delay.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

export function isTransientSnowflakeError(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

export interface RetryOptions {
  maxAttempts?: number;
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /**
   * Force `retry=true` from the FIRST attempt (#1141). Used when re-sending a
   * statement whose earlier submission was refused on the token: the requestId is
   * the same, so Snowflake's idempotency contract still covers the ambiguity even
   * though a 401 means it never ran.
   */
  resubmit?: boolean;
}

// Bounded on purpose. The export lane's per-run wall-time budget is spent across
// many batches, so a long retry ladder on any one batch would starve the drain.
// The backoff adds ~5s per batch. A Snowflake that HANGS costs each attempt its
// SNOWFLAKE_SUBMIT_TIMEOUT_MS as well, so three attempts can hold one batch about
// four minutes (#3972), which is still an error the lane reports rather than a kill;
// the lane's deadline check stops the run cleanly if an outage eats the budget.
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 4_000];

/**
 * #3972: each request's own bound, so a hung Snowflake ends as a thrown attempt (which
 * the ladder above resubmits under the same requestId) rather than a lane held until
 * the platform kills it with no failure recorded. The SQL API answers a submit with a
 * 202 and a handle once a statement runs past about 45 seconds, and `executeStatement`
 * caps the statement itself at 60 (`timeout: 60` in the body), so the submit's bound
 * sits a margin past BOTH and only ever cuts a request Snowflake has stopped answering;
 * a status poll answers at once.
 */
export const SNOWFLAKE_SUBMIT_TIMEOUT_MS = 75_000;
export const SNOWFLAKE_POLL_TIMEOUT_MS = 15_000;

/**
 * POST a statement, resubmitting on transient failures.
 *
 * Retries carry the original requestId plus retry=true so Snowflake dedupes a
 * statement that already ran. That matters most for the case we cannot observe:
 * a connection dropped before headers, where the MERGE may or may not have been
 * applied. Exported for unit testing.
 */
export async function postStatementWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  requestId: string,
  opts: RetryOptions = {},
): Promise<{ status: number; text: string }> {
  const maxAttempts = opts.maxAttempts ?? RETRY_MAX_ATTEMPTS;
  const delaysMs = opts.delaysMs ?? RETRY_DELAYS_MS;
  const doSleep = opts.sleep ?? sleep;

  for (let attempt = 1; ; attempt++) {
    const isRetry = attempt > 1 || opts.resubmit === true;
    const target = `${url}?requestId=${encodeURIComponent(requestId)}${isRetry ? "&retry=true" : ""}`;
    let retryable: boolean;
    let error: Error;

    try {
      const res = await fetch(target, { method: "POST", headers, body, signal: AbortSignal.timeout(SNOWFLAKE_SUBMIT_TIMEOUT_MS) });
      const text = await res.text();
      if (res.ok) return { status: res.status, text };
      retryable = isTransientSnowflakeError(res.status);
      error = new SnowflakeHttpError(res.status, text);
    } catch (e) {
      // fetch rejected, so no response ever arrived. Always retryable: the
      // requestId contract covers the ambiguity about whether it executed.
      retryable = true;
      error = e instanceof Error ? e : new Error(String(e));
    }

    if (!retryable || attempt >= maxAttempts) throw error;
    await doSleep(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)]);
  }
}

// Decide the result of a 2xx statement response. A 200 carries the completed
// result; a 202 means the statement is still running (it didn't finish within
// the body `timeout`, e.g. a cold-warehouse resume) and only carries a
// statementHandle to poll. Treating 202 as success would let the lane advance
// its watermark even if the MERGE never completed, so poll the statement to a
// terminal state instead. Exported for unit testing.
export async function resolveStatementResult(
  config: SnowflakeConfig,
  headers: Record<string, string>,
  status: number,
  text: string,
  pollOpts?: PollOptions,
): Promise<SnowflakeStatementResponse> {
  if (status === 202) {
    const parsed = parseResponse(text);
    const handle = parsed.statementHandle;
    if (!handle) throw new Error(`Snowflake returned 202 without a statementHandle: ${text}`);
    return pollStatement(config, headers, handle, pollOpts);
  }
  return parseResponse(text);
}

interface PollOptions {
  intervalMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 30; // ~60s of polling on top of the 60s server-side timeout

// Poll GET /api/v2/statements/{handle} until the statement reaches a terminal
// state. 202 = still running (keep polling); 2xx = complete (return the body);
// non-2xx = failed (throw, so the export batch fails and retries next run
// without advancing the watermark). Exhausting the attempts also throws.
// Exported for unit testing.
export async function pollStatement(
  config: SnowflakeConfig,
  headers: Record<string, string>,
  handle: string,
  pollOpts: PollOptions = {},
): Promise<SnowflakeStatementResponse> {
  const intervalMs = pollOpts.intervalMs ?? POLL_INTERVAL_MS;
  const maxAttempts = pollOpts.maxAttempts ?? POLL_MAX_ATTEMPTS;
  const doSleep = pollOpts.sleep ?? sleep;
  const url = `https://${snowflakeHost(config.account)}/api/v2/statements/${handle}?partition=0`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await doSleep(intervalMs);
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(SNOWFLAKE_POLL_TIMEOUT_MS) });
    const text = await res.text();
    if (res.status === 202) continue; // still running
    if (!res.ok) throw new Error(`Snowflake poll ${res.status}: ${text}`);
    return parseResponse(text);
  }
  throw new Error(`Snowflake statement ${handle} did not complete after ${maxAttempts} polls`);
}

function parseResponse(text: string): SnowflakeStatementResponse {
  try {
    return JSON.parse(text) as SnowflakeStatementResponse;
  } catch {
    return { message: text };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// Host / account name helpers
// ============================================================

export function snowflakeHost(account: string): string {
  // 'ab12345.us-east-1' becomes 'ab12345.us-east-1.snowflakecomputing.com'
  return `${account.toLowerCase()}.snowflakecomputing.com`;
}

// Encode a string for a Snowflake single-quoted literal. Snowflake treats
// backslash as an escape character inside string literals, so a lone trailing
// backslash would escape the closing quote and break out of the literal (SQL
// injection / query corruption). Double backslashes first, then double quotes.
// Shared by every call site that hand-builds SQL text so the escaping lives in
// exactly one place.
export function escapeSqlLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

function accountForJwt(account: string): string {
  // JWT iss/sub uses just the account locator (no region), uppercased.
  return account.split(".")[0].toUpperCase();
}

// ============================================================
// JWT signer
// ============================================================

async function signSnowflakeJwt(
  config: { account: string; user: string },
  privateKey: CryptoKey,
): Promise<string> {
  const fingerprint = await publicKeyFingerprint(privateKey);
  const account = accountForJwt(config.account);
  const user = config.user.toUpperCase();
  const iss = `${account}.${user}.SHA256:${fingerprint}`;
  const sub = `${account}.${user}`;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss, sub, iat: now, exp: now + 3600 };

  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

async function publicKeyFingerprint(privateKey: CryptoKey): Promise<string> {
  // Export private as JWK to get n + e, build a public-only JWK, import as
  // public key, then export as SPKI (DER) and SHA-256 hash that.
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  const publicJwk: JsonWebKey = {
    kty: "RSA",
    n: jwk.n,
    e: jwk.e,
    alg: "RS256",
    ext: true,
  };
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"],
  );
  const spki = (await crypto.subtle.exportKey("spki", publicKey)) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", spki);
  // Snowflake expects standard base64 (with padding), not base64url.
  return bytesToBase64Standard(new Uint8Array(digest));
}

// ============================================================
// PEM parser: handles PKCS#1 and PKCS#8
// ============================================================

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const trimmed = pem.replace(/\r/g, "").trim();
  const isPkcs1 = trimmed.includes("BEGIN RSA PRIVATE KEY");
  const der = pemToDer(trimmed);
  const pkcs8 = isPkcs1 ? pkcs1ToPkcs8(der) : der;

  return crypto.subtle.importKey(
    "pkcs8",
    // The DER bytes are a fresh ArrayBuffer-backed view; the cast satisfies
    // TS's BufferSource overload (which rejects the generic ArrayBufferLike).
    pkcs8 as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true, // extractable: needed so we can derive the public key for fingerprinting
    ["sign"],
  );
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(b64);
}

// Wrap PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo envelope.
// Layout:
//   SEQUENCE {
//     INTEGER 0,
//     AlgorithmIdentifier { OID rsaEncryption, NULL },
//     OCTET STRING <pkcs1 bytes>
//   }
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algorithmId = new Uint8Array([
    0x30, 0x0d, // SEQUENCE, len 13
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // OID 1.2.840.113549.1.1.1
    0x05, 0x00, // NULL
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0

  const octetHeader = derLengthPrefix(0x04, pkcs1.length);
  const innerLen = version.length + algorithmId.length + octetHeader.length + pkcs1.length;
  const outerHeader = derLengthPrefix(0x30, innerLen);

  const out = new Uint8Array(outerHeader.length + innerLen);
  let i = 0;
  out.set(outerHeader, i);
  i += outerHeader.length;
  out.set(version, i);
  i += version.length;
  out.set(algorithmId, i);
  i += algorithmId.length;
  out.set(octetHeader, i);
  i += octetHeader.length;
  out.set(pkcs1, i);
  return out;
}

// DER tag + length, supporting short, 1-byte, and 2-byte length forms.
function derLengthPrefix(tag: number, length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([tag, length]);
  if (length < 0x100) return new Uint8Array([tag, 0x81, length]);
  return new Uint8Array([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
}

// ============================================================
// Base64 helpers
// ============================================================

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64Standard(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function bytesToBase64Standard(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
