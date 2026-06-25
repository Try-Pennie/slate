// P4 (#439) live verification: the intent-first create primitive
// (events.insert + deterministic client id, 409-as-success GET-and-reuse)
// must notify the attendee EXACTLY ONCE on first create and NOT re-notify on a
// crash-retry that hits 409.
//
// Mirrors src/lib/google/dwd.ts (JWT mint) and src/lib/google/calendar.ts
// createEvent() line-for-line for the Google requests:
//   POST /calendars/primary/events?sendUpdates=all   (with `id` = deterministic client id)
//   on 409 -> GET /calendars/primary/events/{id}     (reuse, no second insert)
//
// Organizer (impersonated calendar owner) = smoketest@trypennie.com
// Attendee (an address we own + can read)  = dwright@trypennie.com
// Far-future slot, unique runtag in the summary, event deleted quietly at the end.
//
// Run: set -a; . .env.local; set +a; node verify-notify-once.mjs

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const BASE = "https://www.googleapis.com/calendar/v3";
const SCOPE =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.readonly";

const ORGANIZER = "smoketest@trypennie.com";
const ATTENDEE = "dwright@trypennie.com";
const RUNTAG = `${Date.now()}`;
const SUMMARY = `[P4 NOTIFY-ONCE VERIFY ${RUNTAG}] delete me`;

// Load GOOGLE_SA_* from .env.local if not already in the environment.
import { readFileSync } from "node:fs";
function loadEnvLocal() {
  const path = process.env.SLATE_ENV_PATH ?? "./.env.local";
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return {}; }
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}
const fileEnv = loadEnvLocal();
const saEmail = process.env.GOOGLE_SA_CLIENT_EMAIL ?? fileEnv.GOOGLE_SA_CLIENT_EMAIL;
const saKey = (process.env.GOOGLE_SA_PRIVATE_KEY ?? fileEnv.GOOGLE_SA_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
if (!saEmail || !saKey) {
  console.error("Missing GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY in env.");
  process.exit(2);
}

// --- mirror of dwd.ts ---------------------------------------------------------
function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlString = (s) => b64url(new TextEncoder().encode(s));
function pemToPkcs8(pem) {
  const body = pem
    .replace(/^[\s\S]*-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----[\s\S]*$/, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
async function getDelegatedToken(subject) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlString(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlString(
    JSON.stringify({ iss: saEmail, sub: subject, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
  );
  const input = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(saKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const assertion = `${input}.${b64url(sig)}`;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`token failed ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

// --- mirror of core.ts deterministicEventId ----------------------------------
async function deterministicEventId(idempotencyKey, agentUserId) {
  const data = new TextEncoder().encode(`${idempotencyKey}:${agentUserId}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `slate${hex}`;
}

// --- mirror of calendar.ts createEvent() (the exact 2-request behavior) -------
async function createEvent(token, clientId) {
  const res = await fetch(`${BASE}/calendars/primary/events?sendUpdates=all`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      id: clientId,
      summary: SUMMARY,
      description: "P4 notify-once verification. Safe to ignore; auto-deleted.",
      start: { dateTime: "2027-03-15T15:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2027-03-15T15:30:00", timeZone: "America/New_York" },
      attendees: [{ email: ATTENDEE, displayName: "Dan (verify)" }],
    }),
  });
  if (res.status === 409) {
    const get = await fetch(`${BASE}/calendars/primary/events/${encodeURIComponent(clientId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!get.ok) throw new Error(`409 reuse GET failed ${get.status}: ${await get.text()}`);
    return { status: 409, id: (await get.json()).id };
  }
  if (!res.ok) throw new Error(`events.insert failed ${res.status}: ${await res.text()}`);
  return { status: res.status, id: (await res.json()).id };
}

async function deleteQuiet(token, id) {
  const res = await fetch(`${BASE}/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=none`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`delete failed ${res.status}: ${await res.text()}`);
  }
}

// --- run ---------------------------------------------------------------------
const token = await getDelegatedToken(ORGANIZER);
const clientId = await deterministicEventId(`verify-notify-once:${RUNTAG}`, ORGANIZER);
console.log(JSON.stringify({ step: "setup", organizer: ORGANIZER, attendee: ATTENDEE, runtag: RUNTAG, summary: SUMMARY, clientId }));

let eventId;
try {
  const first = await createEvent(token, clientId);
  console.log(JSON.stringify({ step: "create#1", httpStatus: first.status, id: first.id }));
  if (first.status === 409) throw new Error("create#1 unexpectedly 409 — clientId collided with a prior run; aborting");
  eventId = first.id;

  const retry = await createEvent(token, clientId);
  console.log(JSON.stringify({ step: "create#2(retry)", httpStatus: retry.status, id: retry.id, reusedSameEvent: retry.id === eventId }));
  if (retry.status !== 409) throw new Error(`retry expected 409 reuse, got HTTP ${retry.status}`);
  if (retry.id !== eventId) throw new Error(`retry returned a DIFFERENT event id (${retry.id} != ${eventId}) — NOT idempotent`);

  console.log(JSON.stringify({
    step: "RESULT",
    apiLevel: "PASS — create#1 inserted, create#2 hit 409 and reused the SAME event id; the retry made no second insert, so Google sent no second invite",
    nowVerifyInbox: `Search ${ATTENDEE} for the invite with subject containing "${RUNTAG}" — expect EXACTLY ONE invitation.`,
    eventId,
  }));
} finally {
  if (eventId) {
    await deleteQuiet(token, eventId);
    console.log(JSON.stringify({ step: "cleanup", deleted: eventId, sendUpdates: "none" }));
  }
}
