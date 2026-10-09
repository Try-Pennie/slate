import { describe, it, expect, vi, beforeEach } from "vitest";

// #3495: the live check on a confirm read each advisor by email to find their id, then
// their calendars by id. The confirm already holds those ids (the ladder read or the
// emails read it just made), so handed them, `calendarsForEmails` reads only the
// calendars: one database request fewer on every confirm, which is what queues a crowd
// (#3492). Without ids, or missing one, it reads the advisors as before.

const reads = vi.hoisted(() => ({ tables: [] as string[] }));
const admin = vi.hoisted(() => {
  const rows: Record<string, unknown[]> = {
    users: [
      { id: "u-a", email: "a@x.com" },
      { id: "u-b", email: "b@x.com" },
    ],
    agent_calendars: [
      { user_id: "u-a", calendar_id: "a-cal" },
      { user_id: "u-b", calendar_id: "b-cal" },
    ],
  };
  const client = {
    from: (table: string) => ({
      select: () => ({
        in: async () => {
          reads.tables.push(table);
          return { data: rows[table] ?? [], error: null };
        },
      }),
    }),
  };
  return { supabaseAdmin: vi.fn(() => client) };
});
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: admin.supabaseAdmin }));

import { calendarsForEmails } from "./service";

describe("calendarsForEmails reads by the ids a confirm already holds (#3495)", () => {
  beforeEach(() => {
    reads.tables = [];
  });

  it("reads only the calendars when every email's advisor id is given", async () => {
    const got = await calendarsForEmails(["a@x.com", "b@x.com"], new Map([["a@x.com", "u-a"], ["b@x.com", "u-b"]]));
    expect(reads.tables).toEqual(["agent_calendars"]);
    expect(Object.fromEntries(got.byEmail)).toEqual({ "a@x.com": ["a-cal"], "b@x.com": ["b-cal"] });
    expect([...got.readFailed]).toEqual([]);
  });

  it("reads the advisors by email first when no ids are given", async () => {
    const got = await calendarsForEmails(["a@x.com", "b@x.com"]);
    expect(reads.tables).toEqual(["users", "agent_calendars"]);
    expect(Object.fromEntries(got.byEmail)).toEqual({ "a@x.com": ["a-cal"], "b@x.com": ["b-cal"] });
  });

  it("reads the advisors by email when any email's id is missing, so none is guessed", async () => {
    await calendarsForEmails(["a@x.com", "b@x.com"], new Map([["a@x.com", "u-a"]]));
    expect(reads.tables).toEqual(["users", "agent_calendars"]);
  });
});
