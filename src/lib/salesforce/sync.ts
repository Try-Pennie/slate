import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeEmail } from "@/lib/auth/email";
import { ensureDefaultOrg } from "@/lib/provision";
import { querySoqlAll, sfToken } from "@/lib/salesforce/rest";
import { mergeSfAttributes } from "@/lib/salesforce/attributes";
import {
  BACKEND_VALUES,
  DEBT_TIER_VALUES,
  type BackendValue,
  type DebtTierValue,
} from "@/lib/routing/attribute-vocabulary";
import { resolveManagerSync } from "@/lib/salesforce/manager-sync";
import {
  exactNameMatch,
  initialLastNameMatch,
  mergeManagerNamePlans,
  planManagerNames,
  splitUnresolvedByAmbiguity,
  type ManagerNamePlan,
  type SfManagerCandidate,
} from "@/lib/salesforce/manager-link";
import { planReap } from "@/lib/salesforce/reap";
import { deactivateUsersByIds } from "@/lib/bookable/routable-write";
import { coverReapDepartures, type ReapCoverageCounts } from "@/lib/salesforce/reap-coverage";
import type { OffboardingSweepPlan } from "@/lib/offboarding/coverage-trigger";
import {
  presenceFromRecords,
  readSalesforceStanding,
  type SalesforcePresence,
} from "@/lib/salesforce/presence";
import {
  planRosterDivergence,
  scanForDivergence,
  type RosterRowForDivergence,
} from "@/lib/salesforce/roster-divergence";
import { chunkRows, groupManagerLinks } from "@/lib/salesforce/sync-batch";
import { chunkSoqlValues, sfInList } from "@/lib/salesforce/soql";
import {
  hasUserIdConflicts,
  planSalesforceUserIds,
  userIdConflictLogFields,
  type SfIdCandidate,
  type SlateRosterRow,
} from "@/lib/salesforce/user-id-link";
import {
  API_ONLY_PROFILE_FIELD,
  partitionApiOnly,
  requireApiOnlyField,
} from "@/lib/salesforce/api-only";
import {
  agentProfileSoql,
  planOnboardingFlip,
  qualifiesForBooking,
  tieredButNotOnSales,
  onSalesWithNoRecordedHold,
  type FlipReason,
} from "@/lib/salesforce/onboarding";
import { applyBookableByUserId, type BookableResult } from "@/lib/bookable/service";
import {
  activationAllowance,
  type ActivationAllowance,
} from "@/lib/bookable/activation-allowance";
import { recordAudit } from "@/lib/audit";
import { isMarkedRedistribute, withMark } from "@/lib/twilio/roster-plan";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import type { Attributes, Role, User } from "@/lib/db/types";
import { withoutPlaceholder } from "@/lib/advisors/real-advisor";

/**
 * Failure-streak key for the hourly SF roster sync (#486). Shared so the cron
 * lane (which records/clears it) and the admin manual-sync action (#491, which
 * clears it on a successful hand remediation) agree on one key instead of
 * duplicating the literal.
 */
export const AGENTS_SYNC_STREAK_KEY = "cron_agents_failures";

/**
 * Which Salesforce checkbox carries each routing value (#1874).
 *
 * IT NO LONGER WRITES ANYTHING (#2152). Twilio is the source of an agent's debt
 * tiers and backend service, and these booleans survive for the one job they still
 * do: deciding WHICH Salesforce records are in scope. The query admits anybody on
 * an agent profile, plus anybody carrying a tier on any other profile, which is how
 * a tiered manager stays in the roster. Dropping them would have changed who Slate
 * syncs at all, which is a different question from who routing matches, so it was
 * left exactly as it was.
 *
 * A `Record` over the vocabulary rather than a list of pairs, so tsc requires
 * exactly one field per value: a value routing has never heard of is rejected,
 * and a value routing DOES match on cannot be left out.
 */
const DEBT_FIELD: Record<DebtTierValue, keyof SfUser> = {
  ultra_high: "UltraHighDebt__c",
  very_high: "VeryHighDebt__c",
  high: "HighDebt__c",
  medium: "MediumDebt__c",
  low: "LowDebt__c",
};
const BACKEND_FIELD: Record<BackendValue, keyof SfUser> = {
  beyond: "BeyondBackendServicer__c",
  achieve: "AchieveBackendServicer__c",
};

