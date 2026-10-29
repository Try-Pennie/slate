import { describe, it, expect, vi, beforeEach } from "vitest";

// #91: syncSalesforceAgents must write the roster in batched statements (one
// upsert for existing-agent refreshes, one grouped update per manager) instead
// of one round-trip per user, and the new batched writes must fail loud (throw)
// when the db returns an error rather than silently reporting success. This
// drives the real sync against a fake Salesforce HTTP layer and a fake db that
// records every operation.

const provision = vi.hoisted(() => ({
  ensureDefaultOrg: vi.fn(async () => ({ id: "org1" })),
}));
vi.mock("@/lib/provision", () => provision);
vi.mock("@/lib/env", () => ({
  sfClientId: () => "cid",
  sfClientSecret: () => "sec",
  sfInstanceUrl: () => "https://sf.example",
  // #4379: the fixtures here are on x.com, so it stands in for the company domain.
  googleHostedDomain: () => "x.com",
}));

const sf = vi.hoisted(() => ({ fetchSfWithRetry: vi.fn() }));
vi.mock("@/lib/salesforce/retry", () => sf);

const store = vi.hoisted(() => {
  type Call = {
    op: string;
    table: string;
    select?: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  };
  const calls: Call[] = [];
  const config: {
    existing: unknown[];
    afterInsert: unknown[];
    reapable: unknown[];
    errorOn?: string;
  } = { existing: [], afterInsert: [], reapable: [] };

  /**
   * The stored `users` rows, so a write can be read back as STATE rather than as
   * a recorded payload (#2381).
   *
   * Seeded by `seedUsers`, which is deliberate rather than automatic: a suite that
   * only asks what was SENT keeps working untouched, and one asking what the table
   * now HOLDS says so.
   */
  const users = new Map<string, Record<string, unknown>>();

  /**
   * What PostgREST actually does with a bulk payload, which is NOT what the
   * per-row reading of it suggests (#2381).
   *
   * The column list of a bulk insert or upsert is the UNION of the keys across
   * every object in the array, and a row missing one of those keys has NULL
   * written into it (supabase-js calls this `defaultToNull`, and it is the
   * default). `ON CONFLICT DO UPDATE` then sets every column in that list from
   * the excluded tuple. So one row carrying a key the others omit does not write
   * that column for itself alone: it writes NULL over it on all the rest.
   *
   * Modelling it is the whole point. A fake that scopes columns per row accepts a
   * payload the database would damage, so a test written against it cannot fail
   * (L52), which is exactly how this shipped.
   */
  function payloadColumns(rows: Record<string, unknown>[]): string[] {
    const cols: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        // `undefined` is dropped on the way to JSON, so it is an absent key here
        // too, which is what makes a conditionally assigned property damaging.
        if (row[key] === undefined) continue;
        if (!cols.includes(key)) cols.push(key);
      }
    }
    return cols;
  }

  function applyBulkWrite(op: "upsert" | "insert", payload: unknown) {
    const rows = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
    const cols = payloadColumns(rows);
    for (const row of rows) {
      const id = String(row.id ?? `generated-${users.size + 1}`);
      const tuple: Record<string, unknown> = {};
      for (const col of cols) tuple[col] = row[col] === undefined ? null : row[col];
      const stored = users.get(id);
      // ON CONFLICT DO UPDATE SET col = EXCLUDED.col for every payload column,
      // which is why an omitted key is a write of NULL and not a no-op.
      users.set(id, stored ? { ...stored, ...tuple, id } : { ...tuple, id });
    }
  }

  /**
   * `users_outside_email_is_coordinator` (0212), judged where Postgres judges it
   * on a bulk write: against the PROPOSED INSERT tuple, before ON CONFLICT finds the
   * stored row. That tuple holds the payload's columns over the column defaults, so
   * a refresh naming neither `role` nor `deactivated_at` proposes an active agent,
   * and an outside address there is refused even when the stored row is a departed
   * agent or a coordinator the constraint allows. Measured against a real Postgres
   * 16 on 2026-10-29; the same statement as a plain UPDATE passes. The fake's company
   * domain is the one `googleHostedDomain` answers above.
   */
  function outsideEmailRefusal(payload: unknown): string | null {
    const rows = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
    const cols = payloadColumns(rows);
    for (const row of rows) {
      const proposed: Record<string, unknown> = { role: "agent", deactivated_at: null };
      for (const col of cols) proposed[col] = row[col] === undefined ? null : row[col];
      const domain = String(proposed.email ?? "").split("@").pop()?.toLowerCase();
      if (proposed.role !== "coordinator" && proposed.deactivated_at == null && domain !== "x.com") {
        return 'new row for relation "users" violates check constraint "users_outside_email_is_coordinator"';
      }
    }
    return null;
  }

  function applyUpdate(payload: unknown, filters: [string, string, unknown][]): Record<string, unknown>[] {
    const patch = payload as Record<string, unknown>;
    const written: Record<string, unknown>[] = [];
    for (const [id, row] of users) {
      const matches = filters.every(([kind, col, val]) => {
        const current = col === "id" ? id : row[col];
        if (kind === "eq") return current === val;
        if (kind === "in") return Array.isArray(val) && val.includes(current);
        if (kind === "is") return current === val;
        return true;
      });
      // An UPDATE sets only the columns it names, on the rows it matched. That is
      // the difference from the bulk write above, and the reason the belief this
      // code rested on was true of one row and false of a batch.
      if (matches) {
        users.set(id, { ...row, ...patch });
        written.push({ ...row, ...patch, id });
      }
    }
    return written;
  }

  /** The stored rows a read by these filters would return (id, in, is). */
  function readUsers(filters: [string, string, unknown][]): Record<string, unknown>[] {
    return [...users.entries()]
      .filter(([id, row]) =>
        filters.every(([kind, col, val]) => {
          const current = col === "id" ? id : row[col];
          if (kind === "eq") return current === val;
          if (kind === "in") return Array.isArray(val) && val.includes(current);
          if (kind === "is") return (current ?? null) === val;
          return true;
        }),
      )
      .map(([id, row]) => ({ ...row, id }));
  }

  /**
   * A canned read's rows narrowed by its own `.eq` filters, on the columns a fixture
   * row carries, so an exclusion the read applies is part of what a test sees
   * (#4201). A row without the column passes, which keeps every older fixture's
   * meaning.
   */
  function eqFiltered(rows: unknown[], filters: [string, string, unknown][]): unknown[] {
    return rows.filter((r) =>
      filters.every(([kind, col, val]) => {
        const row = r as Record<string, unknown>;
        return kind !== "eq" || !(col in row) || row[col] === val;
      }),
    );
  }

  function seedUsers(rows: Record<string, unknown>[]) {
    users.clear();
    for (const row of rows) users.set(String(row.id), { ...row });
    config.existing = rows;
  }

  function makeDb() {
    return {
      from(table: string) {
        const state: {
          table: string;
          op?: string;
          select?: string;
          payload?: unknown;
          filters: [string, string, unknown][];
          /** A `.select()` chained AFTER a write: PostgREST returns the written rows. */
          returning?: boolean;
        } = { table, filters: [] };
        const builder = {
          select(cols: string) {
            if (state.op === "update") {
              state.returning = true;
              return builder;
            }
            state.op = "select";
            state.select = cols;
            return builder;
          },
          upsert(payload: unknown) {
            state.op = "upsert";
            state.payload = payload;
            return builder;
          },
          insert(payload: unknown) {
            state.op = "insert";
            state.payload = payload;
            return builder;
          },
          update(payload: unknown) {
            state.op = "update";
            state.payload = payload;
            return builder;
          },
          eq(col: string, val: unknown) {
            state.filters.push(["eq", col, val]);
            return builder;
          },
          in(col: string, val: unknown) {
            state.filters.push(["in", col, val]);
            return builder;
          },
          is(col: string, val: unknown) {
            state.filters.push(["is", col, val]);
            return builder;
          },
          then(
            resolve: (v: { data: unknown; error: unknown }) => unknown,
            reject?: (e: unknown) => unknown,
          ) {
            calls.push({
              op: state.op!,
              table: state.table,
              select: state.select,
              payload: state.payload,
              filters: state.filters,
            });
            let result: { data: unknown; error: unknown } = { data: null, error: null };
            if (config.errorOn && state.op === config.errorOn) {
              result = { data: null, error: { message: `boom-${state.op}` } };
            } else if (state.table === "users" && (state.op === "upsert" || state.op === "insert") && outsideEmailRefusal(state.payload)) {
              result = { data: null, error: { message: outsideEmailRefusal(state.payload) } };
            } else if (state.op === "select") {
              // #2085: the routable write's BEFORE read, by id, answered from the
              // stored rows rather than a canned list, so its before and after agree.
              if (state.select === "id, org_id, email, bookable, deactivated_at, is_test") result = { data: readUsers(state.filters), error: null };
              else if (state.select?.includes("attributes")) result = { data: eqFiltered(config.existing, state.filters), error: null };
              else if (state.select?.includes("manager_id")) result = { data: eqFiltered(config.afterInsert, state.filters), error: null };
              else result = { data: eqFiltered(config.reapable, state.filters), error: null };
            }
            // A refused statement writes NOTHING, so the stored rows must not move
            // when the fake is returning an error: a test asserting what survived a
            // refusal would otherwise be reading a write the database never made.
            if (result.error === null && state.table === "users") {
              if (state.op === "upsert" || state.op === "insert") applyBulkWrite(state.op, state.payload);
              else if (state.op === "update") {
                const written = applyUpdate(state.payload, state.filters);
                if (state.returning) result = { data: written, error: null };
              }
            }
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  }
  return { calls, config, makeDb, users, seedUsers, payloadColumns, sfUsers: [] as unknown[], mgr: [] as unknown[] };
});
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => store.makeDb() }));
// #2085: the reap's departure records Regal's bookable trait through the webhook
// path. Delivery is pinned in routable-write.test.ts and emit.test.ts; here it is a
// recorder, so a departure of a routable agent can be seen to owe one.
const emitted = vi.hoisted(() => ({ emitWebhook: vi.fn(async () => {}) }));
vi.mock("@/lib/webhooks/emit", () => emitted);

// #2071: the sync now makes a hire bookable through the same gated service the
// admin toggle uses. Mocked for the whole file, because the fixtures above have
// an agent whose stored attributes are {} and whose Salesforce record carries a
// tier, which is exactly the transition that flips, and the real service would
// probe Google.
const bookable = vi.hoisted(() => ({
  applyBookableByUserId: vi.fn(
    async (userId: string): Promise<{ status: string; userId: string; bookable?: boolean; reason?: string }> => ({
      status: "applied",
      userId,
      bookable: true,
    }),
  ),
}));
const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async (_entry: Record<string, unknown>) => {}) }));
vi.mock("@/lib/bookable/service", () => bookable);
vi.mock("@/lib/audit", () => audit);
// #1678: the default coverage of a departure is the offboarding service, which sits on
// the whole booking service. A test that does not hand its own `coverDeparture` meets
// this stand in, never Google or the bulk reassign tables.
vi.mock("@/lib/offboarding/service", () => ({
  coverDeparture: vi.fn(async () => ({ invitesCleared: { cleared: 0, failed: 0 }, coverageSweep: "none" })),
}));

import { syncSalesforceAgents } from "@/lib/salesforce/sync";
import {
  MAX_ACTIVATIONS_PER_RUN,
  activationAllowance,
  type ActivationAllowance,
} from "@/lib/bookable/activation-allowance";
import { planOnboardingFlip } from "@/lib/salesforce/onboarding";
import { log } from "@/lib/log";
import type { Attributes } from "@/lib/db/types";

function sfResponse(records: unknown[]) {
  return { ok: true, json: async () => ({ records, done: true }) };
}

