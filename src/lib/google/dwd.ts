import { googleSaClientEmail, googleSaPrivateKey } from "@/lib/env";

/**
 * Google domain-wide delegation: mint an access token that impersonates a
 * Workspace user's calendar, using the service account — no per-agent OAuth.
 * RS256 JWT is signed with Web Crypto so this runs on the Cloudflare Worker.
 */

const SCOPE =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// In-memory token cache per impersonated email (tokens last ~1h).
const cache = new Map<string, { token: string; exp: number }>();

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

async function signJwt(subject: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlString(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlString(
    JSON.stringify({
      iss: googleSaClientEmail(),
      sub: subject,
      scope: SCOPE,
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

/** Returns a calendar access token impersonating `email` (cached ~55 min). */
export async function getDelegatedToken(email: string): Promise<string> {
  const hit = cache.get(email);
  if (hit && hit.exp - Date.now() > 60_000) return hit.token;

  const assertion = await signJwt(email);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Delegated token failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cache.set(email, {
    token: data.access_token,
    exp: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}
