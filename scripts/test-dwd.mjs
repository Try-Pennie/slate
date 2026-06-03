// Local test: does Google domain-wide delegation work?
// Mints a delegated token impersonating a user, then queries their free/busy.
// Run: node scripts/test-dwd.mjs dwright@trypennie.com
import { readFileSync } from "node:fs";
import crypto from "node:crypto";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const subject = process.argv[2] || "dwright@trypennie.com";
const saEmail = env.GOOGLE_SA_CLIENT_EMAIL;
let key = env.GOOGLE_SA_PRIVATE_KEY || "";
key = key.replace(/^["']|["']$/g, "").replace(/\\n/g, "\n"); // un-escape

const SCOPES =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";
const b64url = (s) => Buffer.from(s).toString("base64url");

const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claims = b64url(
  JSON.stringify({
    iss: saEmail,
    sub: subject,
    scope: SCOPES,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }),
);
const signingInput = `${header}.${claims}`;
const signer = crypto.createSign("RSA-SHA256");
signer.update(signingInput);
const sig = signer.sign(key, "base64url");
const jwt = `${signingInput}.${sig}`;

const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  }),
});
const tok = await tokRes.json();
if (!tokRes.ok || !tok.access_token) {
  console.error("❌ delegated token failed:", tokRes.status, JSON.stringify(tok));
  process.exit(1);
}
console.log(`✅ minted delegated token impersonating ${subject}`);

const now2 = new Date();
const fbRes = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${tok.access_token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    timeMin: now2.toISOString(),
    timeMax: new Date(now2.getTime() + 7 * 86400000).toISOString(),
    items: [{ id: subject }],
  }),
});
const fb = await fbRes.json();
if (!fbRes.ok) {
  console.error("❌ freeBusy failed:", fbRes.status, JSON.stringify(fb));
  process.exit(1);
}
const busy = fb.calendars?.[subject]?.busy ?? [];
console.log(`✅ read ${subject}'s calendar — busy blocks next 7 days:`, busy.length);
console.log("\n✅ Domain-wide delegation works — no agent login needed.");
