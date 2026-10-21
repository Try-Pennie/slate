/**
 * Marcia's signed lead token: its format, and the SECRETLESS shape check (#3543,
 * plan locked decision 15, kit phase 4.1).
 *
 * Marcia signs one token per lead conversation with a secret she shares with Slate
 * (decision 18). The token pins the lead: the booking MCP endpoint reads the lead
 * from it and never from a tool argument (decisions 17 and 19), so a model that
 * names another lead in an argument reaches nobody.
 *
 * The format is a compact JWS with `alg` HS256 (a JWT): three base64url segments,
 * `header.payload.signature`, the signature an HMAC SHA-256 over
 * `header.payload` under one of Slate's two key slots. The protocol claims, the
 * lead id, the bucket and the test flag are REQUIRED (L688): a token missing any
 * one is refused by name, so a signer that stops sending the test flag cannot be
 * read as a real lead.
 *
 * The lead's `name`, `email`, `phone` and `time_zone` are OPTIONAL (Dan,
 * 2026-10-20): Regal, which feeds Marcia, may not hold them for every lead, and a
 * lead Slate can still route and book should not be turned away for a missing
 * address. Absent, null or "" all mean absent, and the parsed claims then carry no
 * such key, so no reader books an empty string. Present and not empty, each is
 * still held to its rule below and refused by name when broken. What the booking
 * path does without them is in `operations.ts`.
 *
 * Two readers, one rule set, ONE file (L19, L263):
 *  - the MCP Worker (`worker/mcp-booking`) runs `parseMachineTokenShape` with no
 *    secret, only to reject garbage before it costs a gateway call;
 *  - Slate's internal route runs `verifyMachineToken` (`machine-token.ts`), which is
 *    this same parse plus the signature, and is the only check that decides.
 *
 * Pure and import free, because the MCP Worker bundles it on its own.
 *
 * WHERE THIS SHOULD LIVE. The plan puts one verifier in the shared kit
 * (Try-Pennie/pennie-mcp-kit#11). On 2026-10-16 that repo held only a README, so
 * Slate's copy is the first and only one, written to be lifted into the kit
 * unchanged; the committed fixtures (`machine-token-fixtures.json`) are the
 * contract Marcia's signer is held to either way (L26).
 */

export const MACHINE_TOKEN_ALG = "HS256";
export const MACHINE_TOKEN_ISSUER = "marcia";
export const MACHINE_TOKEN_AUDIENCE = "slate-booking";
/** The longest a token may live, issue to expiry: about 15 minutes (decision 18). */
export const MACHINE_TOKEN_MAX_LIFE_SEC = 15 * 60;
/** How far a token's issue time may sit in our future, for clock drift. */
export const MACHINE_TOKEN_CLOCK_SKEW_SEC = 60;

/** The claims a lead token carries: the contact four optional, every other one required. */
export interface MarciaLeadClaims {
  iss: typeof MACHINE_TOKEN_ISSUER;
  aud: typeof MACHINE_TOKEN_AUDIENCE;
  /** Issued at, seconds since the epoch. */
  iat: number;
  /** Expires at, seconds since the epoch. */
  exp: number;
  /** One per tool call ATTEMPT, so a retry of that attempt acts once (L747). */
  nonce: string;
  /** The lead's Salesforce Lead id (00Q, 15 or 18 characters). */
  salesforce_id: string;
  /** The routing bucket code the lead belongs to. */
  bucket_code: string;
  /** Optional, as are the three below it: Regal may not hold them (Dan, 2026-10-20). */
  name?: string;
  email?: string;
  phone?: string;
  /** The lead's default IANA time zone; the only thing a tool argument may override. */
  time_zone?: string;
  /** Set by Marcia's code, never by the model: true routes to a test bucket. */
  test: boolean;
}

export const MACHINE_TOKEN_CLAIMS = [
  "iss",
  "aud",
  "iat",
  "exp",
  "nonce",
  "salesforce_id",
  "bucket_code",
  "name",
  "email",
  "phone",
  "time_zone",
  "test",
] as const satisfies readonly (keyof MarciaLeadClaims)[];
export type MachineTokenClaim = (typeof MACHINE_TOKEN_CLAIMS)[number];

/** The claims a token may leave out, or send as null or "" (Dan, 2026-10-20). */
export const MACHINE_TOKEN_OPTIONAL_CLAIMS = ["name", "email", "phone", "time_zone"] as const satisfies readonly MachineTokenClaim[];
export type OptionalMachineTokenClaim = (typeof MACHINE_TOKEN_OPTIONAL_CLAIMS)[number];
const OPTIONAL: ReadonlySet<MachineTokenClaim> = new Set(MACHINE_TOKEN_OPTIONAL_CLAIMS);

/**
 * Why a token was refused. Each is its own code because each sends a different
 * person to do a different thing (L11): a malformed or unsigned token is a bug in
 * the signer, an expired one is a clock or a slow conversation, an unconfigured key
 * is a Slate deployment that cannot judge anything.
 */
export type MachineTokenRefusal =
  | { code: "token_malformed" }
  | { code: "token_unsupported_alg" }
  | { code: "token_claim_missing"; claim: MachineTokenClaim }
  | { code: "token_claim_invalid"; claim: MachineTokenClaim }
  | { code: "token_expired" }
  | { code: "token_not_yet_valid" }
  | { code: "token_life_too_long" }
  | { code: "token_signature_invalid" }
  | { code: "token_keys_unconfigured" };

export type MachineTokenCode = MachineTokenRefusal["code"];