describe("syncSalesforceAgents batching + fail-loud (#91)", () => {
  beforeEach(() => {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    // One agent already in Slate (a@x, gets an update), one new (b@x, insert).
    // Both report the same OOO approver, so their manager link must collapse to
    // a single grouped write.
    store.config.existing = [{ id: "u1", email: "a@x.com", attributes: {} }];
    store.config.afterInsert = [
      { id: "u1", email: "a@x.com", manager_id: null, role: "agent" },
      { id: "u2", email: "b@x.com", manager_id: null, role: "agent" },
      { id: "u3", email: "mona@x.com", manager_id: null, role: "manager" },
    ];
    store.config.reapable = [];

    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      if (q.includes("IsActive = true AND Email != null AND (")) {
        return sfResponse([
          { Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
          { Email: "b@x.com", Name: "Agent B", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
        ]);
      }
      if (q.includes("Name IN (")) return sfResponse([{ Name: "Mona Manager", Email: "mona@x.com" }]);
      return sfResponse([]);
    });
  });

  it("writes existing agents as ONE upsert and links as ONE grouped update", async () => {
    const result = await syncSalesforceAgents();

    const upserts = store.calls.filter((c) => c.op === "upsert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toHaveLength(1); // just a@x, batched not per-row

    // Both agents share manager u3, so exactly one update carries manager_id
    // and targets both agents in a single .in("id", [...]) statement.
    const linkUpdates = store.calls.filter(
      (c) => c.op === "update" && (c.payload as { manager_id?: string }).manager_id === "u3",
    );
    expect(linkUpdates).toHaveLength(1);
    const inFilter = linkUpdates[0].filters.find((f) => f[0] === "in" && f[1] === "id");
    expect(inFilter?.[2]).toEqual(["u1", "u2"]);

    expect(result).toMatchObject({ inserted: 1, updated: 1, managersLinked: 2, managersCreated: 1 });
  });

  it("throws when a batched agent-update write errors (fail loud, no fake success)", async () => {
    store.config.errorOn = "upsert";
    await expect(syncSalesforceAgents()).rejects.toThrow(/agent update batch failed/);
  });

  // #4379: an address outside the company domain may only be a coordinator's
  // (users_outside_email_is_coordinator), so one such Salesforce user inserted as an
  // agent or a manager would fail the WHOLE batch, and every hire in it with them.
  // Left out before the write instead, and counted, so the run says so.
  it("leaves a Salesforce user on an outside address out of the insert, and counts them", async () => {
    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      if (q.includes("IsActive = true AND Email != null AND (")) {
        return sfResponse([
          { Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Outside Manager", HighDebt__c: true },
          { Email: "b@x.com", Name: "Agent B", HighDebt__c: true },
          { Email: "Contractor@Elsewhere.example", Name: "Contractor", HighDebt__c: true },
        ]);
      }
      if (q.includes("Name IN (")) return sfResponse([{ Name: "Outside Manager", Email: "boss@elsewhere.example" }]);
      return sfResponse([]);
    });

    const result = await syncSalesforceAgents();

    const inserted = store.calls
      .filter((c) => c.op === "insert" && c.table === "users")
      .flatMap((c) => c.payload as { email: string }[]);
    expect(inserted.map((r) => r.email)).toEqual(["b@x.com"]);
    expect(result.outsideDomainSkipped).toBe(2);
    // The ordinary hire beside them still arrives: one outsider no longer fails it.
    expect(result.inserted).toBe(1);
  });

  // The 2026-10-29 page: a departed agent on an outside address, still active in
  // Salesforce, failed every hourly refresh at users_outside_email_is_coordinator.
  // Postgres judges a batched upsert's PROPOSED INSERT tuple, which carries the
  // default role and no departure, so the stored row being allowed does not save
  // it. A coordinator on their own address is the same case.
  it("leaves an existing row on an outside address out of the refresh, so the rest still refresh", async () => {
    store.seedUsers([
      { id: "u1", email: "a@x.com", attributes: {}, bookable: false, deactivated_at: null, bookable_pending_since: null },
      { id: "u8", email: "left@elsewhere.example", role: "agent", attributes: {}, bookable: false, deactivated_at: "2026-09-01T00:00:00Z", bookable_pending_since: null },
      { id: "u9", email: "coord@partner.example", role: "coordinator", attributes: {}, bookable: false, deactivated_at: null, bookable_pending_since: null },
    ]);
    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      if (q.includes("IsActive = true AND Email != null AND (")) {
        return sfResponse([
          { Email: "a@x.com", Name: "Agent A Renamed", HighDebt__c: true },
          { Email: "left@elsewhere.example", Name: "Left", HighDebt__c: true },
          { Email: "coord@partner.example", Name: "Coordinator", HighDebt__c: true },
        ]);
      }
      return sfResponse([]);
    });

    const result = await syncSalesforceAgents();

    const refreshed = store.calls
      .filter((c) => c.op === "upsert" && c.table === "users")
      .flatMap((c) => c.payload as { id: string }[])
      .filter((r) => "attributes" in r);
    expect(refreshed.map((r) => r.id)).toEqual(["u1"]);
    expect(store.users.get("u1")?.name).toBe("Agent A Renamed");
    expect(result.outsideDomainNotRefreshed).toBe(2);
  });

  it("refuses the run when the company domain is unknown, rather than inserting anybody", async () => {
    await expect(
      syncSalesforceAgents({
        hostedDomain: () => {
          throw new Error("GOOGLE_HOSTED_DOMAIN is not set");
        },
      }),
    ).rejects.toThrow(/GOOGLE_HOSTED_DOMAIN/);
    expect(store.calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("throws when a grouped manager-link write errors", async () => {
    store.config.errorOn = "update";
    await expect(syncSalesforceAgents()).rejects.toThrow(/manager link batch failed/);
  });

  // #963: the initial roster reads used to destructure `const { data } = ...`
  // and ignore `error`. On a real query error `existing` was null, the by-email
  // map was empty, and every Salesforce agent was treated as brand new (the #277
  // silent-failure class). Routing the reads through `unwrap` makes a read error
  // throw instead of silently corrupting the roster.
  it("throws when a roster read errors (fail loud, no phantom brand-new agents)", async () => {
    store.config.errorOn = "select";
    await expect(syncSalesforceAgents()).rejects.toThrow(/read failed/);
  });

  // #1474: the sync must CONVERGE on Salesforce, not accumulate.
  //
  // Both directions, because a sync that only ever adds looks correct in every test
  // that only ever adds. Two live rows proved the gap: a manager whose manager of
  // record was one of his own agents, and a row pointing at itself.
  describe("converges on Salesforce instead of accumulating (#1474)", () => {
    /** The manager_id values written by this run, one entry per update call. */
    const managerWrites = () =>
      store.calls
        .filter((c) => c.op === "update" && "manager_id" in (c.payload as object))
        .map((c) => ({
          managerId: (c.payload as { manager_id: string | null }).manager_id,
          ids: c.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2],
        }));

    it("clears a link when Salesforce no longer names a manager", async () => {
      // a@x is already linked to u3; Salesforce now names nobody for them.
      store.config.afterInsert = [
        { id: "u1", email: "a@x.com", manager_id: "u3", role: "agent" },
        { id: "u3", email: "mona@x.com", manager_id: null, role: "manager" },
      ];
      sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
        if (url.includes("oauth2/token")) {
          return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
        }
        const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
        if (q.includes("IsActive = true AND Email != null AND (")) {
          return sfResponse([{ Email: "a@x.com", Name: "Agent A", Agent_Manager__c: null, HighDebt__c: true }]);
        }
        return sfResponse([]);
      });

      const result = await syncSalesforceAgents();

      const cleared = managerWrites().filter((w) => w.managerId === null);
      expect(cleared).toHaveLength(1);
      expect(cleared[0].ids).toEqual(["u1"]);
      expect(result.managersUnlinked).toBe(1);
      expect(result.managersLinked).toBe(0);
    });

    // The distinction the whole thing rests on. Salesforce NAMING a manager we
    // cannot resolve to a Slate user arrives as the same null email as naming
    // nobody, and only the second is grounds for clearing. Treating them alike
    // would delete a correct link every time a picklist name went ambiguous.
    it("does NOT clear when the manager name could not be resolved", async () => {
      store.config.afterInsert = [
        { id: "u1", email: "a@x.com", manager_id: "u3", role: "agent" },
        { id: "u3", email: "mona@x.com", manager_id: null, role: "manager" },
      ];
      sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
        if (url.includes("oauth2/token")) {
          return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
        }
        const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
        if (q.includes("IsActive = true AND Email != null AND (")) {
          return sfResponse([
            { Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Nobody Matching", HighDebt__c: true },
          ]);
        }
        // The name lookup finds no candidate, so the resolver returns null.
        return sfResponse([]);
      });

      const result = await syncSalesforceAgents();

      expect(managerWrites().filter((w) => w.managerId === null)).toHaveLength(0);
      expect(result.managersUnlinked).toBe(0);
      // Counted, so a run that deliberately did nothing is visible as that rather
      // than as an agent who genuinely has no manager.
      expect(result.managersUnresolved).toBe(1);
    });

    it("writes nothing when the link is already null (a quiet hour is quiet)", async () => {
      store.config.afterInsert = [{ id: "u1", email: "a@x.com", manager_id: null, role: "agent" }];
      sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
        if (url.includes("oauth2/token")) {
          return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
        }
        const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
        if (q.includes("IsActive = true AND Email != null AND (")) {
          return sfResponse([{ Email: "a@x.com", Name: "Agent A", Agent_Manager__c: null, HighDebt__c: true }]);
        }
        return sfResponse([]);
      });

      const result = await syncSalesforceAgents();

      expect(managerWrites()).toHaveLength(0);
      expect(result.managersUnlinked).toBe(0);
    });

    it("throws when the unlink write errors (fail loud, never a quiet non-clear)", async () => {
      store.config.afterInsert = [
        { id: "u1", email: "a@x.com", manager_id: "u3", role: "agent" },
        { id: "u3", email: "mona@x.com", manager_id: null, role: "manager" },
      ];
      sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
        if (url.includes("oauth2/token")) {
          return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
        }
        const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
        if (q.includes("IsActive = true AND Email != null AND (")) {
          return sfResponse([{ Email: "a@x.com", Name: "Agent A", Agent_Manager__c: null, HighDebt__c: true }]);
        }
        return sfResponse([]);
      });
      store.config.errorOn = "update";

      await expect(syncSalesforceAgents()).rejects.toThrow(/manager unlink batch failed/);
    });
  });
});