interface SfUser {
  /**
   * The Salesforce `User.Id`: the stable cross system key (#1587). Optional here
   * because not every one of this file's queries asks for it, and a record that
   * arrives without one simply contributes no candidate.
   */
  Id?: string | null;
  Email: string | null;
  Name: string | null;
  /**
   * Asked for only by the presence query (#1833), which is the one place that
   * needs to tell "Salesforce holds them and they have left" apart from
   * "Salesforce holds them and the roster criteria no longer match them".
   */
  IsActive?: boolean;
  FirstName?: string | null;
  LastName?: string | null;
  /**
   * `PermissionsApiUserOnly` is selected by EVERY query in this file (#3669): it is
   * what marks an integration account, which is never a person and must never
   * answer for one. See `api-only.ts`.
   */
  Profile?: { Name?: string; PermissionsApiUserOnly?: boolean | null } | null;
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

/**
 * The API only integration accounts one run left out of its matching (#3669),
 * keyed by Salesforce `User.Id`, with the address each one carried. The address is
 * held only to count how many of them collide with a Slate roster row; it is never
 * logged (L222).
 */
type ApiOnlyExclusions = Map<string, string>;

/**
 * The shared paginated query, typed to this file's record shape (#2593), with
 * API only integration accounts taken out of every answer (#3669).
 *
 * It is the ONLY way this file queries Salesforce, so no query feeding the roster,
 * the manager names, the cross system key or the presence read can see an
 * integration account, and it refuses a query that does not select the flag that
 * marks one, which would otherwise hand back records that all read as people.
 * What it took out is recorded in `excluded` so the run can count it.
 */
async function queryPeople(
  instanceUrl: string,
  token: string,
  soql: string,
  excluded: ApiOnlyExclusions,
): Promise<SfUser[]> {
  requireApiOnlyField(soql);
  const rows = await querySoqlAll<SfUser>(instanceUrl, token, soql);
  const { people, apiOnly } = partitionApiOnly(rows);
  for (const r of apiOnly) {
    const id = (r.Id ?? "").trim() || `unidentified-${excluded.size + 1}`;
    excluded.set(id, normalizeEmail(r.Email ?? ""));
  }
  return people;
}

/**
 * What Salesforce holds for each of `emails`: whether it has an ACTIVE record, an
 * INACTIVE one, or (by being absent from the map) no record at all.
 *
 * ONE query shape answering both readers (#1833). It used to ask only
 * `IsActive = false`, which is all the reap needs, and an address missing from
 * that answer meant either "active" or "Salesforce has never heard of them" with
 * no way to tell the two apart. The reconcile below needs exactly that
 * distinction, so the question is asked once, in full, and each caller reads the
 * part it needs: a second query would be the same question twice, one Salesforce
 * call more, and two places for the escaping and chunking to drift (L370).
 *
 * It asks for the record `Id` as well (#2387), because an address can answer to
 * more than one Salesforce user and the id is the only thing that can say which of
 * them a given Slate row is about. Without it the reap deactivated a rehire on the
 * strength of the old record left inactive beside their new active one, in the same
 * run that wrote their row from the active one.
 *
 * Chunked by ENCODED length rather than by a row count (#1587, L81): the limit
 * that refuses an oversized query is Salesforce's byte cap on the REST GET URI,
 * and the list is percent encoded by the time it meets that cap, so a count of
 * rows is not the unit the limit is expressed in.
 */
async function queryPresenceByEmail(
  instanceUrl: string,
  token: string,
  emails: string[],
  excluded: ApiOnlyExclusions,
): Promise<Map<string, SalesforcePresence>> {
  const records: { email: string; isActive: boolean; recordId: string | null }[] = [];
  for (const chunk of chunkSoqlValues(emails)) {
    // An ACTIVE integration account beside a departed person's inactive record
    // would read address wide as a refusal and keep the leaver in the roster, so
    // this read leaves them out like every other (#3669).
    const rows = await queryPeople(
      instanceUrl,
      token,
      `SELECT Id, Email, ${API_ONLY_PROFILE_FIELD}, IsActive FROM User WHERE Email IN (${sfInList(chunk)})`,
      excluded,
    );
    for (const r of rows) {
      records.push({
        email: r.Email ?? "",
        isActive: r.IsActive === true,
        recordId: r.Id ?? null,
      });
    }
  }
  return presenceFromRecords(records);
}

/**
 * The (email, Salesforce Id) pairs a Salesforce response contributes (#1587).
 *
 * Every query in this file that asks for `Id` feeds the same candidate pool, so
 * one record showing up in two of them is deduplicated by the planner rather than
 * read as two people sharing an address.
 */
function idCandidates(rows: SfUser[]): SfIdCandidate[] {
  const out: SfIdCandidate[] = [];
  for (const r of rows) {
    const email = normalizeEmail(r.Email ?? "");
    const salesforceUserId = (r.Id ?? "").trim();
    if (email && salesforceUserId) out.push({ email, salesforceUserId });
  }
  return out;
}

/**
 * One Salesforce record as the manager-name planner needs to see it (#1653).
 *
 * The two name queries ask for different fields (the exact pass asks for `Name`,
 * the fallback for `FirstName`/`LastName`), so each candidate carries whichever it
 * has and the matcher decides which it needs. The Id rides along because it is
 * what tells the same record arriving twice apart from two people sharing a name.
 */
function toManagerCandidate(u: SfUser): SfManagerCandidate {
  return {
    name: u.Name ?? "",
    firstName: u.FirstName ?? "",
    lastName: u.LastName ?? "",
    email: u.Email ?? "",
    salesforceRecordId: (u.Id ?? "").trim() || null,
  };
}

/**
 * The attributes SALESFORCE owns, which since #2152 is the profile and nothing
 * else.
 *
 * `debt_team` and `backend_service` used to be built here from the checkboxes
 * above. They come from the agent's Twilio TaskRouter tags now, which is what
 * feeds cal.com, so the two systems can no longer disagree about a fact one of
 * them was only ever a second copy of. Everything Twilio does not carry stays
 * here: the profile, and manager of record (#2099).
 */
function toAttributes(u: SfUser): Attributes {
  const attrs: Attributes = {};
  if (u.Profile?.Name) attrs.role = u.Profile.Name;
  return attrs;
}

export interface SyncResult {
  inserted: number;
  updated: number;
  deactivated: number;
  /**
   * What moving the departed advisors' calls came to (#1678), one count per advisor the
   * reap's write departed: a sweep queued, nothing to move, or an enqueue that failed. A
   * failure leaves the departure standing and is backstopped by the inactive agent
   * monitor's page.
   */
  departureCoverage: ReapCoverageCounts;
  /**
   * Reapable rows the reap REFUSED to act on, because their address answers to
   * more than one Salesforce record and nothing stored says which is theirs
   * (#2387).
   *
   * Counted because deactivating NOBODY in silence and deactivating the WRONG
   * person look identical from outside a run (L98). It pages beside
   * `salesforceIdAmbiguous`, which is the same shared address reaching a different
   * decision, and the remedy is the same one: open Salesforce and decide which
   * record is the person.
   */
  deactivationsRefusedAmbiguous: number;
  /**
   * Hires created this run who do not yet qualify to book (#2071): on the Chatter
   * Free profile, with no debt team on the row Slate just wrote. Counted because
   * the old rule never created them at all, and a row that exists but is not
   * bookable is the state that needs to be visible rather than inferred.
   *
   * Since #2152 a hire's tiers arrive from Twilio rather than from Salesforce, so
   * a row created here carries none by construction and it is the Twilio half of
   * the same run that writes the first one and asks for the flip.
   */
  createdUntiered: number;
  /**
   * Rows carrying debt teams on a profile that will never make them bookable
   * (#2182).
   *
   * Becoming bookable is the Sales profile alone now, so somebody left on Chatter
   * Free with tiers is waiting on a Salesforce edit nobody has been told is owed.
   * Counted rather than acted on: acting on it is the rule this change removed, and
   * a state only a person can advance out of is invisible unless something says it
   * is waiting (L636).
   */
  tieredNotOnSales: number;
  /**
   * Rows on the Sales profile that are not bookable, not pending, not deactivated
   * and not marked Redistribute, so nothing records why they are held (#2621).
   * Counted, never flipped: the same state is a deliberate hold, and only a person
   * can tell the two apart.
   */
  salesNotBookableUnexplained: number;
  /** Emails made bookable this run because Salesforce moved them to Sales or gave
   *  them a first debt team, through the same gated service the admin toggle uses. */
  bookableFlipped: string[];
  /** Emails whose flip was planned and refused by the activation gate (no Google
   *  calendar yet). They stay marked pending and are retried every run. */
  bookablePending: string[];
  /**
   * Planned for activation and refused because Twilio holds them on Redistribute
   * (#3028). NOT left pending: that refusal would come back every hour for as long
   * as the tag stands. The pending mark is cleared and Slate's Redistribute mark put
   * on in one write, which hands the intent to the Twilio half, whose turn-back-on
   * makes them bookable the hour the tag comes off.
   */
  bookableHeldByTwilio: string[];
  /**
   * Planned for activation and NOT attempted this run, because the allowance was
   * spent (#2302). Nobody here was admitted unread; each keeps the pending mark and
   * is retried next hour. Named rather than counted, because a count cannot be
   * checked against anything: with the addresses, the next run or a person can ask
   * whether these specific agents came through.
   */
  bookableDeferredToNextRun: string[];
  managersCreated: number;
  managersLinked: number;
  /**
   * Links set back to NULL because Salesforce no longer names a manager for that
   * person, or names them as their own (#1474). Reported separately from
   * managersLinked so a converging run is visible as convergence, not as a quiet
   * absence of links.
   */
  managersUnlinked: number;
  /**
   * Agents whose Salesforce manager NAME matched NOBODY, so the sync deliberately
   * left the row alone. Counted because this is the case where doing nothing is
   * correct and therefore invisible.
   *
   * Since #1653 this counts ONLY the no-match refusal. Many matches is
   * `managersAmbiguous`, because the two need opposite things done about them.
   */
  managersUnresolved: number;
  /**
   * Agents whose Salesforce manager NAME matched MORE THAN ONE Salesforce user,
   * so no link was written and any existing one was left alone (#1653).
   *
   * Counted per AGENT rather than per duplicated name, because the number a reader
   * has to act on is how many PEOPLE have no settled approver.
   */
  managersAmbiguous: number;
  /**
   * How many distinct picklist NAMES answered to more than one Salesforce user
   * (#1653). Reported beside the agent count because the two are very different
   * situations at the same agent count: one shared name over a whole team is one
   * Salesforce edit, fifteen shared names is a roster problem, and editing those
   * values is the entire remedy.
   */
  managerNamesAmbiguous: number;
  managersPromoted: number;
  /**
   * The shared cross system rep key (#1587). Every one of these except
   * `salesforceIdsLinked` counts a row the sync deliberately did NOT write, which
   * is precisely the outcome nothing would otherwise report.
   */
  /** Roster rows that gained a Salesforce User Id this run. */
  salesforceIdsLinked: number;
  /** Slate holds one id, Salesforce now names another. Reported, never rewritten. */
  salesforceIdDisagreements: number;
  /** More than one Salesforce user matched, so no id was stored (L521). */
  salesforceIdAmbiguous: number;
  /** The resolved id is already held by another Slate row, so no id was stored. */
  salesforceIdClaimed: number;
  /** Roster rows with no id that Salesforce could not resolve at all. */
  salesforceIdsUnresolved: number;

