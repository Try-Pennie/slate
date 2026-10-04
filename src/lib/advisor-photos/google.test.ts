import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3144 (L742): the photo lane reads the directory on a delegated token cached for
// most of an hour. A 401 on that token used to be classed as REFUSED, the
// permanent kind no retry fixes, so one stale token failed the run as though the
// subject had lost its admin role. It is resent once on a fresh token, and only a
// second refusal is the permanent kind.

const dwd = vi.hoisted(() => ({ getDelegatedToken: vi.fn() }));
vi.mock("@/lib/google/dwd", () => dwd);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { listDirectoryAccounts, getDirectoryPhoto, DIRECTORY_SCOPE } from "./google";
import { DirectoryReadError } from "./refresh";

describe("directory reads on a refused token (#3144)", () => {
  beforeEach(() => {
    dwd.getDelegatedToken.mockReset();
    dwd.getDelegatedToken.mockImplementation(async (_e: string, _s?: string, _d?: unknown, rejected?: string) =>
      rejected ? "fresh" : "stale",
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const refusingStale = () => {
    const auths: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization");
      auths.push(auth);
      if (auth === "Bearer stale") return new Response("Invalid Credentials", { status: 401 });
      return new Response(JSON.stringify({ users: [{ primaryEmail: "a@x.com" }], photoData: "abc" }), { status: 200 });
    });
    return auths;
  };

  it("lists the directory on a fresh token after the cached one is refused", async () => {
    const auths = refusingStale();
    await expect(listDirectoryAccounts("admin@x.com")).resolves.toEqual([{ primaryEmail: "a@x.com" }]);
    expect(auths).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(dwd.getDelegatedToken).toHaveBeenLastCalledWith("admin@x.com", DIRECTORY_SCOPE, undefined, "stale");
  });

  it("reads a photo on a fresh token after the cached one is refused", async () => {
    const auths = refusingStale();
    const res = await getDirectoryPhoto("admin@x.com", "a@x.com");
    expect(res.status).toBe(200);
    expect(auths).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("classes a second refusal as refused, after exactly one resend", async () => {
    let sends = 0;
    vi.stubGlobal("fetch", async () => {
      sends += 1;
      return new Response("unauthorized", { status: 401 });
    });
    const err = await listDirectoryAccounts("admin@x.com").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DirectoryReadError);
    expect((err as DirectoryReadError).refused).toBe(true);
    expect(sends).toBe(2);
  });
});