// #1587: the shared cross system rep key, salesforce_user_id on users.
//
// The planner's own rules are pinned offline (scripts/test-salesforce-user-id-link.ts).
// What is proved HERE is the wiring: that the sync asks Salesforce for the Id at
// all, that it writes only what the plan says to write, that the write is fail
// loud, and that a second run over unchanged data writes nothing. The last one is
// not a nicety: this is an hourly job, so "assume it runs twice" is the default
// case, not the edge.
describe("salesforce_user_id linking (#1587)", () => {
  const SF_A = "005AAAAAAAAAAAAAAA";
  const SF_B = "005BBBBBBBBBBBBBBB";

  /** Just the upserts that carry a Salesforce id (not the agent attribute refresh). */
  const idWrites = () =>
    store.calls
      .filter((c) => c.op === "upsert")
      .flatMap((c) => (c.payload as Record<string, unknown>[]) ?? [])
      .filter((row) => "salesforce_user_id" in row);

  /** Every SOQL statement this run sent, decoded. */
  const soqlSent = () => sentQueries.slice();
  let sentQueries: string[] = [];

  /**
   * Drives the sync with one Slate roster row and whatever Salesforce answers.
   * `debtTeam` is what the main agent query returns; `byEmail` is what the
   * roster-remainder query returns for rows the first one missed.
   */
  function arrange(opts: {
    roster: Record<string, unknown>[];
    existing?: Record<string, unknown>[];
    debtTeam: Record<string, unknown>[];
    byEmail?: Record<string, unknown>[];
  }) {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    sentQueries = [];
    store.config.existing = opts.existing ?? [];
    store.config.afterInsert = opts.roster;
    store.config.reapable = [];
    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return {
          ok: true,
          json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }),
        };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      sentQueries.push(q);
      if (q.includes("IsActive = true AND Email != null AND (")) return sfResponse(opts.debtTeam);
      if (q.includes("IsActive = true AND Email != null AND Email IN")) {
        return sfResponse(opts.byEmail ?? []);
      }
      return sfResponse([]);
    });
  }

  it("asks Salesforce for the Id and writes it onto the roster row", async () => {
    arrange({
      roster: [{ id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: null }],
      debtTeam: [{ Id: SF_A, Email: "a@x.com", Name: "Agent A", HighDebt__c: true }],
    });

    const result = await syncSalesforceAgents();

    // The query has to ASK for the field. Without this the whole feature is a
    // planner that is only ever handed empty candidates, and every assertion below
    // would still pass on an empty plan.
    expect(soqlSent().some((q) => q.startsWith("SELECT Id,"))).toBe(true);

    const written = idWrites();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ id: "u1", salesforce_user_id: SF_A });
    // org_id and email ride along because they are the NOT NULL columns without a
    // default; the upsert's phantom insert tuple is invalid without them.
    expect(written[0]).toHaveProperty("org_id", "org1");
    expect(written[0]).toHaveProperty("email", "a@x.com");
    expect(result.salesforceIdsLinked).toBe(1);
    expect(result.salesforceIdsUnresolved).toBe(0);
  });

  // The second batched upsert on `users` meets users_outside_email_is_coordinator
  // the same way the refresh does: a departed agent on an outside address gaining
  // an id would refuse every other row's id with it.
  it("links no id onto a row on an outside address, and still links everybody else", async () => {
    arrange({
      roster: [
        { id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: null },
        { id: "u9", email: "left@elsewhere.example", manager_id: null, role: "agent", salesforce_user_id: null, deactivated_at: "2026-09-01T00:00:00Z" },
      ],
      debtTeam: [
        { Id: SF_A, Email: "a@x.com", Name: "Agent A", HighDebt__c: true },
        { Id: SF_B, Email: "left@elsewhere.example", Name: "Left", HighDebt__c: true },
      ],
    });

    const result = await syncSalesforceAgents();

    expect(idWrites().map((r) => r.id)).toEqual(["u1"]);
    expect(result.salesforceIdsLinked).toBe(1);
  });

  it("writes NOTHING on a second run over the same data (it runs hourly)", async () => {
    arrange({
      roster: [{ id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: SF_A }],
      existing: [{ id: "u1", email: "a@x.com", attributes: {}, salesforce_user_id: SF_A }],
      debtTeam: [{ Id: SF_A, Email: "a@x.com", Name: "Agent A", HighDebt__c: true }],
    });

    const result = await syncSalesforceAgents();

    expect(idWrites()).toHaveLength(0);
    expect(result.salesforceIdsLinked).toBe(0);
    // And nothing is dressed up as a problem either: an id agreeing with itself is
    // the healthy state, not a disagreement and not an absence.
    expect(result.salesforceIdDisagreements).toBe(0);
    expect(result.salesforceIdsUnresolved).toBe(0);
  });

  it("REPORTS a disagreement and does not overwrite the stored id", async () => {
    arrange({
      roster: [{ id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: SF_A }],
      existing: [{ id: "u1", email: "a@x.com", attributes: {}, salesforce_user_id: SF_A }],
      debtTeam: [{ Id: SF_B, Email: "a@x.com", Name: "Agent A", HighDebt__c: true }],
    });

    const result = await syncSalesforceAgents();

    expect(idWrites()).toHaveLength(0);
    // Nothing anywhere in this run may carry the new id. Checking only the id
    // writes would miss it being smuggled in on the attribute refresh upsert.
    expect(JSON.stringify(store.calls)).not.toContain(SF_B);
    expect(result.salesforceIdDisagreements).toBe(1);
    expect(result.salesforceIdsLinked).toBe(0);
  });

  it("stores NO id when two Salesforce users share the matching key, and reports it", async () => {
    arrange({
      roster: [{ id: "u1", email: "shared@x.com", manager_id: null, role: "agent", salesforce_user_id: null }],
      debtTeam: [
        { Id: SF_A, Email: "shared@x.com", Name: "Agent A", HighDebt__c: true },
        { Id: SF_B, Email: "shared@x.com", Name: "Agent A Duplicate", HighDebt__c: true },
      ],
    });

    const result = await syncSalesforceAgents();

    expect(idWrites()).toHaveLength(0);
    expect(result.salesforceIdAmbiguous).toBe(1);
    // Many matches is a refusal in its own right, never reported as absence (L521).
    expect(result.salesforceIdsUnresolved).toBe(0);
    expect(result.salesforceIdsLinked).toBe(0);
  });

  it("reports an agent it could not resolve rather than silently skipping them", async () => {
    arrange({
      roster: [{ id: "u1", email: "ghost@x.com", manager_id: null, role: "agent", salesforce_user_id: null }],
      debtTeam: [],
      byEmail: [],
    });

    const result = await syncSalesforceAgents();

    expect(idWrites()).toHaveLength(0);
    expect(result.salesforceIdsUnresolved).toBe(1);
  });

  it("backfills a roster row the debt-team query never returns", async () => {
    // The measured case: on 2026-08-31 the debt team query resolved 104 of 118
    // active users, and the other 14 (managers, admins, the team lead) are
    // reachable only through the by-email remainder query.
    arrange({
      roster: [
        { id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: null },
        { id: "u9", email: "boss@x.com", manager_id: null, role: "admin", salesforce_user_id: null },
      ],
      debtTeam: [{ Id: SF_A, Email: "a@x.com", Name: "Agent A", HighDebt__c: true }],
      byEmail: [{ Id: SF_B, Email: "boss@x.com" }],
    });

    const result = await syncSalesforceAgents();

    const written = idWrites();
    expect(written).toHaveLength(2);
    expect(written.find((w) => w.id === "u9")).toMatchObject({ salesforce_user_id: SF_B });
    expect(result.salesforceIdsLinked).toBe(2);
    expect(result.salesforceIdsUnresolved).toBe(0);
    // The remainder query asks about the row the first query missed, and ONLY that
    // row: re-asking about one already answered would spend a Salesforce call per
    // hour forever on a question that is already settled.
    const remainder = soqlSent().find((q) => q.includes("Email != null AND Email IN"));
    expect(remainder).toContain("boss@x.com");
    expect(remainder).not.toContain("a@x.com");
  });

  it("throws when the id write errors (fail loud, never a quiet non-link)", async () => {
    arrange({
      roster: [{ id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: null }],
      debtTeam: [{ Id: SF_A, Email: "a@x.com", Name: "Agent A", HighDebt__c: true }],
    });
    // `existing` is empty, so the agent arrives as an INSERT and this run's only
    // upsert is the id write itself.
    store.config.errorOn = "upsert";

    await expect(syncSalesforceAgents()).rejects.toThrow(/user id link batch failed/);
  });
});

