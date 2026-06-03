import { supabaseAdmin } from "@/lib/supabase/admin";
import { ensureDefaultOrg } from "@/lib/provision";
import { sfClientId, sfClientSecret, sfInstanceUrl } from "@/lib/env";
import type { Attributes, User } from "@/lib/db/types";

// SF User custom booleans -> Slate attribute values.
const DEBT: [keyof SfUser, string][] = [
  ["UltraHighDebt__c", "ultra_high"],
  ["VeryHighDebt__c", "very_high"],
  ["HighDebt__c", "high"],
  ["MediumDebt__c", "medium"],
  ["LowDebt__c", "low"],
];
const BACKEND: [keyof SfUser, string][] = [
  ["BeyondBackendServicer__c", "beyond"],
  ["AchieveBackendServicer__c", "achieve"],
];

interface SfUser {
  Email: string | null;
  Name: string | null;
  Profile?: { Name?: string } | null;
  UltraHighDebt__c?: boolean;
  VeryHighDebt__c?: boolean;
  HighDebt__c?: boolean;
  MediumDebt__c?: boolean;
  LowDebt__c?: boolean;
  BeyondBackendServicer__c?: boolean;
  AchieveBackendServicer__c?: boolean;
}

async function sfToken(): Promise<{ token: string; instanceUrl: string }> {
  const res = await fetch(`${sfInstanceUrl()}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: sfClientId(),
      client_secret: sfClientSecret(),
    }),
  });
  if (!res.ok) throw new Error(`SF token failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; instance_url: string };
  return { token: data.access_token, instanceUrl: data.instance_url };
}

async function queryAll(
  instanceUrl: string,
  token: string,
  soql: string,
): Promise<SfUser[]> {
  const records: SfUser[] = [];
  let url = `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`;
  for (;;) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`SF query failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      records: SfUser[];
      done: boolean;
      nextRecordsUrl?: string;
    };
    records.push(...data.records);
    if (data.done || !data.nextRecordsUrl) break;
    url = `${instanceUrl}${data.nextRecordsUrl}`;
  }
  return records;
}

function toAttributes(u: SfUser): Attributes {
  const debt = DEBT.filter(([f]) => u[f]).map(([, v]) => v);
  const backend = BACKEND.filter(([f]) => u[f]).map(([, v]) => v);
  const attrs: Attributes = {};
  if (debt.length) attrs.debt_team = debt;
  if (backend.length) attrs.backend_service = backend;
  if (u.Profile?.Name) attrs.role = u.Profile.Name;
  return attrs;
}

export interface SyncResult {
  inserted: number;
  updated: number;
  deleted: number;
}

/**
 * Syncs active Salesforce agents (with any debt team) into Slate `users`,
 * matched by email. New agents come in bookable=false; agents that drop out of
 * the SF set and never logged in are deleted (booking history survives via the
 * agent snapshot on bookings). Admins (auth_user_id set) are never deleted.
 */
export async function syncSalesforceAgents(): Promise<SyncResult> {
  const { token, instanceUrl } = await sfToken();
  const debtFilter = DEBT.map(([f]) => `${f}=true`).join(" OR ");
  const soql =
    `SELECT Email, Name, Profile.Name, ${DEBT.map(([f]) => f).join(", ")}, ` +
    `${BACKEND.map(([f]) => f).join(", ")} FROM User ` +
    `WHERE IsActive = true AND (${debtFilter}) AND Email != null`;

  const sfUsers = await queryAll(instanceUrl, token, soql);
  const db = supabaseAdmin();
  const org = await ensureDefaultOrg();

  // Existing Slate agents by email.
  const { data: existing } = await db
    .from("users")
    .select("id, email")
    .eq("org_id", org.id);
  const byEmail = new Map(
    (existing ?? []).map((u) => {
      const row = u as { id: string; email: string };
      return [row.email.toLowerCase(), row.id];
    }),
  );

  const sfEmails = new Set<string>();
  const inserts: Partial<User>[] = [];
  let updated = 0;

  for (const u of sfUsers) {
    const email = (u.Email ?? "").toLowerCase();
    if (!email) continue;
    sfEmails.add(email);
    const attributes = toAttributes(u);
    const id = byEmail.get(email);
    if (id) {
      await db
        .from("users")
        .update({ name: u.Name, attributes })
        .eq("id", id);
      updated++;
    } else {
      inserts.push({
        org_id: org.id,
        email,
        name: u.Name,
        role: "agent",
        attributes,
        bookable: false,
      });
    }
  }

  if (inserts.length) await db.from("users").insert(inserts);

  // Delete synced-only agents (never logged in) no longer in the SF set.
  const { data: orphans } = await db
    .from("users")
    .select("id, email")
    .eq("org_id", org.id)
    .is("auth_user_id", null);
  const toDelete = (orphans ?? [])
    .filter((u) => !sfEmails.has((u as { email: string }).email.toLowerCase()))
    .map((u) => (u as { id: string }).id);
  if (toDelete.length) await db.from("users").delete().in("id", toDelete);

  return { inserted: inserts.length, updated, deleted: toDelete.length };
}