  /**
   * The rows Salesforce did NOT confirm this run (#1833).
   *
   * All five count a row the sync deliberately did not write, which is the outcome
   * nothing else can report: the roster query simply does not return these people,
   * so before this the run was indistinguishable from one where everybody was
   * refreshed. Nothing here CLEARS anything; see `roster-divergence.ts` for why
   * recording beats clearing.
   */
  /** In scope rows reconciled against Salesforce. Zero means a broken read, not a clean one. */
  rosterRowsReconciled: number;
  /** Unconfirmed because Salesforce holds their record and reports IsActive = false. */
  rosterUnconfirmedInactive: number;
  /**
   * Unconfirmed because Salesforce holds them, active, and the roster query no
   * longer matches them. This is #1833's own case: clearing somebody's balance
   * tier flags is how they are taken off rotation, and it drops them out of the
   * query instead of updating them.
   */
  rosterUnconfirmedUnmatched: number;
  /** Unconfirmed because Salesforce returned no record at all for their address. */
  rosterUnconfirmedAbsent: number;
  /**
   * Unconfirmed, and nothing could be concluded about them: the address answers
   * to Salesforce records that disagree and no stored key says which is theirs
   * (#2387). Not a fourth verdict but a refusal, and the same one the reap reaches
   * about the same address, since both read it through `readSalesforceStanding`.
   */
  rosterUnconfirmedAmbiguous: number;
  /**
   * The unconfirmed rows that are still BOOKABLE, by email.
   *
   * Separated from the counts because it is the only part that misroutes a lead:
   * Slate goes on routing to somebody whose Salesforce record says they should not
   * be taking calls. It is what pages; the counts are read in the log.
   */
  rosterUnconfirmedBookable: string[];
}

/**
 * The side effects of making somebody bookable, injectable so the planner's
 * decision can be tested through the sync without a live Google probe (#2071).
 */
export interface SyncDeps {
  applyBookable: (userId: string, bookable: boolean) => Promise<BookableResult>;
  recordAudit: typeof recordAudit;
  nowIso: () => string;
  /**
   * How many activations this ROSTER RUN may still attempt (#2302), shared with the
   * Twilio half so the two cannot each spend the whole budget. A caller that omits
   * it gets a fresh one, which is right for a standalone run and for a test.
   */
  allowance: ActivationAllowance;
  /**
   * The offboarding coverage a departure owes (#1678): the lifecycle API's own
   * `coverDeparture`, so a leaver the reap departs has their calls moved exactly as one
   * the offboarding automation departs. Loaded on first use, so a sync that departs
   * nobody never loads the booking service behind it.
   */
  coverDeparture: (plan: OffboardingSweepPlan) => Promise<"queued" | "none" | "failed">;
}

const defaultSyncDeps = (): SyncDeps => ({
  applyBookable: (userId, bookable) => applyBookableByUserId(userId, bookable),
  recordAudit,
  nowIso: () => new Date().toISOString(),
  allowance: activationAllowance(),
  coverDeparture: async (plan) => (await (await import("@/lib/offboarding/service")).coverDeparture(plan)).coverageSweep,
});

/** One planned flip, carried from the roster loop to the attempt after inserts. */
interface PlannedFlip {
  email: string;
  reason: FlipReason;
  attributes: Attributes;
  /** Known for an existing row; resolved after the insert re-read for a new one. */
  userId: string | null;
}

/**
 * Syncs active Salesforce agents into Slate `users`, matched by email: anybody
 * on the Sales or Chatter Free profile, plus anybody carrying a debt team on any
 * other profile (#2071). New agents come in bookable=false, and become bookable
 * automatically the first time Salesforce moves them to Sales or gives them a
 * debt team (see `onboarding.ts` for the rule and why it is a transition, never a
 * level). Never-logged-in agents
 * and managers whose Salesforce account is INACTIVE are deleted (booking history
 * survives via the agent snapshot on bookings); a user merely absent from the
 * debt-team query is kept. Anyone who has logged in (auth_user_id set) and
 * admins/super admins are never deleted.
 */
export async function syncSalesforceAgents(over: Partial<SyncDeps> = {}): Promise<SyncResult> {
  // A PARTIAL override rather than the whole set, so the one caller that needs to
  // hand in the run's shared activation allowance (#2302) does not also have to
  // reconstruct every other collaborator, and so no test has to mock a defaults
  // factory it does not care about.
  const deps: SyncDeps = { ...defaultSyncDeps(), ...over };
  const { token, instanceUrl } = await sfToken();
  // The SELECT and the WHERE are derived from the same two field maps, so a field
  // added for a new tier is queried by construction rather than by remembering two
  // places. Since #2152 they decide only WHO is in scope: the values themselves
  // come from Twilio.
  const debtFields = DEBT_TIER_VALUES.map((v) => DEBT_FIELD[v]);
  const backendFields = BACKEND_VALUES.map((v) => BACKEND_FIELD[v]);
  const debtFilter = debtFields.map((f) => `${f}=true`).join(" OR ");
  const soql =
    `SELECT Id, Email, Name, Profile.Name, ${API_ONLY_PROFILE_FIELD}, Agent_Manager__c, ` +
    `${debtFields.join(", ")}, ` +
    `${backendFields.join(", ")} FROM User ` +
    // Profiles first, tiers second (#2071): a hire on Chatter Free has no tier
    // yet and is exactly the person this used to leave with no Slate row at all.
    `WHERE IsActive = true AND Email != null AND (${agentProfileSoql()} OR ${debtFilter})`;

  // Every API only integration account this run's queries returned and left out
  // (#3669), so the run can say how many. An integration account carrying a tier
  // never becomes a Slate row either: it is not a person who can take a call.
  const apiOnlyExcluded: ApiOnlyExclusions = new Map();
  const sfUsers = await queryPeople(instanceUrl, token, soql, apiOnlyExcluded);
  const db = supabaseAdmin();
  const org = await ensureDefaultOrg();

  // Every (email, Salesforce Id) pair this run observes, from whichever query
  // happened to return it (#1587). Collected as the queries run rather than
  // re-queried at the end, so the common case costs no extra Salesforce call.
  const sfIdCandidates: SfIdCandidate[] = idCandidates(sfUsers);

  // Existing Slate agents by email (attributes too: Slate-managed keys like
  // the Twilio owned keys must survive the sync, see mergeSfAttributes). Fail loud
  // (unwrap, #963): a swallowed read error left this null, so every SF agent
  // looked brand new and was re-inserted (the #277 class). An empty roster is a
  // null-safe pass; only a real query error throws.
  //
  // #4201: the placeholder advisor is a Slate row no Salesforce user stands behind.
  // It is READ here, so its address is known and the loop below can leave it alone;
  // excluded from the read, an address Salesforce also held would look brand new
  // and be inserted as a second row. Every later read leaves it out entirely.
  const existing = unwrap(
    // any-advisor-ok: the placeholder is kept so its address is recognised and skipped below.
    await db
      .from("users")
      .select("id, email, attributes, salesforce_user_id, bookable, deactivated_at, bookable_pending_since, is_placeholder")
      .eq("org_id", org.id),
    "sf-existing-agents",
  );
  type ExistingRow = {
    id: string;
    email: string;
    attributes: Attributes;
    bookable?: boolean | null;
    deactivated_at?: string | null;
    bookable_pending_since?: string | null;
    is_placeholder?: boolean | null;
  };
  const placeholderEmails = new Set<string>();
  const byEmail = new Map(
    (existing ?? []).flatMap((u) => {
      const row = u as ExistingRow;
      if (row.is_placeholder === true) {
        placeholderEmails.add(normalizeEmail(row.email));
        return [];
      }
      return [[normalizeEmail(row.email), row] as const];
    }),
  );

  // #2071: who this run should try to make bookable. Decided row by row from the
  // attributes Slate HELD against the ones Salesforce holds now, before either is
  // written, and the pending mark travels in the SAME write as the new attributes.
  // That ordering is the crash safety: a run that dies after writing attributes
  // and before attempting the flip has already left the mark, so the next hour
  // retries rather than seeing tiers against tiers and doing nothing.
  const flips: PlannedFlip[] = [];
  const nowIso = deps.nowIso();
  let createdUntiered = 0;
  let tieredNotOnSales = 0;
  let salesNotBookableUnexplained = 0;

  const inserts: Partial<User>[] = [];
  // Existing-agent field refreshes as upsert rows keyed on the id PK. `org_id`
  // and `email` are the only NOT NULL columns on `users` without a default, so
  // echoing them (unchanged) keeps the phantom insert tuple valid; a column NO
  // ROW names is left untouched, which is what keeps role/bookable/manager_id out
  // of this write. Batched (#91) so ~101 agents cost a couple of writes, not a
  // per-row round-trip chain that risks the Workers CPU/time ceiling.
  //
  // **EVERY ROW IN THE BATCH CARRIES THE SAME KEYS** (#2381), and that is a rule
  // about the write rather than a tidiness preference. PostgREST takes the column
  // list of a bulk payload as the UNION of the keys across every row, NULL-fills a
  // row that omits one of them (supabase-js `defaultToNull`, its default), and then
  // writes every column of that list in ON CONFLICT DO UPDATE SET col =
  // EXCLUDED.col. So a key set on ONE row is not a column written for that row: it
  // is a NULL written over every row without it. This comment used to say "on
  // conflict only the listed columns are written", which is true of a single row
  // and false of a batch, and one conditionally assigned `bookable_pending_since`
  // erased the pending activation mark of every OTHER hire in the same hour.
  const updates: Partial<User>[] = [];

  for (const u of sfUsers) {
    const email = normalizeEmail(u.Email ?? "");
    if (!email || placeholderEmails.has(email)) continue;
    const attributes = toAttributes(u);
    const current = byEmail.get(email);
    if (current) {
      const plan = planOnboardingFlip({
        prev: current.attributes ?? {},
        next: attributes,
        bookable: current.bookable === true,
        deactivated: current.deactivated_at != null,
        pending: current.bookable_pending_since != null,
      });
      // #2182: carrying tiers and not on Sales, so nothing will ever flip them.
      // Read from the MERGED row, because the tiers come from Twilio now.
      const merged = mergeSfAttributes(current.attributes, attributes);
      if (tieredButNotOnSales(merged)) tieredNotOnSales += 1;
      // #2621: judged AFTER this run's plan, so a row this run is about to flip
      // (and mark pending) is not also reported as unexplained.
      if (
        plan.action === "none" &&
        onSalesWithNoRecordedHold({
          attributes: merged,
          bookable: current.bookable === true,
          deactivated: current.deactivated_at != null,
          pending: current.bookable_pending_since != null,
          markedRedistribute: isMarkedRedistribute(merged),
        })
      ) {
        salesNotBookableUnexplained += 1;
      }
      const row: Partial<User> = {
        id: current.id,
        org_id: org.id,
        email: normalizeEmail(current.email),
        name: u.Name,
        attributes: merged,
        // Present on EVERY row, at its CURRENT value, for the reason in the comment
        // above the loop: a key only some rows carry is a NULL written over all the
        // rest. A fresh transition is marked now; everybody else is written back
        // what they already hold, which for most rows is the null they already have.
        //
        // Chosen over writing the marks in a SECOND statement after the batch
        // (#2381 offered both) because this is the form that keeps the crash safety
        // the block above rests on: the mark and the attributes reach the database
        // in ONE write, so no crash can land between them. Two statements would open
        // exactly the window this issue is about, a run that wrote the attributes
        // and died before the mark, leaving tiers against tiers with nothing to say
        // anybody wanted a flip. It also costs no extra read: the pre-write roster
        // read above already selects `bookable_pending_since`.
        bookable_pending_since:
          plan.action === "flip" && plan.reason !== "retry"
            ? nowIso
            : (current.bookable_pending_since ?? null),
      };
      if (plan.action === "flip") {
        // The MERGED attributes, not the Salesforce ones, because the audit row
        // names the debt teams and since #2152 those come from Twilio. Passing the
        // Salesforce half alone would write an empty tier list into the trail for
        // an agent who plainly has tiers.
        flips.push({ email, reason: plan.reason, attributes: row.attributes as Attributes, userId: current.id });
      }
      updates.push(row);
    } else {
      const plan = planOnboardingFlip({
        prev: null,
        next: attributes,
        bookable: false,
        deactivated: false,
        pending: false,
      });
      if (!qualifiesForBooking(attributes)) createdUntiered += 1;
      inserts.push({
        org_id: org.id,
        email,
        name: u.Name,
        role: "agent",
        attributes,
        bookable: false,
        // Named on every row here too, under the same rule as the refresh batch
        // above. An INSERT is the harmless case of it (the NULL that PostgREST
        // fills in for an omitted key is what the column defaults to anyway), so
        // this changes nothing that reaches the database; it is written out so the
        // file holds ONE rule about a bulk payload rather than a rule and an
        // exception a reader has to re-derive the safety of.
        bookable_pending_since: plan.action === "flip" ? nowIso : null,
      });
      if (plan.action === "flip") flips.push({ email, reason: plan.reason, attributes, userId: null });
    }
  }

  // A pending mark on a row this run's roster did not mention (the person's
  // Salesforce record dropped out of the query between the mark and the retry) is
  // still an intent nobody settled. Retried here so it cannot sit forever; the
  // planner's own deactivated and bookable checks still apply.
  const seen = new Set(sfUsers.map((u) => normalizeEmail(u.Email ?? "")));
  for (const [email, row] of byEmail) {
    if (seen.has(email)) continue;
    const plan = planOnboardingFlip({
      prev: row.attributes ?? {},
      next: row.attributes ?? {},
      bookable: row.bookable === true,
      deactivated: row.deactivated_at != null,
      pending: row.bookable_pending_since != null,
    });
    if (plan.action === "flip") flips.push({ email, reason: plan.reason, attributes: row.attributes ?? {}, userId: row.id });
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
  //
  // Exactly one Salesforce user answering to the name LINKS. Zero and many are
  // both refusals, and they are DIFFERENT refusals (#1653, L521, L11): before
  // this, many matches kept the first record and discarded the rest with no
  // record at all, which is a coin flip deciding who approves somebody's time
  // off while every surface downstream reads as healthy. The decision itself is
  // pure and lives in `manager-link.ts`.
  let namePlan: ManagerNamePlan = {
    resolved: new Map<string, string>(),
    ambiguous: [],
    unmatched: [],
  };
  if (managerNames.length) {
    const mgrRecords = await queryPeople(
      instanceUrl,
      token,
      `SELECT Id, Name, Email, ${API_ONLY_PROFILE_FIELD} FROM User WHERE Name IN (${sfInList(managerNames)}) AND Email != null`,
      apiOnlyExcluded,
    );
    sfIdCandidates.push(...idCandidates(mgrRecords));
    namePlan = planManagerNames(
      managerNames,
      mgrRecords.map(toManagerCandidate),
      exactNameMatch,
    );
  }

  // Fallback for informal picklist names (e.g. "Mike Dugan" vs the user
  // "Michael Dugan"): match by last name + first initial, but only when exactly
  // one active user matches, so it never links to the wrong person.
  //
  // It sees ONLY names the exact pass matched NOTHING at all for. An ambiguous
  // name is a refusal, and retrying a refusal with a matcher that needs LESS
  // evidence is exactly the "aim at a nearby candidate" failure the refusal
  // exists to prevent (L75). It would also be silent: the weaker match would
  // overturn the stronger refusal and nothing would say so.
  if (namePlan.unmatched.length) {
    const lastNames = [
      ...new Set(
        namePlan.unmatched
          .map((n) => n.trim().split(/\s+/).pop() ?? "")
          .filter(Boolean),
      ),
    ];
    const nameRows = await queryPeople(
      instanceUrl,
      token,
      `SELECT Id, FirstName, LastName, Email, ${API_ONLY_PROFILE_FIELD} FROM User WHERE IsActive = true AND Email != null AND LastName IN (${sfInList(lastNames)})`,
      apiOnlyExcluded,
    );
    sfIdCandidates.push(...idCandidates(nameRows));
    namePlan = mergeManagerNamePlans(
      namePlan,
      planManagerNames(
        namePlan.unmatched,
        nameRows.map(toManagerCandidate),
        initialLastNameMatch,
      ),
    );
  }
  const nameToEmail = namePlan.resolved;
  const ambiguousNames = namePlan.ambiguous.map((a) => a.name);

  // Resolve agent->manager and create any manager who isn't already a Slate
  // user so manager_id can reference them. Managers come in role='manager',
  // bookable=false (they approve, they don't take bookings); if they later log
  // in, provision keeps that role.
  const plan = resolveManagerSync(
    sfUsers.map((u) => {
      const mgrName = (u.Agent_Manager__c ?? "").trim();
      return {
        email: normalizeEmail(u.Email ?? ""),
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
  //
  // Without the placeholder (#4201), so no manager link, promotion, Salesforce id or
  // divergence finding can ever name it.
  const afterInsert = unwrap(
    await withoutPlaceholder(
      db
        .from("users")
        // `bookable`, `deactivated_at` and `is_test` are here for the reconcile at
        // the end (#1833), which needs to know who is in scope and who is still
        // routable. Same read, no extra round trip.
        .select("id, email, manager_id, role, salesforce_user_id, bookable, deactivated_at, is_test")
        .eq("org_id", org.id),
    ),
    "sf-after-insert",
  );
  const idByEmail = new Map(
    (afterInsert ?? []).map((u) => {
      const row = u as { id: string; email: string };
      return [normalizeEmail(row.email), row.id];
    }),
  );
  const managerIdByUser = new Map(
    (afterInsert ?? []).map((u) => {
      const row = u as { id: string; manager_id: string | null };
      return [row.id, row.manager_id];
    }),
  );

  // #2071: attempt every planned flip through the SAME service the admin toggle
  // uses, so the activation gate (no Google calendar means refused and alerted,
  // never a silent admit), the log line and the pool bookkeeping all apply. A
  // refusal leaves the pending mark in place for next hour; a success clears it
  // inside `writeBookable`, as does any later human decision either way.
  const bookableFlipped: string[] = [];
  const bookablePending: string[] = [];
  const bookableHeldByTwilio: string[] = [];
  /** Planned, not attempted this run, because the allowance was spent. */
  const bookableDeferredToNextRun: string[] = [];
  for (const flip of flips) {
    const userId = flip.userId ?? idByEmail.get(flip.email) ?? null;
    if (!userId) {
      // The insert re-read did not return them, which the batch insert above would
      // have thrown on. Said rather than skipped, because a planned flip that
      // quietly evaporates is the shape this whole change exists to end.
      log.warn("agents", { msg: "planned flip has no row", email: flip.email, reason: flip.reason });
      bookablePending.push(flip.email);
      continue;
    }
    if (!deps.allowance.take()) {
      // Left for next hour rather than admitted unread. Their pending mark went in
      // with their attributes above, so nothing has to be remembered here.
      bookableDeferredToNextRun.push(flip.email);
      continue;
    }
    const result = await deps.applyBookable(userId, true);
    if (result.status === "applied") {
      bookableFlipped.push(flip.email);
      // Actor null: an operator process, not a signed in person. The details say
      // which Salesforce change did it, so the trail answers "who made them
      // bookable" with "Salesforce did, by moving them to Sales" rather than a
      // blank. The debt teams beside it are the ones the row will actually route
      // on, which since #2152 came from Twilio rather than from this sync.
      await deps.recordAudit({
        orgId: org.id,
        actorId: null,
        action: "agent.bookable",
        targetUserId: userId,
        details: {
          bookable: true,
          via: "salesforce-sync",
          reason: flip.reason,
          debt_team: flip.attributes.debt_team ?? [],
          profile: flip.attributes.role ?? null,
        },
      });
    } else if (result.status === "blocked" && result.reason === "twilio_redistribute") {
      // #3028: handed to the Twilio half rather than retried here. ONE write, so no
      // crash can leave the row with neither mark (nobody would ever flip them) or
      // with both (the retry would come back every hour). Built over the row's
      // attributes as this run wrote them, so the routing facts ride along.
      const { error } = await db
        .from("users")
        .update({ attributes: withMark(flip.attributes, nowIso), bookable_pending_since: null })
        .eq("id", userId);
      if (error) throw new Error(`SF redistribute hold failed: ${error.message}`);
      bookableHeldByTwilio.push(flip.email);
      log.info("agents", { msg: "activation held by the Twilio Redistribute tag, handed to the Twilio sync", user_id: userId });
    } else if (result.status === "blocked") {
      bookablePending.push(flip.email);
    } else if (result.status === "noop") {
      // Already bookable, so the intent is settled and the mark is stale. Cleared
      // here because nothing was written for a noop, so nothing else will.
      const { error } = await db
        .from("users")
        .update({ bookable_pending_since: null })
        .eq("id", userId);
      if (error) throw new Error(`SF pending clear failed: ${error.message}`);
    }
  }

  // Apply links; only write when the value actually changes. Grouped by manager
  // (#91) so every agent gaining the same manager is one write, not one round-trip
  // per agent.
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

  // Converge, do not accumulate (#1474). This sync only ever ADDED a link, so one
  // written once (or written wrongly) survived forever and Slate's roster silently
  // diverged from the source it mirrors. Two live rows proved it: a manager whose
  // manager of record was one of his own agents, and a row pointing at itself.
  // Since `manager_id` decides who a time off request is routed to and who may
  // approve it, a stale link hands somebody else's decision to the wrong person.
  //
  // Three things this deliberately does NOT clear, because each would be a guess:
  //  - an agent whose Salesforce manager NAME could not be resolved to a Slate
  //    user (plan.unresolved): could-not-resolve is not no-manager, and treating it
  //    as one would delete a correct link whenever a picklist name went ambiguous;
  //  - anyone absent from the Salesforce response, since this sync queries only
  //    debt-team agents and knows nothing about the rest of the roster;
  //  - a row that is already null, so a quiet hour writes nothing at all.
  const pendingClears = plan.clears
    .map((email) => idByEmail.get(email))
    .filter((id): id is string => !!id && managerIdByUser.get(id) != null);
  let managersUnlinked = 0;
  if (pendingClears.length) {
    const { error } = await db
      .from("users")
      .update({ manager_id: null })
      .in("id", pendingClears);
    if (error) throw new Error(`SF manager unlink batch failed: ${error.message}`);
    managersUnlinked = pendingClears.length;
  }
  // The two refusals, said separately (#1653, L11). `resolveManagerSync` sees
  // only "Salesforce named a manager and we have no email for them", which is the
  // same value for both, so the split is made here against the names the planner
  // refused. One number covering both would tell a reader neither: an unmatched
  // name is a picklist value somebody can correct in a minute, a shared name may
  // be pointing an approval at the wrong person.
  const managerRefusals = splitUnresolvedByAmbiguity(plan.unresolved, ambiguousNames);
  if (managerRefusals.missing.length) {
    // The case where the sync deliberately does nothing. Logged because an
    // unresolvable manager name and an agent who genuinely has no manager are
    // otherwise the same silence, and this one is a config gap somebody can fix.
    log.warn("sf-sync", {
      msg: "manager name matched no Salesforce user, link left unchanged",
      count: managerRefusals.missing.length,
      names: [...new Set(managerRefusals.missing)].slice(0, 10).join(", "),
    });
  }
  if (managerRefusals.ambiguous.length) {
    // Distinct wording, because this one is not a gap: the name is there and it
    // answers to more than one person, so nothing here can say which of them
    // approves this rep's time off. The picklist VALUES are named (they are
    // Salesforce config, and the whole remedy is editing them); the people are
    // not, so a log search does not become a roster export (L222).
    log.warn("sf-sync", {
      msg: "manager name matched more than one Salesforce user, link left unchanged",
      agents: managerRefusals.ambiguous.length,
      names: namePlan.ambiguous
        .map((a) => `${a.name} (${a.matchCount})`)
        .slice(0, 10)
        .join(", "),
    });
  }

  // Anyone SF lists as an Agent_Manager (a real approver) becomes a Slate
  // 'manager' so they can open the queue and approve - even if they're also a
  // debt-team agent. Admins keep their role; this never demotes.
  const managerEmails = new Set(plan.links.map((l) => l.managerEmail));
  const toPromote = (afterInsert ?? [])
    .map((u) => u as { id: string; email: string; role: Role })
    .filter(
      (u) => u.role === "agent" && managerEmails.has(normalizeEmail(u.email)),
    )
    .map((u) => u.id);
  const managersPromoted = await promoteToManager(db, toPromote);

  // ---------------------------------------------------------------------------
  // The shared cross system rep key (#1587).
  //
  // Read from `afterInsert` rather than `existing`, so an agent or manager
  // inserted moments ago in this same run is linked on the run that created them
  // instead of waiting an hour.
  const rosterRows: SlateRosterRow[] = (afterInsert ?? []).map((u) => {
    const row = u as {
      id: string;
      email: string;
      salesforce_user_id: string | null;
    };
    return {
      id: row.id,
      email: row.email,
      salesforceUserId: row.salesforce_user_id ?? null,
    };
  });

  // One extra query, for the roster rows none of the queries above happened to
  // return. It is what makes this a BACKFILL rather than a rule that only ever
  // applies to debt team agents: measured against the live org on 2026-08-31, the
  // debt team query resolves 104 of 118 active users, and the remaining 14
  // (managers, admins, the team lead) are reachable only this way. Restricted to
  // IsActive = true to match the rest of this sync, whose reap step already acts
  // on a positive IsActive = false.
  //
  // It costs one Salesforce call at this roster size and shrinks as ids land: a
  // row that already holds the id another query just confirmed is not asked about
  // again.
  const coveredEmails = new Set(sfIdCandidates.map((c) => c.email));
  const remainingEmails = rosterRows
    .map((r) => normalizeEmail(r.email))
    .filter((e) => e && !coveredEmails.has(e));
  for (const chunk of chunkSoqlValues(remainingEmails)) {
    // The query the 2026-10-13 page came through: a staff member outside the debt
    // team query, and an integration account carrying their address (#3669).
    const rows = await queryPeople(
      instanceUrl,
      token,
      `SELECT Id, Email, ${API_ONLY_PROFILE_FIELD} FROM User WHERE IsActive = true AND Email != null AND Email IN (${sfInList(chunk)})`,
      apiOnlyExcluded,
    );
    sfIdCandidates.push(...idCandidates(rows));
  }

  const idPlan = planSalesforceUserIds(rosterRows, sfIdCandidates);
  const emailById = new Map(rosterRows.map((r) => [r.id, r.email]));
  // Written as an upsert on the id PK, like the agent refreshes above: `org_id`
  // and `email` are the only NOT NULL columns without a default, so echoing them
  // unchanged keeps the phantom insert tuple valid while ON CONFLICT writes only
  // the listed columns. Batched, so a whole roster backfill is a couple of writes.
  //
  // Only rows GAINING an id are in this payload. That is what makes "never
  // overwritten, never cleared" a property of the write rather than a promise
  // about it, and it makes the second run of an unchanged roster write literally
  // nothing.
  const idWrites: Partial<User>[] = idPlan.assign.map((a) => ({
    id: a.userId,
    org_id: org.id,
    email: emailById.get(a.userId) ?? a.email,
    salesforce_user_id: a.salesforceUserId,
  }));
  for (const batch of chunkRows(idWrites, 200)) {
    const { error } = await db.from("users").upsert(batch, { onConflict: "id" });
    if (error) {
      throw new Error(`SF user id link batch failed: ${error.message}`);
    }
  }

  if (idPlan.unresolved.length) {
    // Absence, logged rather than paged. A row with no key is a row every consumer
    // correctly REFUSES, which is safe; the three conflict shapes below are the
    // ones where the key we hold may name the wrong human, and wrong is worse than
    // missing. This is the same call the manager-name resolution above makes.
    log.warn("sf-sync", {
      msg: "no Salesforce user id could be resolved for these roster rows",
      count: idPlan.unresolved.length,
      user_ids: idPlan.unresolved.map((u) => u.userId).slice(0, 10).join(", "),
    });
  }
  const idReport = {
    linked: idPlan.assign.length,
    disagreements: idPlan.disagreements.length,
    ambiguous: idPlan.ambiguous.length,
    claimed: idPlan.claimed.length,
    unresolved: idPlan.unresolved.length,
  };
  if (hasUserIdConflicts(idReport)) {
    // The detail goes to the log, not to the alert (#1133): the alert says how
    // many and what to do, and this line is where a reader finds which rows. Slate
    // user ids only, never the person's email or name, so a transcript or a log
    // search does not become a roster export (L222).
    //
    // Every conflict shape names its rows here, the ambiguous one included
    // (#3668): the page points its reader at this line, and for an ambiguous email
    // it used to carry only a count.
    const conflictEntries = userIdConflictLogFields(idPlan);
    const conflictFields: Record<string, number | string> = {};
    // Counts first, then the rows, so the line reads the way it always has.
    for (const entry of conflictEntries) conflictFields[entry.countKey] = entry.count;
    for (const entry of conflictEntries) conflictFields[entry.idsKey] = entry.userIds;
    log.warn("sf-sync", {
      msg: "Salesforce user id conflicts, nothing written for these rows",
      ...conflictFields,
    });
  }

  // Reap never-logged-in agents AND managers whose Salesforce account is
  // INACTIVE by DEACTIVATING them (not deleting): the row is kept so OOO/booking
  // history attribution survives, and a boomerang rehire can be reactivated.
  // Absence from the active-agent query is NOT grounds for reaping: a user can
  // be active in SF but have no debt-team flag (an OOO approver, or non-sales
  // staff), so we only act on a positive IsActive=false from Salesforce.
  // Admins/super admins and anyone who has logged in (auth_user_id set) are
  // never touched; already-deactivated users are skipped.
  // The stored Salesforce id comes with them (#2387): an address can answer to
  // more than one Salesforce record, and the id is the only thing that says which
  // of them is this row's.
  // Fail loud (unwrap, #963): a swallowed error here left reapableRows empty and
  // silently skipped deactivation, so a broken read read as "nothing to reap".
  // The placeholder never signs in and is never in Salesforce, so it is left out
  // here (#4201): whatever Salesforce says of its address, it is never departed.
  const reapable = unwrap(
    await withoutPlaceholder(
      db
        .from("users")
        .select("id, email, salesforce_user_id")
        .eq("org_id", org.id)
        .in("role", ["agent", "manager"])
        .is("auth_user_id", null)
        .is("deactivated_at", null),
    ),
    "sf-reapable",
  );
  const reapableRows = (reapable ?? []) as {
    id: string;
    email: string;
    salesforce_user_id?: string | null;
  }[];

  // ---------------------------------------------------------------------------
  // The rows Salesforce did NOT confirm this run (#1833).
  //
  // Everybody the roster query did not return is simply never written again: no
  // error, no counter, no log line, and the lane reports success every hour. That
  // is how a person taken off rotation goes on being routed to, because clearing
  // their balance tier flags is what takes them off rotation and it drops them out
  // of the query rather than updating them.
  //
  // It RECORDS, it never clears: see `roster-divergence.ts` for why, and for the
  // convention it shares with the Twilio half's `withoutWorker`.
  const divergenceRows: RosterRowForDivergence[] = (afterInsert ?? []).map((u) => {
    const row = u as {
      id: string;
      email: string;
      bookable?: boolean | null;
      deactivated_at?: string | null;
      is_test?: boolean | null;
    };
    return {
      id: row.id,
      email: row.email,
      bookable: row.bookable === true,
      deactivated: row.deactivated_at != null,
      isTest: row.is_test === true,
    };
  });
  // `seen` is the addresses the roster query returned, which is the same set the
  // roster loop above matched rows by, so this asks exactly "which rows did that
  // loop not write".
  const scan = scanForDivergence(divergenceRows, { emails: seen });

  // ONE Salesforce read answers the reap and the reconcile, because they are the
  // same question about overlapping sets of addresses. Asking twice would cost a
  // second call every hour and leave two places for the chunking to drift (L370).
  const presenceEmails = [
    ...new Set(
      [
        ...reapableRows.map((u) => normalizeEmail(u.email)),
        ...scan.candidates.map((c) => c.email),
      ].filter(Boolean),
    ),
  ];
  const presence: Map<string, SalesforcePresence> = presenceEmails.length
    ? await queryPresenceByEmail(instanceUrl, token, presenceEmails, apiOnlyExcluded)
    : new Map();

  if (apiOnlyExcluded.size) {
    // Counted every run it happens, so a real person mis-profiled as an integration
    // is visible here rather than silently missing from the roster (#3669). Info,
    // not warn: an integration account carrying a colleague's address is the
    // expected state, and nothing pages on it. Salesforce ids of the ACCOUNTS (which
    // name a login, not a person), never the address they carry (L222).
    // `roster_matches` is how many of them carry an address a Slate row holds,
    // which is the number that would otherwise have been a conflict.
    const rosterEmails = new Set(
      [...rosterRows.map((r) => normalizeEmail(r.email)), ...reapableRows.map((r) => normalizeEmail(r.email))].filter(
        Boolean,
      ),
    );
    log.info("sf-sync", {
      msg: "left API only Salesforce accounts out of the roster's email matching",
      count: apiOnlyExcluded.size,
      roster_matches: [...apiOnlyExcluded.values()].filter((e) => rosterEmails.has(e)).length,
      salesforce_user_ids: [...apiOnlyExcluded.keys()].slice(0, 10).join(", "),
    });
  }

  // Where each row stands with Salesforce, read ONCE (#2387) and handed to both
  // the reap and the reconcile below. Two readings of a shared address either side
  // of a module boundary is what let one run write a rehire's row from their active
  // record and deactivate them on their old inactive one (L263).
  //
  // This is the only place the stored key and the presence answer meet; the two
  // pure planners never see the column at all, so neither can grow a second idea of
  // what a missing one means (#1587).
  const standingForRow = (email: string, storedId: string | null) =>
    readSalesforceStanding(presence.get(normalizeEmail(email)), storedId);
  const storedSalesforceIdByUserId = new Map<string, string | null>(
    (afterInsert ?? []).map((u) => {
      const row = u as { id: string; salesforce_user_id?: string | null };
      return [row.id, row.salesforce_user_id ?? null];
    }),
  );

  // Deactivate every reapable user Salesforce reports as departed. No "skip
  // OOO-history managers" carve-out anymore: deactivation preserves the row, so
  // attribution holds. What counts as departed is the standing above, which is
  // where the shared address case is decided and refused.
  const reapPlan = planReap(
    reapableRows.map((u) => ({
      id: u.id,
      email: u.email,
      standing: standingForRow(u.email, u.salesforce_user_id ?? null),
    })),
  );
  const toDeactivate = reapPlan.deactivate;
  // The SHARED write (#2386). It used to be an `update({ deactivated_at })` of its
  // own, which left every leaver this reap processed still marked `bookable`: the
  // #1324 defect, on the path #1324 did not touch. Two consequences, and the second
  // is the one that reaches a lead. Every count of the bookable pool overstated it
  // by one per leaver; and a rehire reactivated later re-entered the routing pool
  // the instant the button was pressed, because the calendar probe and the pool
  // entry bootstrap live only on the `bookable` FLIP, which had never happened.
  //
  // It throws on a refused statement rather than reporting `deactivated: N` over a
  // write the database would not make. The reap re-selects its candidates every
  // hour, so the cost of throwing is one retry.
  const departed = await deactivateUsersByIds(toDeactivate, new Date().toISOString());
  // #1678: and their remaining calls move now, by the same offboarding coverage the
  // lifecycle API runs, rather than waiting up to an hour for the inactive agent monitor
  // to page a person. Only the rows this write departed, each under its own stamp.
  const departureCoverage = await coverReapDepartures(departed, deps.coverDeparture);
  if (departed.length > 0) {
    log.info("sf-sync", { msg: "departed advisors' calls handed to the coverage sweep", ...departureCoverage });
  }
  if (reapPlan.refused.length) {
    // Said out loud, because a reap that acted on nobody and a reap that had
    // nothing to do are the same run from outside (L98). Slate user ids only, so a
    // log search does not become a roster export (L222); the COUNT travels in the
    // result, where the alert can name it.
    log.warn("sf-sync", {
      msg: "deactivation refused: a shared Salesforce address with no stored id to settle it",
      count: reapPlan.refused.length,
      user_ids: reapPlan.refused.map((r) => r.userId).slice(0, 10).join(", "),
    });
  }

  const divergence = planRosterDivergence({
    examined: scan.examined,
    candidates: scan.candidates.map((c) => ({
      ...c,
      standing: standingForRow(
        c.email,
        storedSalesforceIdByUserId.get(c.id) ?? null,
      ),
    })),
  });
  if (divergence.rows.length) {
    // The detail goes to the log and the counts go back to the caller, which is
    // the same split the id conflicts above make (#1133). Slate user ids only,
    // never the person's email or name, so a log search does not become a roster
    // export (L222); the bookable ones travel in the result, where the alert that
    // pages on them can name how many there are.
    log.warn("sf-sync", {
      msg: "Salesforce did not confirm these roster rows, and nothing was changed for them",
      reconciled: divergence.examined,
      inactive: divergence.inactive,
      unmatched: divergence.unmatched,
      absent: divergence.absent,
      ambiguous: divergence.ambiguous,
      still_bookable: divergence.bookable.length,
      user_ids: divergence.rows.map((r) => r.userId).slice(0, 10).join(", "),
    });
  }

  return {
    inserted: inserts.length,
    updated,
    deactivated: toDeactivate.length,
    departureCoverage,
    deactivationsRefusedAmbiguous: reapPlan.refused.length,
    createdUntiered,
    tieredNotOnSales,
    salesNotBookableUnexplained,
    bookableFlipped,
    bookablePending,
    bookableHeldByTwilio,
    bookableDeferredToNextRun,
    managersCreated: plan.managersToCreate.length,
    managersLinked,
    managersUnlinked,
    managersUnresolved: managerRefusals.missing.length,
    managersAmbiguous: managerRefusals.ambiguous.length,
    // Only the names an agent actually pointed at: a duplicated name nobody in the
    // roster reports to is not a routing problem and must not page.
    managerNamesAmbiguous: new Set(managerRefusals.ambiguous).size,
    managersPromoted,
    salesforceIdsLinked: idReport.linked,
    salesforceIdDisagreements: idReport.disagreements,
    salesforceIdAmbiguous: idReport.ambiguous,
    salesforceIdClaimed: idReport.claimed,
    salesforceIdsUnresolved: idReport.unresolved,
    rosterRowsReconciled: divergence.examined,
    rosterUnconfirmedInactive: divergence.inactive,
    rosterUnconfirmedUnmatched: divergence.unmatched,
    rosterUnconfirmedAbsent: divergence.absent,
    rosterUnconfirmedAmbiguous: divergence.ambiguous,
    rosterUnconfirmedBookable: divergence.bookable,
  };
}


/**
 * Give everyone Salesforce lists as an approver the `manager` role, and report how
 * many really got it (#2482).
 *
 * Its own function so the rule can be driven at all: the promotion sat inline in a
 * sync that needs a Salesforce client, a roster and a database before it will run,
 * so the one thing worth asserting about it was unreachable.
 *
 * It THROWS rather than counting zero. The count used to be claimed on having
 * reached the line rather than on the write's answer, so a refused update left the
 * run reporting people promoted who are still agents, and the approver who cannot
 * open the time off queue looks like a Slate defect rather than a write that never
 * happened. The roster sync surfaces its other failures the same way.
 */
export async function promoteToManager(
  db: ReturnType<typeof supabaseAdmin>,
  userIds: readonly string[],
): Promise<number> {
  if (userIds.length === 0) return 0;
  const { error } = await db.from("users").update({ role: "manager" }).in("id", [...userIds]);
  if (error) {
    throw new Error(`promoting ${userIds.length} manager(s) failed: ${error.message}`);
  }
  return userIds.length;
}