// #1653: the manager of record must be refused when the picklist name answers to
// more than one Salesforce user.
//
// The planner's own rules are pinned offline (scripts/test-salesforce-manager-link.ts).
// What is proved HERE is the wiring: that the sync refuses rather than taking the
// first match, that it says WHICH refusal it made, that it never hands an ambiguous
// name to the looser fallback matcher, that an existing correct link is not
// disturbed, and that a second run over the same data writes nothing. The last one
// is not a nicety: this is an hourly job, so "assume it runs twice" is the default.
describe("manager name ambiguity (#1653)", () => {
  /** Every manager_id write this run made, with the rows it targeted. */
  const managerWrites = () =>
    store.calls
      .filter((c) => c.op === "update" && "manager_id" in (c.payload as object))
      .map((c) => ({
        managerId: (c.payload as { manager_id: string | null }).manager_id,
        ids: c.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2],
      }));

  let sentQueries: string[] = [];
  const soqlSent = () => sentQueries.slice();

  /**
   * Drives the sync with a Slate roster and whatever Salesforce answers. The two
   * name queries are told apart by `LastName IN (` FIRST: the fallback query's
   * text contains the exact query's `Name IN (` as a substring, so testing for the
   * exact one first would answer both with the same records and hide the very
   * hand-off this suite is about.
   */
  function arrange(opts: {
    roster: Record<string, unknown>[];
    existing?: Record<string, unknown>[];
    debtTeam: Record<string, unknown>[];
    byName?: Record<string, unknown>[];
    byLastName?: Record<string, unknown>[];
  }) {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    sentQueries = [];
    store.config.existing = opts.existing ?? [];
    store.config.afterInsert = opts.roster;
    store.config.reapable = [];
    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return {
          ok: true,
          json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }),
        };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      sentQueries.push(q);
      if (q.includes("IsActive = true AND Email != null AND (")) return sfResponse(opts.debtTeam);
      if (q.includes("LastName IN (")) return sfResponse(opts.byLastName ?? []);
      if (q.includes("Name IN (")) return sfResponse(opts.byName ?? []);
      return sfResponse([]);
    });
  }

  const agentRow = (over: Record<string, unknown> = {}) => ({
    id: "u1",
    email: "a@x.com",
    manager_id: null,
    role: "agent",
    salesforce_user_id: null,
    ...over,
  });

  it("links NOTHING when the picklist name answers to two Salesforce users", async () => {
    arrange({
      roster: [
        agentRow(),
        { id: "u3", email: "mona1@x.com", manager_id: null, role: "manager", salesforce_user_id: null },
      ],
      debtTeam: [
        { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
      ],
      byName: [
        { Id: "005M1", Name: "Mona Manager", Email: "mona1@x.com" },
        { Id: "005M2", Name: "Mona Manager", Email: "mona2@x.com" },
      ],
    });

    const result = await syncSalesforceAgents();

    // The defect: the old code kept the FIRST match, so u1 was linked to mona1
    // and nothing anywhere said a second person answered to the same name.
    expect(managerWrites()).toHaveLength(0);
    expect(result.managersLinked).toBe(0);
    expect(result.managersAmbiguous).toBe(1);
    // Many matches is a refusal in its own right, never reported as absence (L11).
    expect(result.managersUnresolved).toBe(0);
    // And no manager user is invented for either of them, which would leave a
    // half-made row behind for a name the sync just refused.
    const managerInserts = store.calls.filter(
      (c) => c.op === "insert" && JSON.stringify(c.payload).includes("mona"),
    );
    expect(managerInserts).toHaveLength(0);
  });

  it("reports a name that matched NOBODY differently from one that matched several", async () => {
    arrange({
      roster: [agentRow()],
      debtTeam: [
        { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Nobody Matching", HighDebt__c: true },
      ],
      byName: [],
      byLastName: [],
    });

    const result = await syncSalesforceAgents();

    expect(result.managersUnresolved).toBe(1);
    expect(result.managersAmbiguous).toBe(0);
    expect(managerWrites()).toHaveLength(0);
  });

  it("does NOT hand an ambiguous name to the looser fallback matcher (L75)", async () => {
    arrange({
      roster: [agentRow()],
      debtTeam: [
        { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
      ],
      byName: [
        { Id: "005M1", Name: "Mona Manager", Email: "mona1@x.com" },
        { Id: "005M2", Name: "Mona Manager", Email: "mona2@x.com" },
      ],
      // If the ambiguous name reached the fallback, this ONE candidate would
      // resolve it and the refusal would be quietly overturned by a weaker match.
      byLastName: [
        { Id: "005M3", FirstName: "Mona", LastName: "Manager", Email: "mona3@x.com" },
      ],
    });

    const result = await syncSalesforceAgents();

    const lastNameQuery = soqlSent().find((q) => q.includes("LastName IN ("));
    expect(lastNameQuery).toBeUndefined();
    expect(result.managersLinked).toBe(0);
    expect(result.managersAmbiguous).toBe(1);
    expect(JSON.stringify(store.calls)).not.toContain("mona3@x.com");
  });

  it("leaves an EXISTING correct link exactly as it is when the name goes ambiguous", async () => {
    arrange({
      roster: [
        agentRow({ manager_id: "u3" }),
        { id: "u3", email: "mona1@x.com", manager_id: null, role: "manager", salesforce_user_id: null },
      ],
      existing: [
        { id: "u1", email: "a@x.com", attributes: {}, salesforce_user_id: null },
        { id: "u3", email: "mona1@x.com", attributes: {}, salesforce_user_id: null },
      ],
      debtTeam: [
        { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
      ],
      byName: [
        { Id: "005M1", Name: "Mona Manager", Email: "mona1@x.com" },
        { Id: "005M2", Name: "Mona Manager", Email: "mona2@x.com" },
      ],
    });

    const result = await syncSalesforceAgents();

    // Neither re-pointed nor cleared. "We could not work out who this is" must
    // never be written down as "this person has no manager" (#1474).
    expect(managerWrites()).toHaveLength(0);
    expect(result.managersUnlinked).toBe(0);
    expect(result.managersAmbiguous).toBe(1);
  });

  it("still links a name exactly one Salesforce user answers to", async () => {
    arrange({
      roster: [
        agentRow(),
        { id: "u3", email: "mona@x.com", manager_id: null, role: "manager", salesforce_user_id: null },
      ],
      debtTeam: [
        { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
      ],
      byName: [{ Id: "005M1", Name: "Mona Manager", Email: "mona@x.com" }],
    });

    const result = await syncSalesforceAgents();

    const written = managerWrites().filter((w) => w.managerId === "u3");
    expect(written).toHaveLength(1);
    expect(written[0].ids).toEqual(["u1"]);
    expect(result.managersLinked).toBe(1);
    expect(result.managersAmbiguous).toBe(0);
  });

  it("writes NOTHING on a second run over the same ambiguous data (it runs hourly)", async () => {
    const arrangeAmbiguous = () =>
      arrange({
        // Deliberately UNLINKED. With the agent already pointed at one of the two
        // candidates, a regression to taking the first match writes nothing (the
        // link it would write is the one already there), so the test would pass
        // over the very defect it exists to catch.
        roster: [
          agentRow({ manager_id: null, salesforce_user_id: "005A" }),
          { id: "u3", email: "mona1@x.com", manager_id: null, role: "manager", salesforce_user_id: "005M1" },
        ],
        existing: [
          { id: "u1", email: "a@x.com", attributes: {}, salesforce_user_id: "005A" },
          { id: "u3", email: "mona1@x.com", attributes: {}, salesforce_user_id: "005M1" },
        ],
        debtTeam: [
          { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
        ],
        byName: [
          { Id: "005M1", Name: "Mona Manager", Email: "mona1@x.com" },
          { Id: "005M2", Name: "Mona Manager", Email: "mona2@x.com" },
        ],
      });

    arrangeAmbiguous();
    const first = await syncSalesforceAgents();
    const firstWrites = managerWrites();

    arrangeAmbiguous();
    const second = await syncSalesforceAgents();

    expect(firstWrites).toHaveLength(0);
    expect(managerWrites()).toHaveLength(0);
    // Identical in and identical out: the second hour reports the same refusal
    // rather than converging on one of the two by accident.
    expect(second.managersAmbiguous).toBe(first.managersAmbiguous);
    expect(second.managersLinked).toBe(first.managersLinked);
    expect(second.managersUnlinked).toBe(first.managersUnlinked);
    expect(second.managersUnresolved).toBe(first.managersUnresolved);
  });

  it("counts EVERY agent under a shared name, not just the name", async () => {
    arrange({
      roster: [
        agentRow(),
        { id: "u2", email: "b@x.com", manager_id: null, role: "agent", salesforce_user_id: null },
      ],
      debtTeam: [
        { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
        { Id: "005B", Email: "b@x.com", Name: "Agent B", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
      ],
      byName: [
        { Id: "005M1", Name: "Mona Manager", Email: "mona1@x.com" },
        { Id: "005M2", Name: "Mona Manager", Email: "mona2@x.com" },
      ],
    });

    const result = await syncSalesforceAgents();

    // The number that matters to a reader is how many PEOPLE have no settled
    // approver, which is not the number of duplicated picklist values.
    expect(result.managersAmbiguous).toBe(2);
  });
});

// #2071: how a hire becomes bookable. The rule is pinned in
// scripts/test-salesforce-onboarding.ts; this is the wiring: that the roster
// query admits the onboarding profiles, that the pending mark travels in the same
// write as the attributes, that the flip goes through the gated service and is
// recorded, and that a refusal leaves the mark for the next hour.
describe("a hire becomes bookable on the first tier or the Sales profile (#2071)", () => {
  const sfRoster = (records: unknown[]) => {
    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      if (q.includes("IsActive = true AND Email != null AND (")) return sfResponse(records);
      return sfResponse([]);
    });
  };
  const rosterQuery = () => {
    const call = sf.fetchSfWithRetry.mock.calls
      .map((c) => decodeURIComponent(String(c[0]).split("q=")[1] ?? "").replace(/\+/g, " "))
      .find((q) => q.includes("FROM User WHERE IsActive"));
    return call ?? "";
  };

  beforeEach(() => {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    store.config.existing = [];
    store.config.afterInsert = [];
    store.config.reapable = [];
    bookable.applyBookableByUserId.mockClear();
    bookable.applyBookableByUserId.mockImplementation(async (userId: string) => ({
      status: "applied",
      userId,
      bookable: true,
    }));
    audit.recordAudit.mockClear();
  });

  it("asks Salesforce for the Sales and Chatter Free profiles, not only for tiers", async () => {
    sfRoster([]);
    await syncSalesforceAgents();
    const q = rosterQuery();
    expect(q).toContain("Profile.Name IN ('Sales', 'Chatter Free User')");
    expect(q).toMatch(/OR .*LowDebt__c=true/);
  });

  it("creates a Chatter Free hire not bookable, with no flip owed, and counts them", async () => {
    sfRoster([{ Email: "new@x.com", Name: "New Hire", Profile: { Name: "Chatter Free User" } }]);
    store.config.afterInsert = [{ id: "u9", email: "new@x.com", manager_id: null, role: "agent" }];
    const result = await syncSalesforceAgents();
    const insert = store.calls.find((c) => c.op === "insert" && c.table === "users");
    const row = (insert?.payload as Record<string, unknown>[])[0];
    expect(row).toMatchObject({ email: "new@x.com", role: "agent", bookable: false });
    // Explicitly null rather than absent since #2381: every row in a bulk payload
    // names the same columns, because PostgREST NULL-fills the ones a row omits and
    // writes them over the whole batch. Null is the assertion that says "no mark".
    expect(row.bookable_pending_since).toBeNull();
    expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();
    expect(result.createdUntiered).toBe(1);
    expect(result.bookableFlipped).toEqual([]);
  });

  it("flips a hire moved to the Sales profile, marks them pending in the same write, and records who did it", async () => {
    // Salesforce's half of the transition is the PROFILE since #2152: the tiers
    // come from Twilio, so a hire who has none yet is flipped by the move to Sales
    // and the audit names the tiers the row actually holds, which is none.
    store.config.existing = [
      { id: "u1", email: "hire@x.com", attributes: { role: "Chatter Free User" }, bookable: false, deactivated_at: null, bookable_pending_since: null },
    ];
    store.config.afterInsert = [{ id: "u1", email: "hire@x.com", manager_id: null, role: "agent" }];
    sfRoster([{ Email: "hire@x.com", Name: "Hire", Profile: { Name: "Sales" }, LowDebt__c: true, AchieveBackendServicer__c: true }]);

    const result = await syncSalesforceAgents();

    const upsert = store.calls.find((c) => c.op === "upsert");
    const row = (upsert?.payload as Record<string, unknown>[])[0];
    expect(row.attributes).toEqual({ role: "Sales" });
    expect(typeof row.bookable_pending_since).toBe("string");

expect(bookable.applyBookableByUserId).toHaveBeenCalledWith("u1", true);
    expect(audit.recordAudit).toHaveBeenCalledTimes(1);
    const entry = audit.recordAudit.mock.calls[0][0] as Record<string, unknown>;
    expect(entry).toMatchObject({ actorId: null, action: "agent.bookable", targetUserId: "u1" });
    expect(entry.details).toMatchObject({ via: "salesforce-sync", reason: "sales-profile", debt_team: [] });
    expect(result.bookableFlipped).toEqual(["hire@x.com"]);
    expect(result.bookablePending).toEqual([]);
  });

  it("counts somebody carrying tiers on a profile that will never make them bookable", async () => {
    // #2182: becoming bookable is the Sales profile alone, so a hire left on
    // Chatter Free with tiers is waiting on a Salesforce edit nobody has been told
    // is owed. Nothing here advances them, which is the intent, so the run says how
    // many are in that state rather than leaving it silent (L636).
    store.config.existing = [
      { id: "u1", email: "waiting@x.com", attributes: { role: "Chatter Free User", debt_team: ["low"] }, bookable: false, deactivated_at: null, bookable_pending_since: null },
      { id: "u2", email: "fine@x.com", attributes: { role: "Sales", debt_team: ["low"] }, bookable: true, deactivated_at: null, bookable_pending_since: null },
    ];
    store.config.afterInsert = [{ id: "u1", email: "waiting@x.com", manager_id: null, role: "agent" }];
    sfRoster([
      { Email: "waiting@x.com", Name: "Waiting", Profile: { Name: "Chatter Free User" } },
      { Email: "fine@x.com", Name: "Fine", Profile: { Name: "Sales" } },
    ]);

    const result = await syncSalesforceAgents();

    expect(result.tieredNotOnSales).toBe(1);
    // And nothing flipped them, which is the half that would undo the change.
    expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();
    expect(result.bookableFlipped).toEqual([]);
  });

  it("counts Sales agents who are not bookable with no recorded reason (#2621)", async () => {
    // The transition rule never reaches a row that was already on Sales when it
    // shipped, and the state also describes a deliberate hold, so it is counted
    // every run rather than acted on (L389, L636). A Redistribute mark is a
    // recorded reason, and a pending flip is already reported as pending.
    store.config.existing = [
      { id: "u1", email: "missed@x.com", attributes: { role: "Sales", debt_team: ["low"] }, bookable: false, deactivated_at: null, bookable_pending_since: null },
      { id: "u2", email: "tagged@x.com", attributes: { role: "Sales", debt_team: ["low"], redistribute: "Y" }, bookable: false, deactivated_at: null, bookable_pending_since: null },
      { id: "u3", email: "fine@x.com", attributes: { role: "Sales", debt_team: ["low"] }, bookable: true, deactivated_at: null, bookable_pending_since: null },
    ];
    sfRoster([
      { Email: "missed@x.com", Name: "Missed", Profile: { Name: "Sales" } },
      { Email: "tagged@x.com", Name: "Tagged", Profile: { Name: "Sales" } },
      { Email: "fine@x.com", Name: "Fine", Profile: { Name: "Sales" } },
    ]);

    const result = await syncSalesforceAgents();

    expect(result.salesNotBookableUnexplained).toBe(1);
    // Counted, never flipped: flipping would overturn a hold somebody chose.
    expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();
  });

    it("writes no debt team or backend service of its own, and leaves the ones Twilio wrote alone", async () => {
    // #2152. The Salesforce checkboxes still decide WHO is in scope, and no longer
    // decide what anybody's tiers are: a run that kept writing them would strip
    // whatever the Twilio half of the same hour had written, every hour.
    store.config.existing = [
      { id: "u1", email: "agent@x.com", attributes: { role: "Sales", debt_team: ["high"], backend_service: ["beyond"] }, bookable: true, deactivated_at: null, bookable_pending_since: null },
    ];
    store.config.afterInsert = [{ id: "u1", email: "agent@x.com", manager_id: null, role: "agent" }];
    // Salesforce says something completely different from what the row holds.
    sfRoster([{ Email: "agent@x.com", Name: "Agent", Profile: { Name: "Sales" }, LowDebt__c: true, AchieveBackendServicer__c: true }]);

    await syncSalesforceAgents();

    const upsert = store.calls.find((c) => c.op === "upsert");
    const row = (upsert?.payload as Record<string, unknown>[])[0];
    expect(row.attributes).toEqual({ role: "Sales", debt_team: ["high"], backend_service: ["beyond"] });
  });

  it("leaves a refused flip pending and records nothing, so next hour retries it", async () => {
    store.config.existing = [
      { id: "u1", email: "hire@x.com", attributes: { role: "Chatter Free User" }, bookable: false, deactivated_at: null, bookable_pending_since: null },
    ];
    store.config.afterInsert = [{ id: "u1", email: "hire@x.com", manager_id: null, role: "agent" }];
    sfRoster([{ Email: "hire@x.com", Name: "Hire", Profile: { Name: "Sales" } }]);
    bookable.applyBookableByUserId.mockResolvedValueOnce({ status: "blocked", userId: "u1", reason: "google_not_provisioned" });

    const result = await syncSalesforceAgents();

    expect(result.bookablePending).toEqual(["hire@x.com"]);
    expect(result.bookableFlipped).toEqual([]);
    expect(audit.recordAudit).not.toHaveBeenCalled();
    // The mark went out with the attributes, before the attempt, so it survives.
    const upsert = store.calls.find((c) => c.op === "upsert");
    expect(typeof (upsert?.payload as Record<string, unknown>[])[0].bookable_pending_since).toBe("string");
  });

  // #3028: the service refuses a flip in for somebody Twilio holds on Redistribute.
  // Left pending, that refusal would come back every hour for as long as the tag
  // stands, spending an activation slot each time and reading as somebody waiting
  // behind a refused activation. So the intent is handed to the Twilio half: the
  // pending mark goes and the Redistribute mark goes on, which is what the Twilio
  // sync reads to put them in the pool the hour the tag comes off.
  it("hands a flip Twilio holds to the Twilio half, rather than retrying it every hour", async () => {
    store.config.existing = [
      { id: "u1", email: "held@x.com", attributes: { role: "Sales", debt_team: ["low"], redistribute_tagged: "Y" }, bookable: false, deactivated_at: null, bookable_pending_since: "2026-09-30T10:00:00Z" },
    ];
    store.config.afterInsert = [{ id: "u1", email: "held@x.com", manager_id: null, role: "agent" }];
    sfRoster([{ Email: "held@x.com", Name: "Held", Profile: { Name: "Sales" }, LowDebt__c: true }]);
    bookable.applyBookableByUserId.mockResolvedValueOnce({ status: "blocked", userId: "u1", reason: "twilio_redistribute" });

    const result = await syncSalesforceAgents();

    expect(result.bookableHeldByTwilio).toEqual(["held@x.com"]);
    expect(result.bookablePending).toEqual([]);
    expect(result.bookableFlipped).toEqual([]);
    expect(audit.recordAudit).not.toHaveBeenCalled();
    const hold = store.calls.find(
      (c) => c.op === "update" && "bookable_pending_since" in (c.payload as Record<string, unknown>),
    );
    const payload = hold?.payload as { bookable_pending_since: unknown; attributes: Record<string, unknown> };
    expect(payload.bookable_pending_since).toBeNull();
    // The routing facts the row holds are carried, not replaced by the mark.
    expect(payload.attributes).toMatchObject({ debt_team: ["low"], redistribute_tagged: "Y", redistribute: "Y" });
    expect(typeof payload.attributes.redistribute_at).toBe("string");
  });

  it("retries a pending flip even when nothing about the attributes changed", async () => {
    store.config.existing = [
      { id: "u1", email: "hire@x.com", attributes: { role: "Sales", debt_team: ["low"] }, bookable: false, deactivated_at: null, bookable_pending_since: "2026-09-08T10:00:00Z" },
    ];
    store.config.afterInsert = [{ id: "u1", email: "hire@x.com", manager_id: null, role: "agent" }];
    sfRoster([{ Email: "hire@x.com", Name: "Hire", Profile: { Name: "Sales" }, LowDebt__c: true }]);

    const result = await syncSalesforceAgents();

expect(bookable.applyBookableByUserId).toHaveBeenCalledWith("u1", true);
    expect(result.bookableFlipped).toEqual(["hire@x.com"]);
    const entry = audit.recordAudit.mock.calls[0][0] as Record<string, unknown>;
    // The tiers in the trail are the ones the ROW holds, which since #2152 came
    // from Twilio. Read from the Salesforce half alone they would be empty for an
    // agent who plainly has them, and the trail's whole job is answering what the
    // state was (L529).
    expect(entry.details).toMatchObject({ reason: "retry", debt_team: ["low"] });
  });

  it("never overturns a person's hold: tiers against tiers is not a transition", async () => {
    // rvillar on 2026-09-08: a manager holding tiers, set non-bookable by hand.
    store.config.existing = [
      { id: "u1", email: "mgr@x.com", attributes: { role: "Sales Manager", debt_team: ["medium", "high"] }, bookable: false, deactivated_at: null, bookable_pending_since: null },
    ];
    store.config.afterInsert = [{ id: "u1", email: "mgr@x.com", manager_id: null, role: "agent" }];
    sfRoster([{ Email: "mgr@x.com", Name: "Mgr", Profile: { Name: "Sales Manager" }, MediumDebt__c: true, HighDebt__c: true }]);

    const result = await syncSalesforceAgents();

    expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();
    expect(result.bookableFlipped).toEqual([]);
    const upsert = store.calls.find((c) => c.op === "upsert");
    // Null, not absent, for the #2381 reason on the insert case above: the column is
    // named on every row, and what says the hold stands is that the value is null.
    expect((upsert?.payload as Record<string, unknown>[])[0].bookable_pending_since).toBeNull();
  });

  it("never puts somebody who has left back in the pool because of a Salesforce edit", async () => {
    store.config.existing = [
      { id: "u1", email: "gone@x.com", attributes: { role: "Chatter Free User" }, bookable: false, deactivated_at: "2026-08-24T00:00:00Z", bookable_pending_since: null },
    ];
    store.config.afterInsert = [{ id: "u1", email: "gone@x.com", manager_id: null, role: "agent" }];
    sfRoster([{ Email: "gone@x.com", Name: "Gone", Profile: { Name: "Sales" }, LowDebt__c: true }]);

    await syncSalesforceAgents();
    expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();
  });
});

// #2381: one fresh transition in the batch must not erase everybody else's mark.
//
// The refresh rows go out as ONE bulk upsert, and PostgREST takes the column list
// of a bulk payload as the UNION of the keys across every row, NULL-filling a row
// that omits one, then writing every column of that list in ON CONFLICT DO UPDATE.
// So a conditionally assigned `bookable_pending_since` is not a column written for
// the one row carrying it: it is a NULL written over every row that does not.
//
// That mark is the ONLY record of a refused or deferred activation, and
// `planOnboardingFlip` returns `none` for Sales against Sales without it. A hire
// whose mark was erased is never made bookable by anything again, and reads exactly
// like somebody an admin deliberately held back.
//
// These tests are what the recorded payload could never show, because the fake used
// to record the write instead of applying it, and a fake that scopes columns per row
// models a database behaviour PostgREST does not have (L52). `store.users` is the
// applied state; every assertion below reads that rather than the payload.
describe("a fresh pending mark in the batch leaves the other marks alone (#2381)", () => {
  const NOW = "2026-09-16T12:00:00.000Z";
  const MARK_A = "2026-09-16T10:00:00.000Z";
  const MARK_B = "2026-09-16T11:00:00.000Z";

  const sfRoster = (records: unknown[]) => {
    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      if (q.includes("IsActive = true AND Email != null AND (")) return sfResponse(records);
      return sfResponse([]);
    });
  };

  /**
   * Two hires whose flip was refused last hour (so each carries its own mark, and
   * the two marks differ so neither can stand in for the other), plus one moved to
   * Sales this hour, which is the fresh transition that used to null the other two.
   */
  const seedThreeHires = () => {
    store.seedUsers([
      { id: "u1", email: "retry-a@x.com", attributes: { role: "Sales", debt_team: ["low"] }, bookable: false, deactivated_at: null, bookable_pending_since: MARK_A },
      { id: "u2", email: "retry-b@x.com", attributes: { role: "Sales", debt_team: ["low"] }, bookable: false, deactivated_at: null, bookable_pending_since: MARK_B },
      { id: "u3", email: "fresh@x.com", attributes: { role: "Chatter Free User" }, bookable: false, deactivated_at: null, bookable_pending_since: null },
    ]);
    store.config.afterInsert = [
      { id: "u1", email: "retry-a@x.com", manager_id: null, role: "agent", salesforce_user_id: null, bookable: false, deactivated_at: null, is_test: false },
      { id: "u2", email: "retry-b@x.com", manager_id: null, role: "agent", salesforce_user_id: null, bookable: false, deactivated_at: null, is_test: false },
      { id: "u3", email: "fresh@x.com", manager_id: null, role: "agent", salesforce_user_id: null, bookable: false, deactivated_at: null, is_test: false },
    ];
    sfRoster([
      { Email: "retry-a@x.com", Name: "Retry A", Profile: { Name: "Sales" }, LowDebt__c: true },
      { Email: "retry-b@x.com", Name: "Retry B", Profile: { Name: "Sales" }, LowDebt__c: true },
      { Email: "fresh@x.com", Name: "Fresh Hire", Profile: { Name: "Sales" } },
    ]);
  };

  /** The stored value, read back as the database would hold it after the writes. */
  const markOf = (id: string) => store.users.get(id)?.bookable_pending_since;

  beforeEach(() => {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    store.config.reapable = [];
    bookable.applyBookableByUserId.mockClear();
    // Every flip refused, which is the case the mark exists for: Google has not
    // provisioned the hires yet, so nothing clears a mark and nothing else writes.
    bookable.applyBookableByUserId.mockImplementation(async (userId: string) => ({
      status: "blocked",
      userId,
      reason: "google_not_provisioned",
    }));
    audit.recordAudit.mockClear();
    seedThreeHires();
  });

  it("keeps each retried hire's own mark while marking the fresh transition", async () => {
    const result = await syncSalesforceAgents({ nowIso: () => NOW });

    expect(markOf("u1")).toBe(MARK_A);
    expect(markOf("u2")).toBe(MARK_B);
    expect(markOf("u3")).toBe(NOW);
    // All three were still attempted this run, so the marks are what carries them
    // into the next one rather than anything held in memory.
    expect(result.bookablePending.sort()).toEqual(["fresh@x.com", "retry-a@x.com", "retry-b@x.com"]);
  });

  it("leaves the retried hires still owed a flip on the next run", async () => {
    // The column value is not the harm; this is. A test asserting only the stamp
    // would pass on a fix that stored something `planOnboardingFlip` cannot use.
    await syncSalesforceAgents({ nowIso: () => NOW });

    for (const id of ["u1", "u2"]) {
      const row = store.users.get(id) as { attributes: Attributes; bookable_pending_since: string | null };
      const plan = planOnboardingFlip({
        // Nothing about them changed, which is precisely why only the mark can
        // carry the intent: Sales against Sales is not a transition.
        prev: row.attributes,
        next: row.attributes,
        bookable: false,
        deactivated: false,
        pending: row.bookable_pending_since != null,
      });
      expect(plan).toEqual({ action: "flip", reason: "retry" });
    }
  });

  it("sends every row in the batch the same columns, so no row NULL-fills another", async () => {
    // The property the database actually enforces, asserted on the payload rather
    // than on the stored rows: a second conditionally assigned column added later
    // would pass the two tests above for whichever row happened to carry it.
    await syncSalesforceAgents({ nowIso: () => NOW });

    const batch = store.calls.find((c) => c.op === "upsert" && c.table === "users")
      ?.payload as Record<string, unknown>[];
    expect(batch).toHaveLength(3);
    const union = store.payloadColumns(batch);
    for (const row of batch) {
      expect(Object.keys(row).filter((k) => row[k] !== undefined).sort()).toEqual([...union].sort());
    }
    expect(union).toContain("bookable_pending_since");
  });

  it("writes no mark at all when the batch is refused, so the run retries whole", async () => {
    store.config.errorOn = "upsert";

    await expect(syncSalesforceAgents({ nowIso: () => NOW })).rejects.toThrow(
      /agent update batch failed/,
    );

    // A refused statement writes nothing, so the two existing marks are untouched
    // and the fresh hire gains none. Next hour re-reads Chatter Free against Sales
    // and plans the same fresh transition, and the two retries are still pending.
    expect(markOf("u1")).toBe(MARK_A);
    expect(markOf("u2")).toBe(MARK_B);
    expect(markOf("u3")).toBeNull();
    // And nothing downstream ran on a roster the write never landed.
    expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();
  });
});

// #1833: the rows the roster query did NOT return.
//
// Salesforce takes somebody off rotation by CLEARING their balance tier flags,
// which drops them out of that query rather than updating them, so their Slate row
// is never written again: no error, no counter, no log line, and the lane reports
// success every hour. This is the reconcile that makes them visible, and the whole
// point of it is that it changes nothing.
describe("roster rows Salesforce no longer confirms (#1833)", () => {
  /**
   * The Salesforce side. `roster` is what the roster query returns, `present` is
   * what the presence query answers for the addresses it is asked about, and an
   * address in NEITHER is one Salesforce has no record of at all.
   */
  const sfWorld = (opts: {
    roster: unknown[];
    present?: { Id?: string; Email: string; IsActive: boolean }[];
    presenceFails?: boolean;
  }) => {
    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      if (q.includes("IsActive = true AND Email != null AND (")) return sfResponse(opts.roster);
      // Matched on the part of the presence query that does not change with its
      // column list: a fixture keyed on the full SELECT stops matching the moment
      // a column is added, and then answers nothing while every test still runs
      // (L143). #2387 added `Id` and this is where that cost showed up.
      if (q.includes("IsActive FROM User WHERE Email IN")) {
        if (opts.presenceFails) {
          return { ok: false, status: 500, text: async () => "Salesforce is having a bad minute" };
        }
        const asked = q.slice(q.indexOf("IN ("));
        return sfResponse((opts.present ?? []).filter((r) => asked.includes(`'${r.Email}'`)));
      }
      return sfResponse([]);
    });
  };
  /** Every user id this run wrote anything to. */
  const writtenIds = () =>
    store.calls
      .filter((c) => c.op === "upsert" || c.op === "update" || c.op === "insert")
      .flatMap((c) => {
        const rows = Array.isArray(c.payload) ? c.payload : [c.payload];
        const ids = rows.map((r) => (r as { id?: string } | null)?.id).filter(Boolean);
        const filtered = c.filters.find((f) => f[0] === "in" && f[1] === "id");
        return [...ids, ...((filtered?.[2] as string[]) ?? [])];
      });

  beforeEach(() => {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    store.config.existing = [];
    store.config.afterInsert = [];
    store.config.reapable = [];
    bookable.applyBookableByUserId.mockClear();
  });

  it("reports a bookable agent the roster query stopped returning, and writes NOTHING for them", async () => {
    store.config.existing = [
      { id: "u1", email: "a@x.com", attributes: { role: "Sales" }, bookable: true, deactivated_at: null, bookable_pending_since: null },
      { id: "u2", email: "onleave@x.com", attributes: { role: "Sales", debt_team: ["high"] }, bookable: true, deactivated_at: null, bookable_pending_since: null },
    ];
    store.config.afterInsert = [
      { id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: "005A", bookable: true, deactivated_at: null, is_test: false },
      { id: "u2", email: "onleave@x.com", manager_id: null, role: "agent", salesforce_user_id: "005B", bookable: true, deactivated_at: null, is_test: false },
    ];
    // Salesforce still HOLDS u2, active. Their tiers were cleared, so the roster
    // query no longer matches them: the #1833 case exactly.
    sfWorld({
      roster: [{ Id: "005A", Email: "a@x.com", Name: "Agent A", Profile: { Name: "Sales" }, HighDebt__c: true }],
      present: [{ Email: "onleave@x.com", IsActive: true }],
    });

    const result = await syncSalesforceAgents();

    expect(result.rosterUnconfirmedUnmatched).toBe(1);
    expect(result.rosterUnconfirmedInactive).toBe(0);
    expect(result.rosterUnconfirmedAbsent).toBe(0);
    expect(result.rosterUnconfirmedBookable).toEqual(["onleave@x.com"]);
    // The count is reported beside the findings, so no findings over nothing and no
    // findings over the whole roster can never read alike (L98).
    expect(result.rosterRowsReconciled).toBe(2);
    // Recording, never clearing: a source going quiet is not the source saying the
    // facts are gone (L214), and emptying their pools could not be undone.
    expect(writtenIds()).not.toContain("u2");
  });

  it("tells the three reasons apart, because they send a reader to three places", async () => {
    store.config.afterInsert = [
      { id: "u-left", email: "left@x.com", manager_id: null, role: "agent", salesforce_user_id: null, bookable: false, deactivated_at: null, is_test: false },
      { id: "u-onleave", email: "onleave@x.com", manager_id: null, role: "agent", salesforce_user_id: null, bookable: false, deactivated_at: null, is_test: false },
      { id: "u-never", email: "never@x.com", manager_id: null, role: "agent", salesforce_user_id: null, bookable: false, deactivated_at: null, is_test: false },
    ];
    sfWorld({
      roster: [],
      present: [
        { Email: "left@x.com", IsActive: false },
        { Email: "onleave@x.com", IsActive: true },
        // never@x.com is in no answer at all: Salesforce has no record for it.
      ],
    });

    const result = await syncSalesforceAgents();

    expect(result.rosterUnconfirmedInactive).toBe(1);
    expect(result.rosterUnconfirmedUnmatched).toBe(1);
    expect(result.rosterUnconfirmedAbsent).toBe(1);
    // Nobody in the pool, so nothing pages: this is the state the live roster is in
    // today, and an hourly page about it would carry no action (L36).
    expect(result.rosterUnconfirmedBookable).toEqual([]);
  });

  it("says nothing about a deactivated row or a smoke test agent", async () => {
    store.config.afterInsert = [
      { id: "u-gone", email: "gone@x.com", manager_id: null, role: "agent", salesforce_user_id: null, bookable: false, deactivated_at: "2026-08-24T00:00:00Z", is_test: false },
      { id: "u-smoke", email: "smoke@x.com", manager_id: null, role: "agent", salesforce_user_id: null, bookable: true, deactivated_at: null, is_test: true },
    ];
    sfWorld({ roster: [], present: [] });

    const result = await syncSalesforceAgents();

    expect(result.rosterRowsReconciled).toBe(0);
    expect(result.rosterUnconfirmedAbsent).toBe(0);
    expect(result.rosterUnconfirmedBookable).toEqual([]);
  });

  // #4201: the placeholder advisor is a Slate row with no Salesforce user behind it.
  // Whatever Salesforce says about its address, the sync writes nothing to it, never
  // inserts a twin of it, never reaps it, and never reports it as diverged.
  const marciaRows = () => {
    store.config.existing = [
      { id: "u-marcia", email: "marcia@x.com", attributes: {}, bookable: false, deactivated_at: null, bookable_pending_since: null, is_placeholder: true },
    ];
    store.config.afterInsert = [
      { id: "u-marcia", email: "marcia@x.com", manager_id: null, role: "agent", salesforce_user_id: null, bookable: false, deactivated_at: null, is_test: false, is_placeholder: true },
    ];
    store.config.reapable = [{ id: "u-marcia", email: "marcia@x.com", salesforce_user_id: null, is_placeholder: true }];
  };

  it("writes nothing to the placeholder advisor when Salesforce returns its address", async () => {
    marciaRows();
    sfWorld({
      roster: [{ Id: "005M", Email: "marcia@x.com", Name: "Marcia Renamed", Profile: { Name: "Sales" }, HighDebt__c: true }],
      present: [{ Id: "005M", Email: "marcia@x.com", IsActive: true }],
    });

    const result = await syncSalesforceAgents();

    expect(writtenIds()).not.toContain("u-marcia");
    const inserted = store.calls
      .filter((c) => c.op === "insert")
      .flatMap((c) => (Array.isArray(c.payload) ? c.payload : [c.payload]) as { email?: string }[]);
    expect(inserted.map((r) => r.email)).not.toContain("marcia@x.com");
    expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();
    expect(result.rosterRowsReconciled).toBe(0);
  });

  // #4206: the manager creation plan is handed the addresses Slate already holds. The
  // placeholder's is left out of `byEmail` on purpose, so without passing it on
  // separately an agent whose manager of record resolves to that address planned a
  // brand new manager row for it, and the insert made a twin of the placeholder.
  it("never plans a new manager for an address the placeholder advisor already holds", async () => {
    marciaRows();
    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      if (q.includes("IsActive = true AND Email != null AND (")) {
        return sfResponse([
          { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Marcia Lead", HighDebt__c: true },
        ]);
      }
      if (q.includes("Name IN (")) return sfResponse([{ Id: "005M", Name: "Marcia Lead", Email: "marcia@x.com" }]);
      return sfResponse([]);
    });

    const result = await syncSalesforceAgents();

    const inserted = store.calls
      .filter((c) => c.op === "insert")
      .flatMap((c) => (Array.isArray(c.payload) ? c.payload : [c.payload]) as { email?: string }[]);
    expect(inserted.map((r) => r.email)).not.toContain("marcia@x.com");
    expect(result.managersCreated).toBe(0);
  });

  it("never reaps or reports the placeholder advisor when Salesforce calls its address inactive", async () => {
    marciaRows();
    sfWorld({ roster: [], present: [{ Id: "005M", Email: "marcia@x.com", IsActive: false }] });

    const result = await syncSalesforceAgents();

    expect(result.deactivated).toBe(0);
    expect(writtenIds()).not.toContain("u-marcia");
    expect(result.rosterRowsReconciled).toBe(0);
    expect(result.rosterUnconfirmedInactive).toBe(0);
  });

  // The failure path. A Salesforce read that FAILED must never arrive anywhere as
  // "nobody diverged": an empty divergence list reads as a healthy roster, which is
  // the exact shape of the defect this reconcile exists to end (L98).
  it("throws when the presence read fails, rather than reporting no divergence", async () => {
    store.config.afterInsert = [
      { id: "u-onleave", email: "onleave@x.com", manager_id: null, role: "agent", salesforce_user_id: null, bookable: true, deactivated_at: null, is_test: false },
    ];
    sfWorld({ roster: [], presenceFails: true });

    await expect(syncSalesforceAgents()).rejects.toThrow(/SF query failed: 500/);
  });

  // The reap reads the SAME widened query now, so its own rule has to be shown to be
  // unchanged: a positive IsActive = false on a never-logged-in row deactivates, and
  // an ACTIVE record beside it in the same answer does not.
  it("still deactivates a reapable row Salesforce reports inactive", async () => {
    store.config.reapable = [
      { id: "u-left", email: "left@x.com" },
      { id: "u-here", email: "here@x.com" },
    ];
    sfWorld({
      roster: [],
      present: [
        { Email: "left@x.com", IsActive: false },
        { Email: "here@x.com", IsActive: true },
      ],
    });

    const result = await syncSalesforceAgents();

    expect(result.deactivated).toBe(1);
    const deactivation = store.calls.find(
      (c) => c.op === "update" && (c.payload as { deactivated_at?: string }).deactivated_at,
    );
    expect(deactivation?.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2]).toEqual(["u-left"]);
  });

  // #1678: the leaver's remaining calls are handed to the SAME offboarding coverage the
  // lifecycle API runs, keyed on the stamp the reap's write stored, so a departure is
  // covered when it is recorded rather than an hour later when the monitor pages.
  it("hands a departed advisor's calls to the offboarding coverage, under the stored stamp", async () => {
    store.seedUsers([
      { id: "u-left", org_id: "org1", email: "left@x.com", role: "agent", bookable: true, deactivated_at: null, is_test: false },
    ]);
    store.config.reapable = [{ id: "u-left", email: "left@x.com" }];
    sfWorld({ roster: [], present: [{ Email: "left@x.com", IsActive: false }] });
    const coverDeparture = vi.fn(async () => "queued" as const);

    const result = await syncSalesforceAgents({ coverDeparture });

    expect(result.deactivated).toBe(1);
    expect(coverDeparture).toHaveBeenCalledTimes(1);
    const deactivation = store.calls.find(
      (c) => c.op === "update" && (c.payload as { deactivated_at?: string }).deactivated_at,
    );
    const stamp = (deactivation?.payload as { deactivated_at: string }).deactivated_at;
    expect(coverDeparture).toHaveBeenCalledWith({ outUserId: "u-left", deactivatedAtIso: stamp });
    expect(result.departureCoverage).toEqual({ queued: 1, none: 0, failed: 0 });
  });

  it("keeps the departure and reports it when the coverage could not be enqueued", async () => {
    store.seedUsers([
      { id: "u-left", org_id: "org1", email: "left@x.com", role: "agent", bookable: true, deactivated_at: null, is_test: false },
    ]);
    store.config.reapable = [{ id: "u-left", email: "left@x.com" }];
    sfWorld({ roster: [], present: [{ Email: "left@x.com", IsActive: false }] });
    const coverDeparture = vi.fn(async () => {
      throw new Error("bulk_reassign_jobs insert failed");
    });

    const result = await syncSalesforceAgents({ coverDeparture });

    expect(result.deactivated).toBe(1);
    expect(result.departureCoverage).toEqual({ queued: 0, none: 0, failed: 1 });
  });

  it("asks for no coverage when the reap departs nobody", async () => {
    store.config.reapable = [{ id: "u-here", email: "here@x.com" }];
    sfWorld({ roster: [], present: [{ Email: "here@x.com", IsActive: true }] });
    const coverDeparture = vi.fn(async () => "queued" as const);

    const result = await syncSalesforceAgents({ coverDeparture });

    expect(coverDeparture).not.toHaveBeenCalled();
    expect(result.departureCoverage).toEqual({ queued: 0, none: 0, failed: 0 });
  });

  // #2386. The reap stamped `deactivated_at` and left `bookable` true, which is
  // the defect #1324 fixed on the OTHER deactivation path. The consequence is not
  // routing, which already requires `deactivated_at is null`: it is that every
  // COUNT of the bookable pool overstates it by one per leaver, and that a rehire
  // reactivated later re-enters the routing pool with the activation gate never
  // run, because that gate lives only on the bookable flip.
  //
  // ONE write, asserted as one: two statements could fail independently and leave
  // the row half changed, with the person out of the pool by one column and in it
  // by the other.
  it("clears the bookable flag in the SAME write that departs a leaver", async () => {
    store.seedUsers([
      {
        id: "u-left",
        org_id: "org1",
        email: "left@x.com",
        role: "agent",
        bookable: true,
        deactivated_at: null,
        auth_user_id: null,
        is_test: false,
      },
    ]);
    store.config.reapable = [{ id: "u-left", email: "left@x.com" }];
    sfWorld({ roster: [], present: [{ Email: "left@x.com", IsActive: false }] });

    await syncSalesforceAgents();

    const deactivations = store.calls.filter(
      (c) => c.op === "update" && "deactivated_at" in (c.payload as Record<string, unknown>),
    );
    expect(deactivations).toHaveLength(1);
    expect(deactivations[0].payload).toMatchObject({ bookable: false });
    expect((deactivations[0].payload as { deactivated_at: string }).deactivated_at).toEqual(
      expect.any(String),
    );
    // Read back as STATE, not only as a recorded payload.
    expect(store.users.get("u-left")).toMatchObject({ bookable: false });
    // #2085: a routable agent departed by the reap owes Regal a false, recorded by
    // the same write rather than by anything the reap had to remember.
    expect(emitted.emitWebhook).toHaveBeenCalledWith(
      "org1",
      "agent.bookable_changed",
      { user_id: "u-left", email: "left@x.com", slate_bookable: false },
      null,
      false,
      expect.any(Function),
    );
  });

  // The failure path. A refused write must never arrive anywhere as a departure
  // that happened: `deactivated: 1` over a statement the database refused is a
  // leaver still taking bookings while the lane reports a clean hour (L12).
  it("throws when the departing write is refused, rather than reporting it done", async () => {
    store.seedUsers([
      {
        id: "u-left",
        email: "left@x.com",
        role: "agent",
        bookable: true,
        deactivated_at: null,
        auth_user_id: null,
      },
    ]);
    store.config.reapable = [{ id: "u-left", email: "left@x.com" }];
    store.config.errorOn = "update";
    sfWorld({ roster: [], present: [{ Email: "left@x.com", IsActive: false }] });

    await expect(syncSalesforceAgents()).rejects.toThrow(/boom-update/);
    expect(store.users.get("u-left")).toMatchObject({ bookable: true, deactivated_at: null });
  });
});

