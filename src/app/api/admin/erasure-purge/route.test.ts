import { describe, it, expect, vi, beforeEach } from "vitest";

// #1128: the operator-triggered warehouse purge. This covers the route glue, and
// the part worth covering most is the DENIALS: the endpoint blanks columns in the
// archive, so who may call it and what it may touch are the two things that must
// not regress (and #676 established that denial coverage is a requirement here,
// not an extra).
const auth = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const purge = vi.hoisted(() => ({ purgeSnowflakeErasure: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/snowflake/purge", () => purge);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "./route";

/** Same-origin headers, which is what Slate's own UI sends. The route refuses a
 *  request that says it came from elsewhere (#1046), so every fake carries them;
 *  the refusal test below overrides them. */
const SAME_ORIGIN_HEADERS = {
  origin: "https://slate.trypennie.app",
  "sec-fetch-site": "same-origin",
  host: "slate.trypennie.app",
};
const CROSS_ORIGIN_HEADERS = {
  ...SAME_ORIGIN_HEADERS,
  origin: "https://evil.example",
  "sec-fetch-site": "cross-site",
};
/**
 * An operator call. `authorisedBy` is filled in by default (#1961), because the
 * route refuses every call without one and a helper that omitted it would make
 * every test below a test of that refusal rather than of what it is about. The
 * two tests that DO check the refusal pass a body naming nobody, explicitly.
 */
const req = (body?: unknown, headers: Record<string, string> = SAME_ORIGIN_HEADERS) =>
  ({
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return typeof body === "object" && body !== null && !Array.isArray(body)
        ? { authorisedBy: "dan, erasure request 42", ...(body as object) }
        : body;
    },
    headers: new Headers(headers),
  }) as unknown as Parameters<typeof POST>[0];

const clean = {
  ok: true,
  bookingIds: ["b1"],
  rowsByTable: { bookings: 1, booking_events: 1, webhook_deliveries: 3, booking_outbox: 1 },
  residualAfter: { bookings: 0, booking_events: 0, webhook_deliveries: 0, booking_outbox: 0 },
  reasons: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  // #1961: the operator secret is the ONLY credential now. Every test that does
  // not say otherwise runs as the operator, naming who asked.
  auth.requireAdmin.mockResolvedValue({ id: "admin-1", role: "admin" });
  cron.isAuthorizedCron.mockReturnValue(true);
  locks.acquireLock.mockResolvedValue("lease");
  purge.purgeSnowflakeErasure.mockResolvedValue(clean);
});

describe("POST /api/admin/erasure-purge", () => {
  describe("who may call it", () => {
    it("403s a caller holding no operator secret, and purges nothing", async () => {
      cron.isAuthorizedCron.mockReturnValue(false);
      const res = await POST(req());
      expect(res.status).toBe(403);
      expect(purge.purgeSnowflakeErasure).not.toHaveBeenCalled();
      expect(locks.acquireLock).not.toHaveBeenCalled();
    });

    // #1961: A SIGNED-IN ADMIN IS REFUSED LIKE ANYBODY ELSE, and that is the
    // whole point of taking the purge buttons off the page. Dan, 2026-09-04:
    // "feels like it shouldn't be this easy to purge data and I think I'd prefer
    // to go through Claude to do it." An endpoint a session could still reach
    // would be the same easy purge, one fetch from the console instead of one
    // click.
    //
    // The tests that asserted an admin was allowed and recorded as the actor are
    // gone rather than adjusted: their content was the behaviour being removed
    // (L252). This is their inverse, and it is what fails if the session path
    // comes back.
    it("403s a signed-in admin, because a session is not a credential for this", async () => {
      cron.isAuthorizedCron.mockReturnValue(false);
      auth.requireAdmin.mockResolvedValue({ id: "admin-1", role: "admin" });
      const res = await POST(req({ authorisedBy: "dan, erasure request 42" }));
      expect(res.status).toBe(403);
      expect(purge.purgeSnowflakeErasure).not.toHaveBeenCalled();
      // Not merely refused: the session is never even consulted, so nothing here
      // can grow a branch that trusts one.
      expect(auth.requireAdmin).not.toHaveBeenCalled();
    });

    // #1961: THE OPERATOR PATH MUST SAY WHO ASKED.
    //
    // It records no `actorId`, because there is no signed-in user behind it, and
    // it is now the only way an erasure runs. An entry naming nobody would be
    // the entire record of a compliance action (L529), and the one real purge in
    // this system's history is exactly that: 2026-07-31, eight rows blanked,
    // verified clean, no actor and no authoriser on the row.
    it("refuses an operator call that names nobody", async () => {
      const res = await POST(req({ authorisedBy: "" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/authorisedBy/i);
      // Refused BEFORE the lock and the purge, so a call naming nobody cannot
      // leave a lock behind or delete anything on its way to being told off.
      expect(purge.purgeSnowflakeErasure).not.toHaveBeenCalled();
      expect(locks.acquireLock).not.toHaveBeenCalled();
    });

    it("allows an operator process that names who authorised it", async () => {
      const res = await POST(req({ authorisedBy: "dan, erasure request 42" }));
      expect(res.status).toBe(200);
      expect(purge.purgeSnowflakeErasure).toHaveBeenCalledWith(
        undefined,
        undefined,
        "dan, erasure request 42",
      );
    });

  });

  describe("what it may touch", () => {
    it("passes an explicit booking id list through", async () => {
      await POST(req({ bookingIds: ["b1", "b2"] }));
      expect(purge.purgeSnowflakeErasure).toHaveBeenCalledWith(
        ["b1", "b2"],
        undefined,
        "dan, erasure request 42",
      );
    });

    it("400s a bookingIds that is not an array of strings", async () => {
      const res = await POST(req({ bookingIds: [1, 2] }));
      expect(res.status).toBe(400);
      expect(purge.purgeSnowflakeErasure).not.toHaveBeenCalled();
    });

    it("400s (not 500s) an id that no erasure has been recorded for", async () => {
      purge.purgeSnowflakeErasure.mockRejectedValue(
        new Error("erasure purge: 1 booking id(s) have not been erased in Supabase, so their warehouse copy must not be blanked: b9"),
      );
      const res = await POST(req({ bookingIds: ["b9"] }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/have not been erased/);
    });
  });

  describe("reporting what happened", () => {
    it("returns the row counts and the post-purge verify", async () => {
      const res = await POST(req({}));
      expect(await res.json()).toMatchObject({ ok: true, rowsByTable: { webhook_deliveries: 3 } });
    });

    it("does NOT report success when the purge ran but left a residual", async () => {
      purge.purgeSnowflakeErasure.mockResolvedValue({
        ...clean,
        ok: false,
        residualAfter: { ...clean.residualAfter, webhook_deliveries: 3 },
        reasons: ["webhook_deliveries: 3 row(s) still hold contact PII after the purge"],
      });
      const res = await POST(req({}));
      expect(res.status).toBe(500);
      expect((await res.json()).ok).toBe(false);
    });

    it("500s and releases the lock when a statement fails", async () => {
      purge.purgeSnowflakeErasure.mockRejectedValue(new Error("Snowflake 400: invalid identifier"));
      const res = await POST(req({}));
      expect(res.status).toBe(500);
      expect(locks.releaseLock).toHaveBeenCalledWith("erasure_warehouse_purge", "lease");
    });
  });

  describe("concurrency", () => {
    it("409s rather than running two purges at once", async () => {
      locks.acquireLock.mockResolvedValue(null);
      const res = await POST(req({}));
      expect(res.status).toBe(409);
      expect(purge.purgeSnowflakeErasure).not.toHaveBeenCalled();
    });

    it("releases the lock on the happy path too", async () => {
      await POST(req({}));
      expect(locks.releaseLock).toHaveBeenCalledWith("erasure_warehouse_purge", "lease");
    });
  });
});

describe("origin is no longer a gate (#1961)", () => {
  // The INVERSE of the #1046 block that stood here, kept rather than deleted so
  // the change is guarded in both directions. A same-origin refusal exists for
  // an AMBIENT credential, one a browser attaches on its own; this route's only
  // credential is a secret in a header, which no browser sends for another site.
  //
  // Reinstating the check would refuse an operator whose tool happened to send
  // an Origin header, which is a real way to break the only remaining path to a
  // purge, and it would fail here rather than in production.
  it("serves an operator call whatever origin it claims to come from", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    const res = await POST(req({}, CROSS_ORIGIN_HEADERS));
    expect(res.status).toBe(200);
    expect(purge.purgeSnowflakeErasure).toHaveBeenCalled();
  });

  it("still refuses a caller with no operator secret, whatever origin it claims", async () => {
    cron.isAuthorizedCron.mockReturnValue(false);
    const res = await POST(req({}, CROSS_ORIGIN_HEADERS));
    expect(res.status).toBe(403);
    expect(purge.purgeSnowflakeErasure).not.toHaveBeenCalled();
  });
});

// #1046's cross-origin block is GONE with the session path (#1961).
//
// A same-origin refusal exists for an AMBIENT credential, one a browser attaches
// on its own. This route's only credential is now a secret in a header, which no
// browser will send for another site, so there is no cross-site request to
// refuse and keeping the check would refuse an operator whose tool happened to
// send an Origin header. The tests went with it rather than being adjusted: a
// test whose premise a change has consumed goes permanently red for a reason
// that looks exactly like a real defect (L373).
//
// The static guard now asserts this route is NOT a same-origin subject
// (scripts/test-same-origin-coverage.ts), which is the inverse of what it
// asserted before, in the same change.
