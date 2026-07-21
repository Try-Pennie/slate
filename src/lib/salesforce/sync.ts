import { supabaseAdmin } from "@/lib/supabase/admin";
import { ensureDefaultOrg } from "@/lib/provision";
import { sfClientId, sfClientSecret, sfInstanceUrl } from "@/lib/env";
import { mergeSfAttributes } from "@/lib/salesforce/attributes";
import {
  matchByInitialLastName,
  resolveManagerSync,
} from "@/lib/salesforce/manager-sync";
import { reapableUserIds } from "@/lib/salesforce/reap";
import { chunkRows, groupManagerLinks } from "@/lib/salesforce/sync-batch";
import { fetchSfWithRetry } from "@/lib/salesforce/retry";
import { unwrap } from "@/lib/db/result";
import type { Attributes, Role, User } from "@/lib/db/types";

/**
 * Failure-streak key for the hourly SF roster sync (#486). Shared so the cron
 * lane (which records/clears it) and the admin manual-sync action (#491, which
 * clears it on a successful hand remediation) agree on one key instead of
 * duplicating the literal.
 */
export const AGENTS_SYNC_STREAK_KEY = "cron_agents_failures";

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
  const res = await fetchSfWithRetry(`${sfInstanceUrl()}/services/oauth2/token`, {
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
    const res = await fetchSfWithRetry(url, {
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

/**
 * Returns the subset of `emails` whose Salesforce User is explicitly inactive
 * (IsActive = false). Emails with no Salesforce match are NOT returned, so the
 * caller keeps them — only a positive inactive signal triggers reaping.
 * Chunked to keep each SOQL IN list well under Salesforce's query limits.
 */
async function queryInactiveEmails(
  instanceUrl: string,
  token: string,
  emails: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const CHUNK = 200;
  for (let i = 0; i < emails.length; i += CHUNK) {
    const inList = emails
      .slice(i, i + CHUNK)
      .map((e) => `'${e.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`)
      .join(",");
    const rows = await queryAll(
      instanceUrl,
      token,
      `SELECT Email FROM User WHERE IsActive = false AND Email IN (${inList})`,
    );
    for (const r of rows) {
      const em = (r.Email ?? "").toLowerCase();
      if (em) out.add(em);
    }
  }
  return out;
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
  deactivated: number;
  managersCreated: number;
  managersLinked: number;
  managersPromoted: number;
}

/**
 * Syncs active Salesforce agents (with any debt team) into Slate `users`,
 * matched by email. New agents come in bookable=false. Never-logged-in agents
 * and managers whose Salesforce account is INACTIVE are deleted (booking history
 * survives via the agent snapshot on bookings); a user merely absent from the
 * debt-team query is kept. Anyone who has logged in (auth_user_id set) and
 * admins/super admins are never deleted.
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
  // legal_eligible must survive the sync - see mergeSfAttributes). Fail loud
  // (unwrap, #963): a swallowed read error left this null, so every SF agent
  // looked brand new and was re-inserted (the #277 class). An empty roster is a
  // null-safe pass; only a real query error throws.
  const existing = unwrap(
    await db.from("users").select("id, email, attributes").eq("org_id", org.id),
    "sf-existing-agents",
  );
  const byEmail = new Map(
    (existing ?? []).map((u) => {
      const row = u as { id: string; email: string; attributes: Attributes };
      return [row.email.toLowerCase(), row];
    }),
  );

  const inserts: Partial<User>[] = [];
  // Existing-agent field refreshes as upsert rows keyed on the id PK. `org_id`
  // and `email` are the only NOT NULL columns on `users` without a default, so
  // echoing them (unchanged) keeps the phantom insert tuple valid; on conflict
  // only the listed columns are written, so role/bookable/manager_id/etc. are
  // left untouched. Batched (#91) so ~101 agents cost a couple of writes, not a
  // per-row round-trip chain that risks the Workers CPU/time ceiling.
  const updates: Partial<User>[] = [];

  for (const u of sfUsers) {
    const email = (u.Email ?? "").toLowerCase();
    if (!email) continue;
    const attributes = toAttributes(u);
    const current = byEmail.get(email);
    if (current) {
      updates.push({
        id: current.id,
        org_id: org.id,
        email: current.email,
        name: u.Name,
        attributes: mergeSfAttributes(current.attributes, attributes),
      });
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

  const updated = updates.length;
  for (const batch of chunkRows(updates, 200)) {
    const { error } = await db.from("users").upsert(batch, { onConflict: "id" });
    if (error) throw new Error(`SF agent update batch failed: ${error.message}`);
  }

  if (inserts.length) {
    for (const batch of chunkRows(inserts, 200)) {
      const { error } = await db.from("users").insert(batch);
      if (error) throw new Error(`SF agent insert batch failed: ${error.message}`);
    }
  }

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
  // Fail loud (unwrap, #963): a swallowed error here left the id/manager maps
  // empty, so no links resolved and the sync reported a clean run over a broken
  // read.
  const afterInsert = unwrap(
    await db
      .from("users")
      .select("id, email, manager_id, role")
      .eq("org_id", org.id),
    "sf-after-insert",
  );
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
  // override). Self-links are already filtered by resolveManagerSync. Grouped
  // by manager (#91) so every agent gaining the same manager is one write, not
  // one round-trip per agent.
  const pendingLinks: { agentId: string; managerId: string }[] = [];
  for (const link of plan.links) {
    const agentId = idByEmail.get(link.agentEmail);
    const managerId = idByEmail.get(link.managerEmail);
    if (!agentId || !managerId || agentId === managerId) continue;
    if (managerIdByUser.get(agentId) === managerId) continue;
    pendingLinks.push({ agentId, managerId });
  }
  let managersLinked = 0;
  for (const [managerId, agentIds] of groupManagerLinks(pendingLinks)) {
    const { error } = await db
      .from("users")
      .update({ manager_id: managerId })
      .in("id", agentIds);
    if (error) throw new Error(`SF manager link batch failed: ${error.message}`);
    managersLinked += agentIds.length;
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

  // Reap never-logged-in agents AND managers whose Salesforce account is
  // INACTIVE by DEACTIVATING them (not deleting): the row is kept so OOO/booking
  // history attribution survives, and a boomerang rehire can be reactivated.
  // Absence from the active-agent query is NOT grounds for reaping: a user can
  // be active in SF but have no debt-team flag (an OOO approver, or non-sales
  // staff), so we only act on a positive IsActive=false from Salesforce.
  // Admins/super admins and anyone who has logged in (auth_user_id set) are
  // never touched; already-deactivated users are skipped.
  // Fail loud (unwrap, #963): a swallowed error here left reapableRows empty and
  // silently skipped deactivation, so a broken read read as "nothing to reap".
  const reapable = unwrap(
    await db
      .from("users")
      .select("id, email")
      .eq("org_id", org.id)
      .in("role", ["agent", "manager"])
      .is("auth_user_id", null)
      .is("deactivated_at", null),
    "sf-reapable",
  );
  const reapableRows = (reapable ?? []) as { id: string; email: string }[];
  let toDeactivate: string[] = [];
  if (reapableRows.length) {
    const inactive = await queryInactiveEmails(
      instanceUrl,
      token,
      reapableRows.map((u) => u.email.toLowerCase()),
    );
    // Deactivate every SF-inactive reapable user. No "skip OOO-history managers"
    // carve-out anymore: deactivation preserves the row, so attribution holds.
    toDeactivate = reapableUserIds(reapableRows, inactive);
    if (toDeactivate.length) {
      await db
        .from("users")
        .update({ deactivated_at: new Date().toISOString() })
        .in("id", toDeactivate);
    }
  }

  return {
    inserted: inserts.length,
    updated,
    deactivated: toDeactivate.length,
    managersCreated: plan.managersToCreate.length,
    managersLinked,
    managersPromoted,
  };
}