describe("how many activations one run attempts (#2302)", () => {
  const sfRoster = (records: unknown[]) => {
    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      if (q.includes("IsActive = true AND Email != null AND (")) return sfResponse(records);
      return sfResponse([]);
    });
  };

  beforeEach(() => {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    store.config.existing = [];
    store.config.afterInsert = [];
    store.config.reapable = [];
    bookable.applyBookableByUserId.mockClear();
    bookable.applyBookableByUserId.mockImplementation(async (userId: string) => ({
      status: "applied",
      userId,
      bookable: true,
    }));
    audit.recordAudit.mockClear();
  });

  /** n hires all moved to the Sales profile in the same run, which is what a bulk
   *  licence upgrade looks like to this lane. */
  const flipWave = async (n: number, allowance?: ActivationAllowance) => {
    const ids = Array.from({ length: n }, (_, i) => `u${i}`);
    store.config.existing = ids.map((id) => ({
      id,
      email: `${id}@x.com`,
      attributes: { role: "Chatter Free User" },
      bookable: false,
      deactivated_at: null,
      bookable_pending_since: null,
    }));
    store.config.afterInsert = ids.map((id) => ({ id, email: `${id}@x.com`, manager_id: null, role: "agent" }));
    sfRoster(ids.map((id) => ({ Email: `${id}@x.com`, Name: id, Profile: { Name: "Sales" } })));
    return allowance
      ? syncSalesforceAgents({ allowance })
      : syncSalesforceAgents();
  };

  it("attempts every activation while the allowance lasts", async () => {
    const result = await flipWave(3);
    expect(bookable.applyBookableByUserId).toHaveBeenCalledTimes(3);
    expect(result.bookableFlipped).toHaveLength(3);
    expect(result.bookableDeferredToNextRun).toEqual([]);
  });

  it("leaves the rest of a mass upgrade for the next run rather than running the lane out of budget", async () => {
    // Since the calendar read is part of the gate, each attempt is a handful of
    // Google calls out of one shared invocation budget. The remainder is not
    // admitted unread: it is simply not attempted, and the pending mark written
    // earlier in this same run is what brings it back next hour.
    const n = MAX_ACTIVATIONS_PER_RUN + 4;
    const result = await flipWave(n);
    expect(bookable.applyBookableByUserId).toHaveBeenCalledTimes(MAX_ACTIVATIONS_PER_RUN);
    expect(result.bookableFlipped).toHaveLength(MAX_ACTIVATIONS_PER_RUN);
    expect(result.bookableDeferredToNextRun).toHaveLength(4);
  });

  it("says WHO it left, not just how many", async () => {
    // A count alone cannot be checked against anything. With the addresses, the
    // next run or a person can ask whether these specific agents came through.
    const result = await flipWave(MAX_ACTIVATIONS_PER_RUN + 1);
    expect(result.bookableDeferredToNextRun).toEqual([`u${MAX_ACTIVATIONS_PER_RUN}@x.com`]);
  });

  it("everyone it deferred keeps a pending mark, so nothing is dropped", async () => {
    // The mark IS the intent (#2071), and it is written with the attributes earlier
    // in this run rather than at the attempt, which is exactly what makes skipping
    // the attempt safe. Without it a deferral would be a silent drop.
    await flipWave(MAX_ACTIVATIONS_PER_RUN + 2);
    const upserts = store.calls.filter((c) => c.op === "upsert");
    const marked = upserts
      .flatMap((c) => c.payload as Record<string, unknown>[])
      .filter((r) => typeof r.bookable_pending_since === "string");
    expect(marked).toHaveLength(MAX_ACTIVATIONS_PER_RUN + 2);
  });

  it("a refused activation still spends its slot, because it cost the same Google calls", async () => {
    // The allowance bounds the WORK, not the successes. A refusal has already run
    // the reachability probe and the calendar read by the time it is refused, so
    // treating it as free would let a run of refusals blow the budget it exists to
    // protect.
    bookable.applyBookableByUserId.mockImplementation(async (userId: string) => ({
      status: "blocked",
      userId,
      reason: "calendar_unhydrated",
    }));
    const result = await flipWave(MAX_ACTIVATIONS_PER_RUN + 2);
    expect(bookable.applyBookableByUserId).toHaveBeenCalledTimes(MAX_ACTIVATIONS_PER_RUN);
    expect(result.bookableFlipped).toEqual([]);
    expect(result.bookablePending).toHaveLength(MAX_ACTIVATIONS_PER_RUN);
    expect(result.bookableDeferredToNextRun).toHaveLength(2);
  });

  it("the allowance is SHARED with the Twilio half of the same run", async () => {
    // Two independent budgets is not a budget: the real worst case would be double
    // the number anybody wrote down. The derivation of the number itself is pinned
    // in scripts/test-activation-allowance.ts, which is where the object lives.
    const shared = activationAllowance(2);
    await flipWave(3, shared);
    expect(shared.spent()).toBe(2);
    // And a second caller handed the SAME object gets nothing left.
    expect(shared.take()).toBe(false);
  });
});

