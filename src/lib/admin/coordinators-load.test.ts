import { describe, it, expect, vi, beforeEach } from "vitest";

// #4264 (D10, D14): the reads behind the Coordinator booking page's list. A failed users read is
// its own answer, never an empty list; one person's unreadable sign in is said in their own cell.
const logger = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/log", () => logger);

import { loadCoordinators, type CoordinatorsLoadDeps } from "./coordinators-load";

const NOW = Date.parse("2026-10-27T19:00:00Z"); // 15:00 Eastern
const deps = (over: Partial<CoordinatorsLoadDeps> = {}): CoordinatorsLoadDeps => ({
  readCoordinators: vi.fn(async () => [
    { id: "t", name: "Tomas Rivera", email: "trivera@trypennie.com", auth_user_id: "a-t" },
    { id: "a", name: "Aisha Bello", email: "abello@trypennie.com", auth_user_id: "a-a" },
    { id: "n", name: null, email: "new.person@trypennie.com", auth_user_id: null },
  ]),
  readLastSignIn: vi.fn(async (id: string) => (id === "a-a" ? "2026-10-27T17:00:00Z" : "2026-09-19T15:00:00Z")),
  now: () => NOW,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("loadCoordinators", () => {
  it("reads the caller's own organisation and lists everybody alphabetically, with when they signed in", async () => {
    const d = deps();
    const read = await loadCoordinators("org-1", d);
    expect(d.readCoordinators).toHaveBeenCalledWith("org-1");
    expect(read).toEqual({
      ok: true,
      rows: [
        { id: "a", name: "Aisha Bello", email: "abello@trypennie.com", lastSignedIn: "2 hours ago" },
        { id: "n", name: "new.person@trypennie.com", email: "new.person@trypennie.com", lastSignedIn: "Never signed in" },
        { id: "t", name: "Tomas Rivera", email: "trivera@trypennie.com", lastSignedIn: "38 days ago" },
      ],
    });
    // Nobody to look up for a person with no sign in account.
    expect(d.readLastSignIn).toHaveBeenCalledTimes(2);
  });

  it("answers a failed read as a failure, never as nobody, and logs it", async () => {
    const err = new Error("coordinators read failed: timeout");
    const read = await loadCoordinators("org-1", deps({ readCoordinators: vi.fn(async () => { throw err; }) }));
    expect(read).toEqual({ ok: false });
    expect(logger.log.error).toHaveBeenCalledWith("coordinator-booking", { msg: "coordinators read failed" }, err);
  });

  it("says one person's sign in could not be read, and still lists everybody", async () => {
    const read = await loadCoordinators(
      "org-1",
      deps({ readLastSignIn: vi.fn(async (id: string) => { if (id === "a-t") throw new Error("auth down"); return null; }) }),
    );
    expect(read.ok && read.rows.map((r) => [r.name, r.lastSignedIn])).toEqual([
      ["Aisha Bello", "Never signed in"],
      ["new.person@trypennie.com", "Never signed in"],
      ["Tomas Rivera", "Could not read"],
    ]);
    expect(logger.log.warn).toHaveBeenCalledWith("coordinator-booking", { msg: "last sign in unreadable", user_id: "t" }, expect.any(Error));
  });

  it("answers an organisation with no coordinators as an empty list, for the page to say so", async () => {
    expect(await loadCoordinators("org-1", deps({ readCoordinators: vi.fn(async () => []) }))).toEqual({ ok: true, rows: [] });
  });
});
