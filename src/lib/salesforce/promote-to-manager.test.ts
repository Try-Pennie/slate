import { describe, it, expect } from "vitest";
import { promoteToManager } from "./sync";

// #2482: the roster sync counted people promoted whether or not the update landed.
// A refused write left `managersPromoted` naming people who are still agents, so the
// run reported them promoted and the approver who cannot open the time off queue
// looks like a Slate defect rather than a write that never happened.

type Client = Parameters<typeof promoteToManager>[0];

/** The narrow slice of the client this reads. Cast at the boundary, so production
 *  keeps the real type and the fake stays readable. */
function db(error: { message: string } | null, seen: { ids?: string[] } = {}): Client {
  return {
    from: () => ({
      update: () => ({
        in: async (_col: string, ids: string[]) => {
          seen.ids = ids;
          return { error };
        },
      }),
    }),
  } as unknown as Client;
}

describe("promoteToManager", () => {
  it("refuses rather than reporting a promotion that did not happen", async () => {
    const client = db({ message: "permission denied for table users" });
    await expect(promoteToManager(client, ["u1", "u2"])).rejects.toThrow(/permission denied/);
  });

  it("says how many it was promoting, so the message names the scale", async () => {
    const client = db({ message: "deadlock detected" });
    await expect(promoteToManager(client, ["u1", "u2", "u3"])).rejects.toThrow(
      /3 manager\(s\)/,
    );
  });

  // CONTROL: without this the two above are satisfied by a function that always
  // throws, which would fail every roster sync (L159).
  it("CONTROL: a write that lands reports the count, and wrote those ids", async () => {
    const seen: { ids?: string[] } = {};
    await expect(promoteToManager(db(null, seen), ["u1", "u2"])).resolves.toBe(2);
    expect(seen.ids).toEqual(["u1", "u2"]);
  });

  // Nobody to promote is not a refusal and must not reach the database at all: an
  // `.in("id", [])` is a statement with no subject, and a run that promotes nobody
  // is the ordinary case rather than a finding.
  it("writes nothing, and reports nothing, when there is nobody to promote", async () => {
    const seen: { ids?: string[] } = {};
    await expect(promoteToManager(db(null, seen), [])).resolves.toBe(0);
    expect(seen.ids).toBeUndefined();
  });
});