// #2387: an email address that answers to MORE THAN ONE Salesforce record.
//
// Measured against the live org on 2026-08-31, two addresses are shared by more
// than one ACTIVE Salesforce user, so this is a real state and not a hypothetical
// one. The shape that misroutes a person is a rehire: a fresh Salesforce user is
// created for them and the old record is left inactive on the same address, or a
// new hire is given an address a colleague once had. The reap used to deactivate
// on ANY inactive record for the address, so the same run that read the address as
// active also took the person out of the roster, and `deactivated: 1` read as an
// ordinary departure.
describe("an address shared by two Salesforce records (#2387)", () => {
  /**
   * The Salesforce side, with a record id on every row.
   *
   * The presence query asks for the id now, because the id is the only thing that
   * can say WHICH of two records for one address a Slate row is about.
   */
  const sfWorld = (opts: {
    roster?: unknown[];
    present?: { Id?: string; Email: string; IsActive: boolean }[];
    presenceFails?: boolean;
  }) => {
    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      if (q.includes("IsActive = true AND Email != null AND (")) return sfResponse(opts.roster ?? []);
      // Matched on the part of the presence query that reads the same before and
      // after this change, so the fixture cannot silently answer nothing.
      if (q.includes("IsActive FROM User WHERE Email IN")) {
        if (opts.presenceFails) {
          return { ok: false, status: 500, text: async () => "Salesforce is having a bad minute" };
        }
        const asked = q.slice(q.indexOf("IN ("));
        return sfResponse((opts.present ?? []).filter((r) => asked.includes(`'${r.Email}'`)));
      }
      return sfResponse([]);
    });
  };

  /** The ids this run actually set `deactivated_at` on. */
  const deactivatedIds = () =>
    store.calls
      .filter((c) => c.op === "update" && (c.payload as { deactivated_at?: string }).deactivated_at)
      .flatMap((c) => (c.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2] as string[]) ?? []);

  beforeEach(() => {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    store.config.existing = [];
    store.config.afterInsert = [];
    store.config.reapable = [];
    bookable.applyBookableByUserId.mockClear();
  });

  it("does not deactivate a rehire whose stored id is the ACTIVE record", async () => {
    store.config.reapable = [
      { id: "u-rehire", email: "rehire@x.com", salesforce_user_id: "005NEW" },
    ];
    sfWorld({
      present: [
        { Id: "005NEW", Email: "rehire@x.com", IsActive: true },
        { Id: "005OLD", Email: "rehire@x.com", IsActive: false },
      ],
    });

    const result = await syncSalesforceAgents();

    expect(deactivatedIds()).not.toContain("u-rehire");
    expect(result.deactivated).toBe(0);
    // Nothing was refused either: the stored id SETTLED the question, so this is
    // an ordinary quiet run and not a state anybody has to look at.
    expect(result.deactivationsRefusedAmbiguous).toBe(0);
  });

  it("deactivates when the stored id is the INACTIVE record", async () => {
    store.config.reapable = [
      { id: "u-left", email: "shared@x.com", salesforce_user_id: "005OLD" },
    ];
    sfWorld({
      present: [
        { Id: "005NEW", Email: "shared@x.com", IsActive: true },
        { Id: "005OLD", Email: "shared@x.com", IsActive: false },
      ],
    });

    const result = await syncSalesforceAgents();

    expect(deactivatedIds()).toEqual(["u-left"]);
    expect(result.deactivated).toBe(1);
    expect(result.deactivationsRefusedAmbiguous).toBe(0);
  });

  it("REFUSES and reports when no stored id settles a shared address", async () => {
    store.config.reapable = [
      { id: "u-unknown", email: "shared@x.com", salesforce_user_id: null },
    ];
    sfWorld({
      present: [
        { Id: "005NEW", Email: "shared@x.com", IsActive: true },
        { Id: "005OLD", Email: "shared@x.com", IsActive: false },
      ],
    });

    const result = await syncSalesforceAgents();

    // Not deactivated, AND said out loud. Deactivating nobody in silence is a
    // different failure from deactivating the wrong person, and both are silent
    // unless the refusal is counted where the run's result is read (L98).
    expect(deactivatedIds()).not.toContain("u-unknown");
    expect(result.deactivated).toBe(0);
    expect(result.deactivationsRefusedAmbiguous).toBe(1);
  });

  it("still deactivates somebody whose only Salesforce record is inactive", async () => {
    // The control that stops an over broad fix passing: a genuine departure must
    // still be reaped, or this change trades one silent failure for another.
    store.config.reapable = [
      { id: "u-gone", email: "gone@x.com", salesforce_user_id: null },
      { id: "u-here", email: "here@x.com", salesforce_user_id: "005H" },
    ];
    sfWorld({
      present: [
        { Id: "005G", Email: "gone@x.com", IsActive: false },
        { Id: "005H", Email: "here@x.com", IsActive: true },
      ],
    });

    const result = await syncSalesforceAgents();

    expect(deactivatedIds()).toEqual(["u-gone"]);
    expect(result.deactivated).toBe(1);
    expect(result.deactivationsRefusedAmbiguous).toBe(0);
  });

  it("the divergence report reads the same shared address the same way", async () => {
    // One address, two records that disagree, and a Slate row with no id. The reap
    // refuses it, and the reconcile must not call it a departure or an active
    // person either: two readings of one address is what produced this defect.
    store.config.afterInsert = [
      { id: "u-shared", email: "shared@x.com", manager_id: null, role: "agent", salesforce_user_id: null, bookable: false, deactivated_at: null, is_test: false },
    ];
    store.config.reapable = [{ id: "u-shared", email: "shared@x.com", salesforce_user_id: null }];
    sfWorld({
      roster: [],
      present: [
        { Id: "005NEW", Email: "shared@x.com", IsActive: true },
        { Id: "005OLD", Email: "shared@x.com", IsActive: false },
      ],
    });

    const result = await syncSalesforceAgents();

    expect(result.deactivationsRefusedAmbiguous).toBe(1);
    expect(result.rosterUnconfirmedAmbiguous).toBe(1);
    expect(result.rosterUnconfirmedInactive).toBe(0);
    expect(result.rosterUnconfirmedUnmatched).toBe(0);
    expect(result.rosterUnconfirmedAbsent).toBe(0);
  });

  it("deactivates nobody when the presence read fails", async () => {
    store.config.reapable = [{ id: "u-left", email: "left@x.com", salesforce_user_id: null }];
    sfWorld({ presenceFails: true });

    await expect(syncSalesforceAgents()).rejects.toThrow(/SF query failed: 500/);
    expect(deactivatedIds()).toEqual([]);
  });
});

