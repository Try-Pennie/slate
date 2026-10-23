import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Role, User } from "@/lib/db/types";
import * as logModule from "@/lib/log";
import {
  encodeImpersonationCookie,
  IMPERSONATE_TTL_MS,
} from "@/lib/auth/impersonation";

// Integration coverage for the #588 impersonation role ceiling as it runs
// through the real DB/cookie boundary in currentUser + getImpersonation. The
// pure predicate (canImpersonate) is unit-tested in scripts/test-roles.ts; this
// verifies the wiring actually applies it after fetching the target: an admin
// impersonating someone who outranks-or-equals them must resolve back to the
// admin, never to the higher-ranked target.

// Queue of rows returned by the chained supabase builder's maybeSingle(), in
// call order: [ real signed-in user, impersonation target ].
// A queued row is returned as `data`; the sentinel `{ __error: true }` simulates a
// transient query failure ({ data: null, error }) for that call.
const DB_ERROR = { __error: true } as const;
const dbRows = vi.hoisted(() => ({ queue: [] as (unknown | null)[] }));
const maybeSingle = vi.hoisted(() =>
  vi.fn(async () => {
    const next = dbRows.queue.shift() ?? null;
    if (next && typeof next === "object" && "__error" in next) {
      return { data: null, error: { message: "transient" } };
    }
    return { data: next, error: null };
  }),
);
const builder = vi.hoisted(() => {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.is = () => b;
  b.maybeSingle = maybeSingle;
  return b;
});
/** A Google identity as GoTrue returns it on the auth user (#3526). */
type FakeIdentity = { provider: string; identity_data?: Record<string, unknown> };
const googleIdentity = (sub: string): FakeIdentity => ({ provider: "google", identity_data: { sub } });
const authUser = vi.hoisted(() => ({
  id: "auth-1" as string | null,
  // Every staff auth user in production holds one Google identity (read
  // 2026-10-23), so that is the default every suite below runs with.
  identities: [{ provider: "google", identity_data: { sub: "sub-1" } }] as {
    provider: string;
    identity_data?: Record<string, unknown>;
  }[],
  userMetadata: {} as Record<string, unknown>,
}));
const cookieValue = vi.hoisted(() => ({ v: undefined as string | undefined }));
const signOut = vi.hoisted(() => vi.fn(async (_opts?: unknown) => ({ error: null })));
// #3526: the refusal alert, the same one the sign in callback sends.
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ from: () => builder }),
}));
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: {
      getUser: async () => ({
        data: {
          user: authUser.id
            ? { id: authUser.id, identities: authUser.identities, user_metadata: authUser.userMetadata }
            : null,
        },
      }),
      signOut,
    },
  }),
}));
vi.mock("@/lib/auth/dev-preview", () => ({ devPreviewUser: async () => null }));
// #3084: the session age stamps are read from the same store. They default to a session
// signed in a minute ago, so every suite below exercises its own rule rather than age.
const stamps = vi.hoisted(() => ({
  started: undefined as string | undefined,
  seen: undefined as string | undefined,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value =
        name === "slate-signed-in-at" ? stamps.started : name === "slate-last-seen-at" ? stamps.seen : cookieValue.v;
      return value ? { value } : undefined;
    },
  }),
}));

import {
  currentUser,
  realCurrentUser,
  getImpersonation,
  getImpersonationView,
  requireRole,
  requireManager,
  requireAdmin,
  requireSuperAdmin,
} from "@/lib/auth";

const ORG = "org-1";
const user = (id: string, role: Role, extra: Partial<User> = {}): User =>
  ({
    id,
    org_id: ORG,
    auth_user_id: role === "agent" ? null : "auth-1",
    email: `${id}@trypennie.com`,
    name: id,
    role,
    google_sub: null,
    avatar_url: null,
    attributes: {},
    bookable: true,
    deactivated_at: null,
    last_synced_at: null,
    manager_id: null,
    ...extra,
  }) as User;

// The "view as" cookie is signed (#3113) with the key `impersonationSigningSecret`
// reads, so the suite gives it one and mints cookies the way startImpersonation does.
const SIGNING_SECRET = "test-signing-secret";
const signed = (issuerId: string, targetId: string, issuedAtMs: number) =>
  encodeImpersonationCookie({ issuerId, targetId, issuedAtMs, secret: SIGNING_SECRET });

