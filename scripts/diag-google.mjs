// One-off diagnostic: can Slate actually reach the connected Google Calendar?
// Reads creds from the DB (secret key) and tries a freebusy query.
import { readFileSync } from "node:fs";
import { google } from "googleapis";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const sec = env.SUPABASE_SECRET_KEY;

const res = await fetch(
  `${url}/rest/v1/google_credentials?select=refresh_token,calendar_id&limit=1`,
  { headers: { apikey: sec, Authorization: `Bearer ${sec}` } },
);
const [cred] = await res.json();
if (!cred?.refresh_token) {
  console.error("No refresh token in DB.");
  process.exit(1);
}

const oauth = new google.auth.OAuth2(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
);
oauth.setCredentials({ refresh_token: cred.refresh_token });

try {
  const at = await oauth.getAccessToken(); // forces a refresh
  console.log("Access token refreshed:", !!at.token);
  const cal = google.calendar({ version: "v3", auth: oauth });
  const now = new Date();
  const fb = await cal.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 3600_000).toISOString(),
      items: [{ id: cred.calendar_id || "primary" }],
    },
  });
  console.log("freebusy OK. Busy now:", JSON.stringify(fb.data.calendars));
  console.log("\n✅ Calendar access works — bookings will succeed.");
} catch (e) {
  console.error("\n❌ Calendar call failed:");
  console.error("  status:", e.code || e.response?.status);
  console.error("  message:", e.message);
  if (e.response?.data) console.error("  detail:", JSON.stringify(e.response.data));
}
