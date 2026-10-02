import { describe, it, expect, vi, beforeEach } from "vitest";

// The reads behind an advisor link. Since #3026 a link carries either a readable
// NAME (agent_link_names) or an old #2073 TOKEN (agent_links), and ONE resolver
// decides which; every refusal reaches the caller as the same judgement whatever
// the link was. #2831: the pool a refused advisor link offers instead. Only a link
// still naming somebody who has left or is not bookable is read at all; every
// other refusal answers the catch all with no read, and a failed read throws
// rather than quietly offering the catch all to a lead whose pool is known.

type Result = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({
  results: {} as Record<string, Result>,
  reads: [] as { table: string; filters: [string, unknown][] }[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const read = { table, filters: [] as [string, unknown][] };
      db.reads.push(read);
      const res = db.results[table] ?? { data: null, error: null };
      const chain = {
        select: () => chain,
        eq: (col: string, value: unknown) => {
          read.filters.push([col, value]);
          return chain;
        },
        in: () => Promise.resolve(res),
        maybeSingle: () => Promise.resolve(res),
      };
      return chain;
    },
  }),
}));
const precompute = vi.hoisted(() => ({ bucketsForAgent: vi.fn(async () => ["511", "411", "SMOKE"]) }));
vi.mock("@/lib/availability/precompute", () => precompute);

import { agentLinkPoolCode, loadAgentLinkName, resolveAgentLink } from "./store";
import * as store from "./store";

const TOKEN = "ab".repeat(32);
const NAME = "rdaboub";
const AGENT = { id: "u1", name: "Rami Daboub", email: "rdaboub@trypennie.com", bookable: true, deactivated_at: null };

beforeEach(() => {
  db.reads = [];
  db.results = {
    agent_links: { data: { user_id: "u1" }, error: null },
    agent_link_names: { data: { user_id: "u1" }, error: null },
    users: { data: AGENT, error: null },
    buckets: {
      data: [
        { code: "511", is_test: false },
        { code: "411", is_test: false },
        { code: "SMOKE", is_test: true },
      ],
      error: null,
    },
  };
  precompute.bucketsForAgent.mockClear();
});

const tablesRead = () => db.reads.map((r) => r.table);

describe("resolveAgentLink (#3026)", () => {
  it("books the advisor a NAME belongs to, read from the names table", async () => {
    const judged = await resolveAgentLink(NAME);
    expect(judged.ok && judged.agent.id).toBe("u1");
    expect(judged.ok && judged.bucketCode).toBe("411");
    expect(db.reads[0]).toEqual({ table: "agent_link_names", filters: [["name", NAME]] });
    expect(tablesRead()).not.toContain("agent_links");
  });

  it("still books the advisor an OLD token belongs to, read from the token table", async () => {
    const judged = await resolveAgentLink(TOKEN);
    expect(judged.ok && judged.agent.id).toBe("u1");
    expect(db.reads[0]).toEqual({ table: "agent_links", filters: [["token", TOKEN]] });
    expect(tablesRead()).not.toContain("agent_link_names");
  });

  it("refuses an unknown name, an unknown token and a malformed value with one identical judgement", async () => {
    db.results.agent_link_names = { data: null, error: null };
    db.results.agent_links = { data: null, error: null };
    const unknownName = await resolveAgentLink("nobody");
    const unknownToken = await resolveAgentLink("cd".repeat(32));
    db.reads = [];
    const malformed = await resolveAgentLink("../etc");
    expect(unknownName).toEqual({ ok: false, why: "unknown" });
    expect(unknownToken).toEqual(unknownName);
    expect(malformed).toEqual(unknownName);
    // A value that can be neither costs no read at all.
    expect(db.reads).toEqual([]);
  });

  it("refuses a reserved name whose user was deleted exactly like an unknown one", async () => {
    // migration 0155: a deleted user leaves the name with user_id null.
    db.results.agent_link_names = { data: { user_id: null }, error: null };
    expect(await resolveAgentLink(NAME)).toEqual({ ok: false, why: "unknown" });
    expect(tablesRead()).not.toContain("users");
  });

  it("throws on a failed name read rather than calling the link unknown", async () => {
    db.results.agent_link_names = { data: null, error: { message: "names down" } };
    await expect(resolveAgentLink(NAME)).rejects.toThrow("names down");
  });
});

describe("loadAgentLinkName (#3026)", () => {
  it("is the user's reserved name", async () => {
    db.results.agent_link_names = { data: { name: NAME }, error: null };
    expect(await loadAgentLinkName("u1")).toBe(NAME);
    expect(db.reads[0]).toEqual({ table: "agent_link_names", filters: [["user_id", "u1"]] });
  });

  it("is null for a user with no name", async () => {
    db.results.agent_link_names = { data: null, error: null };
    expect(await loadAgentLinkName("u1")).toBeNull();
  });

  it("throws on a failed read", async () => {
    db.results.agent_link_names = { data: null, error: { message: "boom" } };
    await expect(loadAgentLinkName("u1")).rejects.toThrow("boom");
  });
});

describe("the replace write is gone (#3026)", () => {
  it("exports no way to replace a link", () => {
    expect("replaceAgentLinkToken" in store).toBe(false);
    expect("loadAgentLinkToken" in store).toBe(false);
    // Positive control: the module namespace is the real one.
    expect("resolveAgentLink" in store).toBe(true);
  });
});

describe("agentLinkPoolCode (#2831)", () => {
  it.each(["departed", "not_bookable"] as const)("offers a %s advisor's lowest real bucket, by token", async (why) => {
    expect(await agentLinkPoolCode(TOKEN, why)).toBe("411");
    expect(precompute.bucketsForAgent).toHaveBeenCalledWith("u1");
  });

  it.each(["departed", "not_bookable"] as const)("offers a %s advisor's lowest real bucket, by name", async (why) => {
    expect(await agentLinkPoolCode(NAME, why)).toBe("411");
    expect(db.reads[0].table).toBe("agent_link_names");
  });

  it.each(["unknown", "no_bucket"] as const)("answers the catch all for %s without reading anything", async (why) => {
    expect(await agentLinkPoolCode(TOKEN, why)).toBeNull();
    expect(await agentLinkPoolCode(NAME, why)).toBeNull();
    expect(db.reads).toEqual([]);
  });

  it("answers the catch all for a token that no longer names anybody", async () => {
    db.results.agent_links = { data: null, error: null };
    expect(await agentLinkPoolCode(TOKEN, "departed")).toBeNull();
    expect(precompute.bucketsForAgent).not.toHaveBeenCalled();
  });

  it("answers the catch all for an advisor in only a test bucket", async () => {
    db.results.buckets = { data: [{ code: "SMOKE", is_test: true }], error: null };
    expect(await agentLinkPoolCode(TOKEN, "not_bookable")).toBeNull();
  });

  it("throws on a failed link read rather than offering the catch all", async () => {
    db.results.agent_links = { data: null, error: { message: "boom" } };
    await expect(agentLinkPoolCode(TOKEN, "departed")).rejects.toThrow("boom");
  });

  it("throws on a failed bucket read rather than offering the catch all", async () => {
    db.results.buckets = { data: null, error: { message: "buckets down" } };
    await expect(agentLinkPoolCode(TOKEN, "departed")).rejects.toThrow("buckets down");
  });
});
