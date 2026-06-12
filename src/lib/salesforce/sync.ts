import { supabaseAdmin } from "@/lib/supabase/admin";
import { ensureDefaultOrg } from "@/lib/provision";
import { sfClientId, sfClientSecret, sfInstanceUrl } from "@/lib/env";
import { mergeSfAttributes } from "@/lib/salesforce/attributes";
import {
  matchByInitialLastName,
  resolveManagerSync,
} from "@/lib/salesforce/manager-sync";
import type { Attributes, Role, User } from "@/lib/db/types";

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
  FirstName?: string | null;
  LastName?: string | null;
  Profile?: { Name?: string } | null;
  /** Custom picklist holding the agent's OOO approver by NAME (not the standard
   *  Manager lookup, which is a different person at Pennie). */
  Agent_Manager__c?: string | null;
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
  managersCreated: number;
  managersLinked: number;
  managersPromoted: number;
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
    `SELECT Email, Name, Profile.Name, Agent_Manager__c, ` +
    `${DEBT.map(([f]) => f).join(", ")}, ` +
    `${BACKEND.map(([f]) => f).join(", ")} FROM User ` +
    `WHERE IsActive = true AND (${debtFilter}) AND Email != null`;

  const sfUsers = await queryAll(instanceUrl, token, soql);
  const db = supabaseAdmin();
  const org = await ensureDefaultOrg();

  // Existing Slate agents by email (attributes too: Slate-managed keys like
  // legal_eligible must survive the sync - see mergeSfAttributes).
  const { data: existing } = await db
    .from("users")
    .select("id, email, attributes")
    .eq("org_id", org.id);
  const byEmail = new Map(
    (existing ?? []).map((u) => {
      const row = u as { id: string; email: string; attributes: Attributes };
      return [row.email.toLowerCase(), row];
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
    const current = byEmail.get(email);
    if (current) {
      await db
        .from("users")
        .update({
          name: u.Name,
          attributes: mergeSfAttributes(current.attributes, attributes),
        })
        .eq("id", current.id);
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

  // Manager edge (#76): the approver lives in the custom Agent_Manager__c
  // picklist as a NAME ("Jason Campbell"). Resolve every distinct name to an
  // email in ONE SF query (a per-sync map, not a lookup per agent).
  const managerNames = [
    ...new Set(
      sfUsers.map((u) => (u.Agent_Manager__c ?? "").trim()).filter(Boolean),
    ),
  ];
  const nameToEmail = new Map<string, string>();
  if (managerNames.length) {
    const inList = managerNames
      .map((n) => `'${n.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`)
      .join(",");
    const mgrRecords = await queryAll(
      instanceUrl,
      token,
      `SELECT Name, Email FROM User WHERE Name IN (${inList}) AND Email != null`,
    );
    for (const m of mgrRecords) {
      const nm = (m.Name ?? "").trim();
      const em = (m.Email ?? "").toLowerCase();
      if (nm && em && !nameToEmail.has(nm)) nameToEmail.set(nm, em);
    }
  }

  // Fallback for informal picklist names (e.g. "Mike Dugan" vs the user
  // "Michael Dugan"): match unresolved names by last name + first initial, but
  // only when exactly one active user matches, so it never links to the wrong
  // person.
  const unresolved = managerNames.filter((n) => !nameToEmail.has(n));
  if (unresolved.length) {
    const lastNames = [
      ...new Set(
        unresolved
          .map((n) => n.trim().split(/\s+/).pop() ?? "")
          .filter(Boolean),
      ),
    ];
    const inLast = lastNames
      .map((n) => `'${n.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`)
      .join(",");
    const candidates = (
      await queryAll(
        instanceUrl,
        token,
        `SELECT FirstName, LastName, Email FROM User WHERE IsActive = true AND Email != null AND LastName IN (${inLast})`,
      )
    )
      .map((c) => ({
        firstName: c.FirstName ?? "",
        lastName: c.LastName ?? "",
        email: c.Email ?? "",
      }))
      .filter((c) => c.firstName && c.lastName && c.email);
    for (const name of unresolved) {
      const em = matchByInitialLastName(name, candidates);
      if (em) nameToEmail.set(name, em);
    }
  }

  // Resolve agent->manager and create any manager who isn't already a Slate
  // user so manager_id can reference them. Managers come in role='manager',
  // bookable=false (they approve, they don't take bookings); if they later log
  // in, provision keeps that role.
  const plan = resolveManagerSync(
    sfUsers.map((u) => {
      const mgrName = (u.Agent_Manager__c ?? "").trim();
      return {
        email: (u.Email ?? "").toLowerCase(),
        managerEmail: mgrName ? (nameToEmail.get(mgrName) ?? null) : null,
        managerName: mgrName || null,
      };
    }),
    new Set(byEmail.keys()),
  );
  const managerInserts: Partial<User>[] = plan.managersToCreate.map((m) => ({
    org_id: org.id,
    email: m.email,
    name: m.name,
    role: "manager",
    attributes: {},
    bookable: false,
  }));
  if (managerInserts.length) await db.from("users").insert(managerInserts);

  // Re-read so freshly inserted agents AND managers are resolvable by email.
  const { data: afterInsert } = await db
    .from("users")
    .select("id, email, manager_id, role")
    .eq("org_id", org.id);
  const idByEmail = new Map(
    (afterInsert ?? []).map((u) => {
      const row = u as { id: string; email: string };
      return [row.email.toLowerCase(), row.id];
    }),
  );
  const managerIdByUser = new Map(
    (afterInsert ?? []).map((u) => {
      const row = u as { id: string; manager_id: string | null };
      return [row.id, row.manager_id];
    }),
  );

  // Apply links; only write when the value actually changes (and never null
  // out an existing assignment just because SF didn't resolve - admins can
  // override). Self-links are already filtered by resolveManagerSync.
  let managersLinked = 0;
  for (const link of plan.links) {
    const agentId = idByEmail.get(link.agentEmail);
    const managerId = idByEmail.get(link.managerEmail);
    if (!agentId || !managerId || agentId === managerId) continue;
    if (managerIdByUser.get(agentId) === managerId) continue;
    await db.from("users").update({ manager_id: managerId }).eq("id", agentId);
    managersLinked++;
  }

  // Anyone SF lists as an Agent_Manager (a real approver) becomes a Slate
  // 'manager' so they can open the queue and approve - even if they're also a
  // debt-team agent. Admins keep their role; this never demotes.
  const managerEmails = new Set(plan.links.map((l) => l.managerEmail));
  const toPromote = (afterInsert ?? [])
    .map((u) => u as { id: string; email: string; role: Role })
    .filter(
      (u) => u.role === "agent" && managerEmails.has(u.email.toLowerCase()),
    )
    .map((u) => u.id);
  let managersPromoted = 0;
  if (toPromote.length) {
    await db.from("users").update({ role: "manager" }).in("id", toPromote);
    managersPromoted = toPromote.length;
  }

  // Delete synced-only users (never logged in) no longer referenced - keep
  // both the SF agent set AND anyone who is a manager of record, so a manager
  // without a debt team (thus absent from the agent query) is never reaped.
  const keepEmails = new Set(sfEmails);
  for (const link of plan.links) keepEmails.add(link.managerEmail);
  const { data: orphans } = await db
    .from("users")
    .select("id, email")
    .eq("org_id", org.id)
    .is("auth_user_id", null);
  const toDelete = (orphans ?? [])
    .filter((u) => !keepEmails.has((u as { email: string }).email.toLowerCase()))
    .map((u) => (u as { id: string }).id);
  if (toDelete.length) await db.from("users").delete().in("id", toDelete);

  return {
    inserted: inserts.length,
    updated,
    deleted: toDelete.length,
    managersCreated: plan.managersToCreate.length,
    managersLinked,
    managersPromoted,
  };
}
