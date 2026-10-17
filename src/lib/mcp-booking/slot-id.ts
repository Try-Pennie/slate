/**
 * Opaque slot ids for Marcia's booking tools (#3543, plan decision 17: "find_times
 * returns at most 5 preformatted times with opaque slot ids; book and move take a
 * slot id only").
 *
 * A model reading a list of times will happily invent one that was never offered,
 * or carry a time across to another lead. A slot id is therefore a MAC over the
 * instant, the bucket it was offered in, the lead it was offered to and when it was
 * issued, under a key only Slate holds. Book and move accept only an id Slate made
 * for this lead within `SLOT_ID_TTL_MS`; anything else is `slot_invalid`.
 *
 * The same ids are the proof a move was OFFERED before a lead cancels for a schedule
 * conflict (decision 17): a cancel naming the ids it was shown proves find_times ran
 * for this lead, which the model cannot fake.
 *
 * The key is derived from the gateway secret with a label of its own, so the two
 * never share a use (one key, one purpose).
 */
import { base64UrlToBytes, bytesToBase64Url } from "./token-shape.ts";

/** How long an offered time stays bookable by its id: a conversation, not a day. */
export const SLOT_ID_TTL_MS = 30 * 60 * 1000;
const LABEL = "slate-marcia-slot-id-v1";

export interface SlotFacts {
  startIso: string;
  bucketCode: string;
  salesforceId: string;
}

interface SlotBody {
  s: string;
  b: string;
  l: string;
  /** Issued at, ms. */
  t: number;
}

async function macKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", base, new TextEncoder().encode(LABEL)));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueSlotId(facts: SlotFacts, secret: string, nowMs: number): Promise<string> {
  const body: SlotBody = { s: facts.startIso, b: facts.bucketCode, l: facts.salesforceId, t: nowMs };
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(body)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await macKey(secret), new TextEncoder().encode(payload)));
  return `${payload}.${bytesToBase64Url(mac)}`;
}

export type SlotIdReading =
  | { ok: true; startIso: string; bucketCode: string; issuedAtMs: number }
  | { ok: false; why: "malformed" | "forged" | "other_lead" | "expired" };

/** Read a slot id back, for `salesforceId`. Never throws. */
export async function readSlotId(id: unknown, salesforceId: string, secret: string, nowMs: number): Promise<SlotIdReading> {
  if (typeof id !== "string" || id.length > 1024) return { ok: false, why: "malformed" };
  const [payload, macPart, extra] = id.split(".");
  if (!payload || !macPart || extra !== undefined) return { ok: false, why: "malformed" };
  const mac = base64UrlToBytes(macPart);
  const raw = base64UrlToBytes(payload);
  if (!mac || !raw) return { ok: false, why: "malformed" };
  const valid = await crypto.subtle.verify("HMAC", await macKey(secret), mac, new TextEncoder().encode(payload));
  if (!valid) return { ok: false, why: "forged" };
  let body: SlotBody;
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as SlotBody;
  } catch {
    return { ok: false, why: "malformed" };
  }
  if (typeof body.s !== "string" || typeof body.b !== "string" || typeof body.l !== "string" || typeof body.t !== "number") {
    return { ok: false, why: "malformed" };
  }
  if (body.l !== salesforceId) return { ok: false, why: "other_lead" };
  if (nowMs - body.t > SLOT_ID_TTL_MS || body.t - nowMs > 60_000) return { ok: false, why: "expired" };
  return { ok: true, startIso: body.s, bucketCode: body.b, issuedAtMs: body.t };
}
