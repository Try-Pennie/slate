/**
 * The ONE verifier of Marcia's signed lead token (#3543, plan locked decision 15).
 *
 * It runs only where the secret lives: inside Slate, in the internal route behind
 * `McpBookingGateway`, which decides the lead, and in the gateway itself, which asks
 * it only whether a call may spend Marcia's overall limit (#3879). The booking MCP Worker holds no key and runs only the shape
 * parse in `token-shape.ts`, which this calls first, so the two cannot disagree on
 * what a well formed token is.
 *
 * Fails closed: no key configured refuses every token (`token_keys_unconfigured`),
 * a key of the wrong shape is not a key, and the published fixture key is never a
 * key in a real deployment. Two slots (`MARCIA_TOKEN_KEY_A` and `_B`, decision 19)
 * so the shared secret rotates with no gap: put the new value in the empty slot,
 * move Marcia to it, then empty the old one. Every configured slot is tried
 * whatever an earlier one answered, and the comparison is WebCrypto's HMAC verify,
 * which is constant time, so the time taken says nothing about which slot matched.
 *
 * The signature is checked BEFORE the claims are trusted, but after the shape
 * parse: a token that is not even well formed costs no HMAC.
 */
import {
  bytesToBase64Url,
  MACHINE_TOKEN_ALG,
  parseMachineTokenShape,
  type MachineTokenRefusal,
  type MarciaLeadClaims,
} from "./token-shape.ts";

/** The env names of the two key slots, held only by Slate's own Worker. */
export const MARCIA_TOKEN_KEY_ENV = ["MARCIA_TOKEN_KEY_A", "MARCIA_TOKEN_KEY_B"] as const;

/**
 * The key the committed fixtures are signed with. PUBLIC, in the repo on purpose,
 * so Marcia's signer can prove itself against `machine-token-fixtures.json` (L26).
 * Which is exactly why it must never verify a real token: `usableTokenKeys` drops it.
 */
export const FIXTURE_TOKEN_KEY = "slate-marcia-token-fixture-key-PUBLIC-never-a-real-key-0001";

/** A key shorter than this is a placeholder or a typo, not 256 bits of secret. */
export const MIN_TOKEN_KEY_CHARS = 32;

export type VerifyResult = { ok: true; claims: MarciaLeadClaims } | { ok: false; refusal: MachineTokenRefusal };

/**
 * The configured slots that can be keys. Blank, short and fixture values are
 * dropped (the fixture one with a reason, since it means somebody pasted the
 * test key into a deployment), so they can never authenticate anything.
 */
export function usableTokenKeys(slots: readonly (string | undefined | null)[]): { keys: string[]; fixtureKeyConfigured: boolean } {
  let fixtureKeyConfigured = false;
  const keys: string[] = [];
  for (const raw of slots) {
    const key = (raw ?? "").trim();
    if (key === FIXTURE_TOKEN_KEY) {
      fixtureKeyConfigured = true;
      continue;
    }
    if (key.length >= MIN_TOKEN_KEY_CHARS) keys.push(key);
  }
  return { keys, fixtureKeyConfigured };
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/**
 * Verify a token against the given keys at `nowMs`. `keys` are the USABLE keys
 * (`usableTokenKeys`); the fixture suite passes the fixture key directly, which is
 * the only caller allowed to.
 */
export async function verifyMachineToken(token: unknown, keys: readonly string[], nowMs: number): Promise<VerifyResult> {
  const shape = parseMachineTokenShape(token, nowMs);
  if (!shape.ok) return shape;
  if (keys.length === 0) return { ok: false, refusal: { code: "token_keys_unconfigured" } };
  const data = new TextEncoder().encode(shape.token.signingInput);
  let matched = false;
  for (const secret of keys) {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), shape.token.signature, data);
    matched = matched || ok;
  }
  if (!matched) return { ok: false, refusal: { code: "token_signature_invalid" } };
  return { ok: true, claims: shape.token.claims };
}

/**
 * Sign claims into a token. Slate never signs a lead token in production (Marcia
 * does); this exists for the fixture builder and the suites, and as the reference
 * a signer is checked against. Keys and claim order are the caller's, so the
 * fixture builder controls the bytes exactly.
 */
export async function signMachineToken(payload: Record<string, unknown>, secret: string, header: Record<string, unknown> = { alg: MACHINE_TOKEN_ALG, typ: "JWT" }): Promise<string> {
  const enc = (o: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(signingInput)));
  return `${signingInput}.${bytesToBase64Url(sig)}`;
}