// Arrange a session for `real` impersonating `target` (target null = the row
// the target-fetch returns, e.g. null when deactivated/vanished).
async function arrange(real: User, target: User | null) {
  authUser.id = real.auth_user_id ?? "auth-1";
  // A freshly-issued impersonation cookie (id + current timestamp, #653) so the
  // TTL check honors it and these tests exercise the ceiling, not expiry.
  cookieValue.v = await signed(real.id, target ? target.id : "some-target-id", Date.now());
  dbRows.queue = [real, target];
}

beforeEach(() => {
  vi.stubEnv("SUPABASE_SECRET_KEY", SIGNING_SECRET);
  vi.clearAllMocks();
  dbRows.queue = [];
  cookieValue.v = undefined;
  authUser.id = "auth-1";
  stamps.started = String(Date.now() - 60_000);
  stamps.seen = String(Date.now() - 60_000);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("currentUser impersonation ceiling (#588)", () => {
  it("blocks admin -> super_admin: acts as the admin, not the super_admin", async () => {
    const admin = user("admin-1", "admin");
    await arrange(admin, user("super-1", "super_admin"));
    const acting = await currentUser();
    expect(acting?.id).toBe("admin-1");
    expect(acting?.role).toBe("admin");
  });

  it("blocks admin -> peer admin (equal rank): acts as the real admin", async () => {
    const admin = user("admin-1", "admin");
    await arrange(admin, user("admin-2", "admin"));
    expect((await currentUser())?.id).toBe("admin-1");
  });

  it("allows admin -> agent (strictly below): acts as the agent", async () => {
    const admin = user("admin-1", "admin");
    await arrange(admin, user("agent-9", "agent"));
    expect((await currentUser())?.id).toBe("agent-9");
  });

  it("allows super_admin -> admin: acts as the admin", async () => {
    const su = user("super-1", "super_admin");
    await arrange(su, user("admin-3", "admin"));
    expect((await currentUser())?.id).toBe("admin-3");
  });

  it("falls back to the real user when the target vanished/deactivated", async () => {
    const admin = user("admin-1", "admin");
    await arrange(admin, null);
    expect((await currentUser())?.id).toBe("admin-1");
  });
});

// A plain signed-in session (no impersonation cookie): currentUser resolves to
// `who`. This is the denial chokepoint every admin/manager route + action funnels
// through, so its reject branch is the highest-value RBAC test (#606).
function signedInAs(who: User) {
  authUser.id = who.auth_user_id ?? "auth-1";
  cookieValue.v = undefined;
  dbRows.queue = [who];
}

describe("requireRole denial (#606)", () => {
  it("rejects an unauthenticated caller", async () => {
    authUser.id = null;
    cookieValue.v = undefined;
    dbRows.queue = [];
    await expect(requireManager()).rejects.toThrow("Not authorized");
  });

  it("rejects an agent from every manager+ gate", async () => {
    signedInAs(user("agent-9", "agent"));
    await expect(requireRole("manager")).rejects.toThrow("Not authorized");
    signedInAs(user("agent-9", "agent"));
    await expect(requireManager()).rejects.toThrow("Not authorized");
    signedInAs(user("agent-9", "agent"));
    await expect(requireAdmin()).rejects.toThrow("Not authorized");
  });

  it("rejects a manager from admin+ gates but allows the manager gate", async () => {
    signedInAs(user("mgr-1", "manager"));
    await expect(requireAdmin()).rejects.toThrow("Not authorized");
    signedInAs(user("mgr-1", "manager"));
    await expect(requireSuperAdmin()).rejects.toThrow("Not authorized");
    signedInAs(user("mgr-1", "manager"));
    expect((await requireManager()).id).toBe("mgr-1");
  });

  it("rejects an admin from the super_admin gate but allows admin and manager", async () => {
    signedInAs(user("admin-1", "admin"));
    await expect(requireSuperAdmin()).rejects.toThrow("Not authorized");
    signedInAs(user("admin-1", "admin"));
    expect((await requireAdmin()).id).toBe("admin-1");
    signedInAs(user("admin-1", "admin"));
    expect((await requireManager()).id).toBe("admin-1");
  });

  it("allows a caller that holds exactly the required rank", async () => {
    signedInAs(user("mgr-1", "manager"));
    expect((await requireRole("manager")).role).toBe("manager");
  });
});

describe("getImpersonation ceiling (#588)", () => {
  it("returns null when an admin's cookie points at a super_admin", async () => {
    const admin = user("admin-1", "admin");
    await arrange(admin, user("super-1", "super_admin"));
    expect(await getImpersonation()).toBeNull();
  });

  it("returns real+target for a valid down-rank impersonation", async () => {
    const admin = user("admin-1", "admin");
    await arrange(admin, user("agent-9", "agent"));
    const imp = await getImpersonation();
    expect(imp?.real.id).toBe("admin-1");
    expect(imp?.target.id).toBe("agent-9");
  });
});

// #652: a silently-dropped "view as" session must be distinguishable from a plain
// no-cookie request so the header can notify the admin and clear the stale cookie.
describe("getImpersonationView drop states (#652)", () => {
  it("reports a timed-out session (expired cookie) as dropped/expired without a DB lookup", async () => {
    const admin = user("admin-1", "admin");
    authUser.id = "auth-1";
    dbRows.queue = [admin]; // only realCurrentUser resolves; no target fetch
    cookieValue.v = await signed("admin-1", "agent-9", Date.now() - IMPERSONATE_TTL_MS - 1);
    const view = await getImpersonationView();
    expect(view.status).toBe("dropped");
    expect(view.status === "dropped" && view.reason).toBe("expired");
  });

  it("reports a vanished/deactivated target as dropped/unavailable", async () => {
    const admin = user("admin-1", "admin");
    await arrange(admin, null); // target row comes back null (deactivated or removed)
    const view = await getImpersonationView();
    expect(view.status).toBe("dropped");
    expect(view.status === "dropped" && view.reason).toBe("unavailable");
  });

  it("reports a target that now outranks the admin as dropped/unavailable (ceiling)", async () => {
    const admin = user("admin-1", "admin");
    await arrange(admin, user("super-1", "super_admin"));
    const view = await getImpersonationView();
    expect(view.status).toBe("dropped");
    expect(view.status === "dropped" && view.reason).toBe("unavailable");
  });

  it("does NOT drop the session on a transient target-lookup error (reverts to self, keeps the cookie)", async () => {
    const admin = user("admin-1", "admin");
    authUser.id = "auth-1";
    // realCurrentUser resolves the admin, then the target lookup errors out.
    dbRows.queue = [admin, DB_ERROR];
    cookieValue.v = await signed("admin-1", "agent-9", Date.now());
    // A DB blip must read as "none" (act as self this request), not a dropped
    // session, so the cookie is left intact to resume once the lookup recovers.
    expect((await getImpersonationView()).status).toBe("none");
  });

  // #3113: the two cookies an admin could write by hand before signing. Both
  // skipped the impersonate.start audit, and the future dated one never expired.
  it("refuses a hand-written unsigned cookie and a future-dated signed one, without a target lookup", async () => {
    const admin = user("admin-1", "admin");
    authUser.id = "auth-1";
    for (const cookie of [
      `agent-9.${Date.now()}`,
      await signed("admin-1", "agent-9", Date.now() + 365 * 24 * 60 * 60 * 1000),
    ]) {
      dbRows.queue = [admin, user("agent-9", "agent")];
      cookieValue.v = cookie;
      const view = await getImpersonationView();
      expect(view.status).toBe("dropped");
      // The target row was never read: only realCurrentUser consumed the queue.
      expect(dbRows.queue).toHaveLength(1);
    }
  });

  it("reports a valid down-rank session as active with the target", async () => {
    const admin = user("admin-1", "admin");
    await arrange(admin, user("agent-9", "agent"));
    const view = await getImpersonationView();
    expect(view.status).toBe("active");
    expect(view.status === "active" && view.target.id).toBe("agent-9");
  });

  it("reports a plain signed-in session (no cookie) as none, and currentUser stays self on a drop", async () => {
    const admin = user("admin-1", "admin");
    signedInAs(admin);
    expect((await getImpersonationView()).status).toBe("none");
    // On an expired cookie, currentUser must still resolve to the admin themselves.
    dbRows.queue = [admin];
    cookieValue.v = await signed("admin-1", "agent-9", Date.now() - IMPERSONATE_TTL_MS - 1);
    expect((await currentUser())?.id).toBe("admin-1");
  });
});

// #2378: a deactivated staff member kept their session AND their role. Every gate
// flows through realCurrentUser, which resolved the row by auth_user_id and never
// looked at `deactivated_at`, while the impersonation TARGET beside it was already
// filtered on exactly that column. So offboarding somebody took nothing away from
// them until their Supabase refresh token died, which by default has no absolute
// expiry (L137: a grant checked only where it is GRANTED is never re-checked for
// anyone holding a session).
//
// Every refusal here is paired with a live user of the SAME role in the SAME
// fixture (L159): a test asserting somebody was refused is satisfied by a fixture
// where nobody could ever get in.
describe("a deactivated session is refused (#2378)", () => {
  const LEFT = "2026-09-01T00:00:00.000Z";

  it("refuses a deactivated admin at the agent, manager and admin gates", async () => {
    for (const gate of ["agent", "manager", "admin"] as const) {
      signedInAs(user("admin-1", "admin", { deactivated_at: LEFT }));
      await expect(requireRole(gate)).rejects.toThrow("Not authorized");
    }
    for (const gate of ["agent", "manager", "admin"] as const) {
      signedInAs(user("admin-1", "admin"));
      expect((await requireRole(gate)).id).toBe("admin-1");
    }
  });

  it("refuses a deactivated manager and a deactivated agent at their own gate", async () => {
    signedInAs(user("mgr-1", "manager", { deactivated_at: LEFT }));
    await expect(requireManager()).rejects.toThrow("Not authorized");
    signedInAs(user("agent-9", "agent", { deactivated_at: LEFT }));
    await expect(requireRole("agent")).rejects.toThrow("Not authorized");

    signedInAs(user("mgr-1", "manager"));
    expect((await requireManager()).id).toBe("mgr-1");
    signedInAs(user("agent-9", "agent"));
    expect((await requireRole("agent")).id).toBe("agent-9");
  });

  it("resolves currentUser to null for a deactivated session", async () => {
    signedInAs(user("mgr-1", "manager", { deactivated_at: LEFT }));
    expect(await currentUser()).toBeNull();

    signedInAs(user("mgr-1", "manager"));
    expect((await currentUser())?.id).toBe("mgr-1");
  });

  // A deactivated admin must not get back in by acting as somebody else: the
  // ACTOR is judged before the target is ever fetched.
  it("does not let a deactivated admin act through an impersonation cookie", async () => {
    await arrange(user("admin-1", "admin", { deactivated_at: LEFT }), user("agent-9", "agent"));
    expect(await currentUser()).toBeNull();
    await expect(requireManager()).rejects.toThrow("Not authorized");

    await arrange(user("admin-1", "admin"), user("agent-9", "agent"));
    expect((await currentUser())?.id).toBe("agent-9");
  });

  // L42: a control that exists to protect somebody fails CLOSED. An unreadable
  // users row is "I could not tell whether they still work here", and the safe
  // answer to that is to refuse, not to admit. The cost is that a database blip
  // signs everybody out for the length of the blip, which is the correct side to
  // be wrong on for an authorization gate.
  it("fails closed when the session row read itself errors", async () => {
    authUser.id = "auth-1";
    cookieValue.v = undefined;
    dbRows.queue = [DB_ERROR];
    expect(await currentUser()).toBeNull();

    authUser.id = "auth-1";
    cookieValue.v = undefined;
    dbRows.queue = [DB_ERROR];
    await expect(requireManager()).rejects.toThrow("Not authorized");

    signedInAs(user("mgr-1", "manager"));
    expect((await requireManager()).id).toBe("mgr-1");
  });
});

// #3526: the sign in callback checks the Google account, but a session does not have
// to come through the callback. Somebody given a reused address can exchange the
// sign in code with Supabase themselves and set the cookies, and every request then
// resolved their auth user to the old row with no account check at all. So the check
// runs where a session BECOMES a row, on every request, the way the deactivation
// gate does, and it reads the Google identities GoTrue returns for the auth user,
// which the session holder cannot write (unlike `user_metadata`).
describe("a session whose Google account is not the row's is refused (#3526)", () => {
  beforeEach(() => {
    authUser.identities = [googleIdentity("sub-1")];
    authUser.userMetadata = {};
    signOut.mockClear();
    dispatch.sendThrottledAlert.mockClear();
  });
  afterEach(() => {
    authUser.identities = [googleIdentity("sub-1")];
    authUser.userMetadata = {};
  });

  it("refuses a session that reached the old row without the callback, ends it, and alerts", async () => {
    // The newcomer's Google account, auto linked to (or exchanged onto) the auth
    // user the old row is linked to.
    signedInAs(user("admin-1", "admin", { google_sub: "sub-old" }));
    authUser.identities = [googleIdentity("sub-new")];

    expect(await realCurrentUser()).toBeNull();
    await expect(requireAdmin()).rejects.toThrow("Not authorized");
    // Only THIS session is ended, never every session on the auth user.
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    const [key, , text] = dispatch.sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe("sign_in_google_account_mismatch:admin-1");
    expect(text).toContain("admin-1@trypennie.com");
  });

  it("admits the session when its one Google account is the row's", async () => {
    signedInAs(user("admin-1", "admin", { google_sub: "sub-1" }));
    expect((await realCurrentUser())?.id).toBe("admin-1");
    expect(signOut).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("refuses an auth user holding a second Google account beside the row's", async () => {
    signedInAs(user("admin-1", "admin", { google_sub: "sub-1" }));
    authUser.identities = [googleIdentity("sub-1"), googleIdentity("sub-intruder")];
    expect(await realCurrentUser()).toBeNull();
  });

  // A row that has never recorded an account is not armed yet, but an auth user
  // holding TWO Google accounts is exactly the auto linked takeover, so it is refused
  // even there rather than letting either one have the row.
  it("refuses two Google accounts on a row with no account recorded, and admits one", async () => {
    signedInAs(user("admin-1", "admin", { google_sub: null }));
    authUser.identities = [googleIdentity("sub-a"), googleIdentity("sub-b")];
    expect(await realCurrentUser()).toBeNull();

    signedInAs(user("admin-1", "admin", { google_sub: null }));
    authUser.identities = [googleIdentity("sub-a")];
    expect((await realCurrentUser())?.id).toBe("admin-1");
  });

  it("refuses a session with no Google identity at all once the row has an account", async () => {
    signedInAs(user("admin-1", "admin", { google_sub: "sub-1" }));
    authUser.identities = [{ provider: "email", identity_data: { sub: "sub-1" } }];
    expect(await realCurrentUser()).toBeNull();
  });

  // user_metadata is writable by whoever holds the session (`updateUser`), so a
  // matching `sub` there proves nothing: only the identity counts.
  it("ignores an account id written into user_metadata", async () => {
    signedInAs(user("admin-1", "admin", { google_sub: "sub-1" }));
    authUser.identities = [googleIdentity("sub-intruder")];
    authUser.userMetadata = { sub: "sub-1", provider_id: "sub-1" };
    expect(await realCurrentUser()).toBeNull();
  });

  // supabase-js reports a failed sign out as `{ error }` rather than throwing, so it
  // has to be read, or a session that could not be ended leaves no trace.
  it("logs a sign out that failed, and the refusal still stands", async () => {
    const warn = vi.spyOn(logModule.log, "warn").mockImplementation(() => {});
    signedInAs(user("admin-1", "admin", { google_sub: "sub-old" }));
    authUser.identities = [googleIdentity("sub-new")];
    signOut.mockResolvedValueOnce({ error: { message: "network down" } } as never);

    expect(await realCurrentUser()).toBeNull();
    expect(warn.mock.calls.some(([, fields]) => fields.msg === "could not end a refused session")).toBe(true);
    warn.mockRestore();
  });

  it("still refuses when the alert itself cannot be sent", async () => {
    signedInAs(user("admin-1", "admin", { google_sub: "sub-old" }));
    authUser.identities = [googleIdentity("sub-new")];
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
    expect(await realCurrentUser()).toBeNull();
  });
});

// #3084: the API routes are outside the middleware's reach, so the session's age is
// judged here too. Each refusal is paired with the same person admitted in the same
// fixture (L159). The boundaries themselves are driven in scripts/test-session-age.ts.
describe("an aged session is refused (#3084)", () => {
  const DAY = 86_400_000;

  it("refuses a session past 30 days since sign in, and admits one inside it", async () => {
    signedInAs(user("admin-1", "admin"));
    stamps.started = String(Date.now() - 31 * DAY);
    expect(await realCurrentUser()).toBeNull();
    await expect(requireAdmin()).rejects.toThrow("Not authorized");

    signedInAs(user("admin-1", "admin"));
    stamps.started = String(Date.now() - 29 * DAY);
    expect((await realCurrentUser())?.id).toBe("admin-1");
  });

  it("refuses a session unused for 7 days, and one with no sign in stamp at all", async () => {
    signedInAs(user("mgr-1", "manager"));
    stamps.seen = String(Date.now() - 8 * DAY);
    expect(await currentUser()).toBeNull();

    signedInAs(user("mgr-1", "manager"));
    stamps.seen = String(Date.now() - DAY);
    stamps.started = undefined;
    expect(await currentUser()).toBeNull();

    signedInAs(user("mgr-1", "manager"));
    stamps.started = String(Date.now() - DAY);
    expect((await currentUser())?.id).toBe("mgr-1");
  });

  it("does not let an aged admin act through an impersonation cookie", async () => {
    await arrange(user("admin-1", "admin"), user("agent-9", "agent"));
    stamps.started = String(Date.now() - 31 * DAY);
    expect(await currentUser()).toBeNull();
  });
});