export const MACHINE_TOKEN_CODES: readonly MachineTokenCode[] = [
  "token_malformed",
  "token_unsupported_alg",
  "token_claim_missing",
  "token_claim_invalid",
  "token_expired",
  "token_not_yet_valid",
  "token_life_too_long",
  "token_signature_invalid",
  "token_keys_unconfigured",
];

export interface ParsedMachineToken {
  claims: MarciaLeadClaims;
  /** `header.payload`, the bytes the signature covers. */
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

export type ShapeResult = { ok: true; token: ParsedMachineToken } | { ok: false; refusal: MachineTokenRefusal };

const B64URL = /^[A-Za-z0-9_-]+$/;
const SALESFORCE_LEAD_ID = /^00Q[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const BUCKET_CODE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_TOKEN_CHARS = 4096;

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonSegment(s: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(s);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const nonBlank = (v: unknown, max: number): boolean => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** Each claim's own rule. A value of the wrong TYPE is invalid, never coerced: the
 *  string "true" is not the boolean true (L688). */
const CLAIM_VALID: Record<MachineTokenClaim, (v: unknown) => boolean> = {
  iss: (v) => v === MACHINE_TOKEN_ISSUER,
  aud: (v) => v === MACHINE_TOKEN_AUDIENCE,
  iat: (v) => Number.isSafeInteger(v) && (v as number) > 0,
  exp: (v) => Number.isSafeInteger(v) && (v as number) > 0,
  nonce: (v) => typeof v === "string" && NONCE.test(v),
  salesforce_id: (v) => typeof v === "string" && SALESFORCE_LEAD_ID.test(v),
  bucket_code: (v) => typeof v === "string" && BUCKET_CODE.test(v),
  name: (v) => nonBlank(v, 200),
  email: (v) => nonBlank(v, 320) && (v as string).includes("@"),
  phone: (v) => nonBlank(v, 40),
  time_zone: (v) => typeof v === "string" && v.length <= 64 && isZone(v),
  test: (v) => typeof v === "boolean",
};

/**
 * Whether a name, email or phone found ELSEWHERE (the lead's earlier booking, the
 * Salesforce Lead) passes the same rule the token's own claim would. One rule set,
 * so a value Slate fills in is never one it would have refused from Marcia.
 */
export function contactValueValid(claim: "name" | "email" | "phone", v: unknown): v is string {
  return CLAIM_VALID[claim](v);
}

/**
 * Split, decode and check every claim, WITHOUT the signature. Never throws.
 *
 * Passing this proves nothing about who made the token: anybody can write a token
 * of the right shape. It exists so the MCP Worker can refuse garbage cheaply, and so
 * the verifier and the parser cannot disagree about what a well formed token is.
 */
export function parseMachineTokenShape(token: unknown, nowMs: number): ShapeResult {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) {
    return { ok: false, refusal: { code: "token_malformed" } };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return { ok: false, refusal: { code: "token_malformed" } };
  const [h, p, s] = parts;
  const header = jsonSegment(h);
  const payload = jsonSegment(p);
  const signature = base64UrlToBytes(s);
  if (!header || !payload || !signature) return { ok: false, refusal: { code: "token_malformed" } };
  if (header.alg !== MACHINE_TOKEN_ALG || (header.typ !== undefined && header.typ !== "JWT")) {
    return { ok: false, refusal: { code: "token_unsupported_alg" } };
  }
  const kept: Record<string, unknown> = { ...payload };
  for (const claim of MACHINE_TOKEN_CLAIMS) {
    const v = payload[claim];
    if (!(claim in payload) || v === null || v === undefined || (OPTIONAL.has(claim) && v === "")) {
      if (OPTIONAL.has(claim)) {
        // Absent, null and "" are one answer, and the claims carry no key for it.
        delete kept[claim];
        continue;
      }
      return { ok: false, refusal: { code: "token_claim_missing", claim } };
    }
    if (!CLAIM_VALID[claim](v)) return { ok: false, refusal: { code: "token_claim_invalid", claim } };
  }
  const claims = kept as unknown as MarciaLeadClaims;
  const nowSec = Math.floor(nowMs / 1000);
  if (claims.exp <= claims.iat) return { ok: false, refusal: { code: "token_claim_invalid", claim: "exp" } };
  if (claims.exp - claims.iat > MACHINE_TOKEN_MAX_LIFE_SEC) return { ok: false, refusal: { code: "token_life_too_long" } };
  if (claims.iat > nowSec + MACHINE_TOKEN_CLOCK_SKEW_SEC) return { ok: false, refusal: { code: "token_not_yet_valid" } };
  if (claims.exp <= nowSec) return { ok: false, refusal: { code: "token_expired" } };
  return { ok: true, token: { claims, signingInput: `${h}.${p}`, signature } };
}

/** The one line a refusal is logged and answered with, naming the claim and never its value. */
export function describeTokenRefusal(r: MachineTokenRefusal): string {
  switch (r.code) {
    case "token_malformed":
      return "The lead token is not a well formed signed token.";
    case "token_unsupported_alg":
      return "The lead token is not signed with HS256.";
    case "token_claim_missing":
      return `The lead token has no ${r.claim} claim, and that claim is required.`;
    case "token_claim_invalid":
      return `The lead token's ${r.claim} claim is not valid.`;
    case "token_expired":
      return "The lead token has expired; sign a new one.";
    case "token_not_yet_valid":
      return "The lead token was issued in the future; check the signer's clock.";
    case "token_life_too_long":
      return `The lead token lives longer than ${MACHINE_TOKEN_MAX_LIFE_SEC / 60} minutes.`;
    case "token_signature_invalid":
      return "The lead token's signature does not match either of Slate's keys.";
    case "token_keys_unconfigured":
      return "Slate holds no key to check lead tokens with, so it refuses every one.";
  }
}
