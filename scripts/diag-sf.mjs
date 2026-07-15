// Local test: does the Salesforce External Client App (client-credentials) work?
// Run: node scripts/diag-sf.mjs
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const { SF_CLIENT_ID, SF_CLIENT_SECRET, SF_INSTANCE_URL } = env;

// 1) client-credentials token
const tokenRes = await fetch(`${SF_INSTANCE_URL}/services/oauth2/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
  }),
});
const tok = await tokenRes.json();
if (!tokenRes.ok || !tok.access_token) {
  console.error("❌ token request failed:", tokenRes.status, JSON.stringify(tok));
  process.exit(1);
}
console.log("✅ got access token. instance:", tok.instance_url);

const base = tok.instance_url || SF_INSTANCE_URL;
const q = async (soql) => {
  const r = await fetch(
    `${base}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${tok.access_token}` } },
  );
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j;
};

// 2) count of syncable agents (active + any debt team)
const debt =
  "(UltraHighDebt__c=true OR VeryHighDebt__c=true OR HighDebt__c=true OR MediumDebt__c=true OR LowDebt__c=true)";
const count = await q(`SELECT COUNT() FROM User WHERE IsActive=true AND ${debt}`);
console.log("✅ syncable agents (active + debt team):", count.totalSize);

// 3) sample
const sample = await q(
  `SELECT Email, Profile.Name, UltraHighDebt__c, VeryHighDebt__c, BeyondBackendServicer__c, AchieveBackendServicer__c FROM User WHERE IsActive=true AND ${debt} LIMIT 3`,
);
for (const r of sample.records) {
  console.log("  ", r.Email, "| profile:", r.Profile?.Name);
}
console.log("\n✅ Salesforce connection works.");