/** The decoded SOQL of every Salesforce query this run sent. */
function soqlOfRun(): string[] {
  return sf.fetchSfWithRetry.mock.calls
    .map((c) => String(c[0]))
    .filter((url) => url.includes("q="))
    .map((url) => decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " ")));
}

/**
 * One fake Salesforce answering each of the sync's five User queries from its own
 * list, so a test can put a record in exactly the query that would return it.
 */
function sfByQuery(opts: {
  roster?: unknown[];
  managerExact?: unknown[];
  managerLastName?: unknown[];
  byEmail?: unknown[];
  presence?: unknown[];
}) {
  sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
    if (url.includes("oauth2/token")) {
      return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
    }
    const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
    if (q.includes("IsActive = true AND Email != null AND (")) return sfResponse(opts.roster ?? []);
    if (q.includes("LastName IN (")) return sfResponse(opts.managerLastName ?? []);
    if (q.includes("Name IN (")) return sfResponse(opts.managerExact ?? []);
    if (q.includes("IsActive = true AND Email != null AND Email IN")) return sfResponse(opts.byEmail ?? []);
    if (q.includes("IsActive FROM User WHERE Email IN")) return sfResponse(opts.presence ?? []);
    return sfResponse([]);
  });
}

// #3668: the conflict page tells its reader the sf-sync log line names the Slate
// rows. For an AMBIGUOUS email the line carried only a count, so the pointer led
// nowhere and the row took a hand query against Salesforce to find. This drives all
// three conflict shapes through the real sync in one run and reads the line itself.
describe("the Salesforce id conflict log line names the rows of every shape (#3668)", () => {
  const SF_A = "005AAAAAAAAAAAAAAA";
  const SF_B = "005BBBBBBBBBBBBBBB";
  const SF_C = "005CCCCCCCCCCCCCCC";

  beforeEach(() => {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    store.config.existing = [];
    store.config.reapable = [];
    sf.fetchSfWithRetry.mockReset();
  });

  it("carries disagreeing, ambiguous and claimed Slate ids, and no email", async () => {
    store.config.afterInsert = [
      { id: "u-dis", email: "dis@x.com", manager_id: null, role: "agent", salesforce_user_id: SF_A },
      { id: "u-amb", email: "shared@x.com", manager_id: null, role: "agent", salesforce_user_id: null },
      { id: "u-cla", email: "claimer@x.com", manager_id: null, role: "agent", salesforce_user_id: null },
      { id: "u-holder", email: "holder@x.com", manager_id: null, role: "agent", salesforce_user_id: SF_C },
    ];
    sfByQuery({
      roster: [
        { Id: SF_B, Email: "dis@x.com", Name: "Dis", HighDebt__c: true },
        { Id: "005D1AAAAAAAAAAAAA", Email: "shared@x.com", Name: "Shared One", HighDebt__c: true },
        { Id: "005D2AAAAAAAAAAAAA", Email: "shared@x.com", Name: "Shared Two", HighDebt__c: true },
        { Id: SF_C, Email: "claimer@x.com", Name: "Claimer", HighDebt__c: true },
      ],
    });
    const warn = vi.spyOn(log, "warn");
    try {
      const result = await syncSalesforceAgents();

      // The fixture really produced all three shapes, or the line below proves nothing.
      expect(result.salesforceIdDisagreements).toBe(1);
      expect(result.salesforceIdAmbiguous).toBe(1);
      expect(result.salesforceIdClaimed).toBe(1);

      const line = warn.mock.calls.find(
        ([tag, fields]) => tag === "sf-sync" && String(fields?.msg ?? "").includes("user id conflicts"),
      )?.[1];
      expect(line).toBeDefined();
      expect(line).toMatchObject({ disagreements: 1, ambiguous: 1, claimed: 1 });
      expect(String(line?.disagreeing_user_ids).split(", ")).toContain("u-dis");
      expect(String(line?.ambiguous_user_ids).split(", ")).toContain("u-amb");
      expect(String(line?.claimed_user_ids).split(", ")).toContain("u-cla");
      // Slate ids only, so a log search never becomes a roster export (L222).
      expect(JSON.stringify(line)).not.toContain("@");
    } finally {
      warn.mockRestore();
    }
  });
});

// #3669: an API only integration account is never a person, so it must never
// answer for one. On 2026-10-13 one was created carrying a staff member's email (an
// integration account needs a deliverable address), so the hourly sync found two
// active users for that address and paged an ambiguous conflict about a person with
// nothing wrong. The predicate is the PROFILE's API only permission, read against
// the live org; the pure half is pinned in scripts/test-salesforce-api-only.ts.
describe("API only Salesforce accounts are left out of the roster's matching (#3669)", () => {
  const SF_PERSON = "005PPPPPPPPPPPPPPP";
  const SF_BOT = "005IIIIIIIIIIIIIII";
  const PERSON_PROFILE = { Name: "System Administrator", PermissionsApiUserOnly: false };
  const BOT_PROFILE = { Name: "Salesforce API Only System Integrations", PermissionsApiUserOnly: true };

  const idWrites = () =>
    store.calls
      .filter((c) => c.op === "upsert")
      .flatMap((c) => (c.payload as Record<string, unknown>[]) ?? [])
      .filter((row) => "salesforce_user_id" in row);

  const exclusionLine = (info: ReturnType<typeof vi.spyOn>) =>
    (info.mock.calls as [string, Record<string, unknown>][]).find(
      ([tag, fields]) => tag === "sf-sync" && String(fields?.msg ?? "").includes("API only"),
    )?.[1];

  beforeEach(() => {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    store.config.existing = [];
    store.config.reapable = [];
    store.config.afterInsert = [];
    sf.fetchSfWithRetry.mockReset();
  });

  it("links the person when an integration account shares their email, and counts the exclusion", async () => {
    // The measured shape: a staff member outside the debt team query, reached by
    // the by-email backfill, which also returns the integration account.
    store.config.afterInsert = [
      { id: "u-staff", email: "staff@x.com", manager_id: null, role: "admin", salesforce_user_id: null },
    ];
    sfByQuery({
      byEmail: [
        { Id: SF_PERSON, Email: "staff@x.com", Profile: PERSON_PROFILE },
        { Id: SF_BOT, Email: "staff@x.com", Profile: BOT_PROFILE },
      ],
    });
    const info = vi.spyOn(log, "info");
    try {
      const result = await syncSalesforceAgents();

      expect(result.salesforceIdAmbiguous).toBe(0);
      expect(result.salesforceIdsLinked).toBe(1);
      expect(idWrites()).toEqual([expect.objectContaining({ id: "u-staff", salesforce_user_id: SF_PERSON })]);
      expect(JSON.stringify(store.calls)).not.toContain(SF_BOT);

      // Counted, so a real person mis-profiled as an integration is visible rather
      // than silently dropped.
      const line = exclusionLine(info);
      expect(line).toMatchObject({ count: 1, roster_matches: 1 });
      expect(String(line?.salesforce_user_ids)).toContain(SF_BOT);
      expect(JSON.stringify(line)).not.toContain("@");
    } finally {
      info.mockRestore();
    }
  });

  it("control: the same two records with no API only profile still page as ambiguous", async () => {
    // Without this, the test above would pass on a sync that simply stopped
    // reading the second record for any reason at all.
    store.config.afterInsert = [
      { id: "u-staff", email: "staff@x.com", manager_id: null, role: "admin", salesforce_user_id: null },
    ];
    sfByQuery({
      byEmail: [
        { Id: SF_PERSON, Email: "staff@x.com", Profile: PERSON_PROFILE },
        { Id: SF_BOT, Email: "staff@x.com", Profile: PERSON_PROFILE },
      ],
    });
    const info = vi.spyOn(log, "info");
    try {
      const result = await syncSalesforceAgents();
      expect(result.salesforceIdAmbiguous).toBe(1);
      expect(idWrites()).toHaveLength(0);
      // Nothing was excluded, so the exclusion line is not written at all.
      expect(exclusionLine(info)).toBeUndefined();
    } finally {
      info.mockRestore();
    }
  });

  it("never creates a roster row for an integration account, even one carrying a tier", async () => {
    sfByQuery({
      roster: [
        { Id: SF_BOT, Email: "bot@x.com", Name: "Integration Bot", HighDebt__c: true, Profile: BOT_PROFILE },
        { Id: SF_PERSON, Email: "new@x.com", Name: "New Hire", HighDebt__c: true, Profile: { Name: "Sales", PermissionsApiUserOnly: false } },
      ],
    });
    store.config.afterInsert = [
      { id: "u-new", email: "new@x.com", manager_id: null, role: "agent", salesforce_user_id: null },
    ];

    const result = await syncSalesforceAgents();

    const inserted = store.calls
      .filter((c) => c.op === "insert" && c.table === "users")
      .flatMap((c) => (c.payload as Record<string, unknown>[]) ?? []);
    expect(inserted.map((r) => r.email)).toEqual(["new@x.com"]);
    expect(result.inserted).toBe(1);
  });

  it("reaps a departed person whose address an active integration account also carries", async () => {
    // Read address wide, an inactive person beside an ACTIVE record is a refusal
    // (#2387). The active record here is not a person, so the person has left.
    store.config.reapable = [{ id: "u-left", email: "left@x.com", salesforce_user_id: null }];
    sfByQuery({
      presence: [
        { Id: "005OLDAAAAAAAAAAAA", Email: "left@x.com", IsActive: false, Profile: PERSON_PROFILE },
        { Id: SF_BOT, Email: "left@x.com", IsActive: true, Profile: BOT_PROFILE },
      ],
    });

    const result = await syncSalesforceAgents();

    expect(result.deactivationsRefusedAmbiguous).toBe(0);
    expect(result.deactivated).toBe(1);
  });

  it("does not let an integration account answer to a manager picklist name", async () => {
    store.config.afterInsert = [
      { id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: null },
      { id: "u3", email: "mona@x.com", manager_id: null, role: "manager", salesforce_user_id: null },
    ];
    sfByQuery({
      roster: [{ Id: SF_PERSON, Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true }],
      managerExact: [
        { Id: "005MONAAAAAAAAAAAA", Name: "Mona Manager", Email: "mona@x.com", Profile: PERSON_PROFILE },
        { Id: SF_BOT, Name: "Mona Manager", Email: "bot@x.com", Profile: BOT_PROFILE },
      ],
    });

    const result = await syncSalesforceAgents();

    // Two records answering to the name would be an ambiguous manager (#1653).
    expect(result.managersAmbiguous).toBe(0);
    expect(result.managersLinked).toBe(1);
  });

  it("every User query the sync sends selects the profile's API only flag", async () => {
    // All five queries are made to run: the roster, both manager name passes, the
    // by-email backfill and the presence read. A query that does not SELECT the
    // flag returns records the predicate reads as people, so the exclusion would
    // stop applying to it in silence.
    store.config.afterInsert = [
      { id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: null },
      { id: "u9", email: "boss@x.com", manager_id: null, role: "admin", salesforce_user_id: null },
    ];
    store.config.reapable = [{ id: "u-left", email: "left@x.com", salesforce_user_id: null }];
    sfByQuery({
      roster: [
        { Id: SF_PERSON, Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
        { Id: "005B2AAAAAAAAAAAAA", Email: "b@x.com", Name: "Agent B", Agent_Manager__c: "Mike Dugan", HighDebt__c: true },
      ],
    });

    await syncSalesforceAgents();

    const sent = soqlOfRun();
    const kinds = {
      roster: sent.filter((q) => q.includes("IsActive = true AND Email != null AND (")),
      managerExact: sent.filter((q) => q.includes("Name IN (") && !q.includes("LastName IN (")),
      managerLastName: sent.filter((q) => q.includes("LastName IN (")),
      byEmail: sent.filter((q) => q.includes("IsActive = true AND Email != null AND Email IN")),
      presence: sent.filter((q) => q.includes("IsActive FROM User WHERE Email IN")),
    };
    for (const [kind, queries] of Object.entries(kinds)) {
      expect(queries.length, `the ${kind} query ran`).toBeGreaterThan(0);
    }
    for (const q of sent) {
      const selectClause = q.slice(0, q.indexOf(" FROM User"));
      expect(selectClause, q).toContain("Profile.PermissionsApiUserOnly");
    }
  });
});
