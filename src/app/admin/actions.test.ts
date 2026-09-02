import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial branches for the two escalation-sensitive admin server actions (#676).
// setUserRole composes canSetRole / isSelfDemotion / canChangeRole; the role
// helpers are unit-tested on their own, so this pins that the action WIRES them
// as gates (rejects and never writes) rather than re-testing the predicates.
// startImpersonation's admin-floor and role-ceiling (#588) guards are pinned the
// same way. The real role helpers are exercised; only auth, DB, cookies, redirect
// and audit are mocked.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireManager: vi.fn(),
  requireSuperAdmin: vi.fn(),
  realCurrentUser: vi.fn(),
  currentUser: vi.fn(),
}));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const revalidatePath = vi.hoisted(() => vi.fn());
const cookieStore = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }));
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));

const emit = vi.hoisted(() => ({
  // #1076: the outcome is what the admin is shown, so the mock has to be able to
  // return each one rather than resolving void.
  resendDelivery: vi.fn(async (): Promise<string> => "sent"),
  replayDeadLetteredDeliveries: vi.fn(async () => 0),
}));
const offboarding = vi.hoisted(() => ({
  applyLifecycleByUserId: vi.fn(async () => ({ status: "applied", userId: "u2", deactivate: true })),
  applyLifecycleByEmail: vi.fn(),
}));
const bookable = vi.hoisted(() => ({
  applyBookableByUserId: vi.fn(
    async (): Promise<{ status: string; userId?: string; bookable?: boolean; reason?: string }> => ({
      status: "applied",
      userId: "u2",
      bookable: true,
    }),
  ),
  applyBookableByEmail: vi.fn(),
  writeBookable: vi.fn(async () => {}),
}));
const salesforce = vi.hoisted(() => ({
  syncSalesforceAgents: vi.fn(),
  AGENTS_SYNC_STREAK_KEY: "cron_agents_failures",
}));
const streak = vi.hoisted(() => ({
  clearFailureStreak: vi.fn(async () => {}),
  recordFailureStreak: vi.fn(async () => 1),
  recordConsecutiveStreak: vi.fn(async () => 1),
}));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "claim" as string | null),
  releaseLock: vi.fn(async () => {}),
}));

const dbState = vi.hoisted(() => ({
  single: null as unknown,
  singleError: null as { message: string } | null,
  insertError: null as { message: string } | null,
  count: 0,
  countError: null as { message: string } | null,
}));
const updateEq = vi.hoisted(() => vi.fn(async () => ({})));
const update = vi.hoisted(() =>
  vi.fn((_patch: Record<string, unknown> = {}) => ({ eq: updateEq })),
);
const insert = vi.hoisted(() =>
  vi.fn(async (_rows: unknown) => ({ error: dbState.insertError })),
);
const upsert = vi.hoisted(() =>
  vi.fn(async (_rows: unknown, _opts?: { onConflict: string }) => ({})),
);
const from = vi.hoisted(() =>
  vi.fn((_table: string) => {
    const q: Record<string, unknown> = {
      select: vi.fn(() => q),
      eq: vi.fn(() => q),
      in: vi.fn(async () => ({
        count: dbState.countError ? null : dbState.count,
        error: dbState.countError,
      })),
      maybeSingle: vi.fn(async () => ({
        data: dbState.singleError ? null : dbState.single,
        error: dbState.singleError,
      })),
      limit: vi.fn(() => q),
      update,
      insert,
      upsert,
    };
    return q;
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/webhooks/emit", () => emit);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/offboarding/service", () => offboarding);
vi.mock("@/lib/bookable/service", () => bookable);
vi.mock("@/lib/salesforce/sync", () => salesforce);
vi.mock("@/lib/notify/streak", () => streak);

import {
  grantStaffAccess,
  setUserRole,
  startImpersonation,
  stopImpersonation,
  endDroppedImpersonation,
  resendWebhookDelivery,
  replayFailedWebhooks,
  setWebhookEndpoint,
  setMonitorSettings,
  setUserLifecycle,
  setBookable,
  syncSalesforceNow,
} from "./actions";
import { ALERT_KEYS } from "@/lib/monitor/settings";
import { encodeImpersonationCookie } from "@/lib/auth/impersonation";

const admin = { id: "admin1", role: "admin", org_id: "o1" };

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.single = null;
  dbState.singleError = null;
  dbState.insertError = null;
  dbState.count = 0;
  dbState.countError = null;
  locks.acquireLock.mockResolvedValue("claim");
});

describe("setUserRole denial branches", () => {
  it("rejects a non-admin caller and never touches the DB", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setUserRole(form({ user_id: "u2", role: "agent" }))).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects when a regular admin tries to grant super_admin, and does not write", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "agent" };
    await expect(
      setUserRole(form({ user_id: "u2", role: "super_admin" })),
    ).rejects.toThrow(/not authorized to set this role/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("blocks an admin from demoting themselves, and does not write", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "admin" };
    await expect(
      setUserRole(form({ user_id: admin.id, role: "agent" })),
    ).rejects.toThrow(/your own admin access/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("blocks removing the last admin, and does not write", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "admin" };
    dbState.count = 1;
    await expect(
      setUserRole(form({ user_id: "u2", role: "agent" })),
    ).rejects.toThrow(/last admin/i);
    expect(update).not.toHaveBeenCalled();
  });

  // #1165: the admin count ignored `error`, so a FAILED read scored as count 0
  // and the refusal claimed "Cannot remove the last admin", a fact the check
  // never measured (L11: distinct causes get distinct messages). Refusing is the
  // right direction (fail closed), but the operator must be told the count could
  // not be read, not handed a false claim about the roster.
  it("refuses with a could-not-verify message, not a last-admin claim, when the count read fails", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "admin" };
    dbState.count = 5; // plenty of admins; only the READ is broken
    dbState.countError = { message: "permission denied for table users" };

    const err = await setUserRole(form({ user_id: "u2", role: "agent" })).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/could not (be )?verif/i);
    expect(err!.message).not.toMatch(/last admin/i);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("startImpersonation denial branches", () => {
  it("rejects a non-admin caller before any lookup or cookie is set", async () => {
    auth.realCurrentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    await expect(startImpersonation(form({ email: "someone@x.com" }))).rejects.toThrow(
      /not authorized/i,
    );
    expect(from).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("refuses to impersonate a peer of equal rank (role ceiling), setting no cookie", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    dbState.single = { id: "peer1", role: "admin" };
    await expect(
      startImpersonation(form({ email: "peer@x.com" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    const target = redirect.mock.calls.find(([u]) => String(u).includes("imp_error"));
    expect(target).toBeTruthy();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  // #653: a "view as" session must be bounded so a forgotten one auto-ends.
  it("sets a bounded, timestamped cookie on the success path", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    dbState.single = { id: "agent1", role: "agent" };
    await expect(startImpersonation(form({ email: "agent@x.com" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/me/,
    );
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
    const [name, value, opts] = cookieStore.set.mock.calls[0];
    expect(name).toBe("slate_impersonate");
    // Value carries the target id AND an issued-at timestamp (id.timestamp).
    expect(value).toMatch(/^agent1\.\d+$/);
    // A finite maxAge bounds the cookie's own lifetime as defense in depth.
    expect(opts.maxAge).toBeGreaterThan(0);
    expect(Number.isFinite(opts.maxAge)).toBe(true);
  });

  // The cookie now carries "id.timestamp" (#653); the stop audit must record the
  // clean target id, not the encoded value.
  it("records the decoded target id in the stop audit, not the raw cookie", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    cookieStore.get.mockReturnValueOnce({
      value: encodeImpersonationCookie("agent1", 1_700_000_000_000),
    });
    await expect(stopImpersonation()).rejects.toThrow(/NEXT_REDIRECT:\/admin/);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "impersonate.stop", targetUserId: "agent1" }),
    );
  });
});

// #652: the page auto-clears a dropped session in the background. This action
// deletes the cookie and records the auto-end WITHOUT redirecting, so the notice
// stays visible on the current page.
describe("endDroppedImpersonation (#652)", () => {
  it("clears the cookie and audits the auto-end with the reason and decoded target", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    cookieStore.get.mockReturnValueOnce({
      value: encodeImpersonationCookie("agent1", 1_700_000_000_000),
    });
    await endDroppedImpersonation("expired");
    expect(cookieStore.delete).toHaveBeenCalledWith("slate_impersonate");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "impersonate.ended",
        targetUserId: "agent1",
        details: expect.objectContaining({ reason: "expired" }),
      }),
    );
    expect(redirect).not.toHaveBeenCalled();
  });

  it("is a safe no-op when there is no cookie (does not audit)", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    cookieStore.get.mockReturnValueOnce(undefined);
    await endDroppedImpersonation("expired");
    expect(cookieStore.delete).toHaveBeenCalledWith("slate_impersonate");
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

// #674: the SubmitButton's client-side disable (#630) can't stop a flaky-network
// retry or a racing request from firing these non-idempotent re-delivery actions
// twice. A DB-backed claim (acquireLock) makes a duplicate within the window a
// no-op regardless of the client.
describe("webhook re-delivery duplicate guard", () => {
  beforeEach(() => {
    auth.requireAdmin.mockResolvedValue(admin);
  });

  it("resendWebhookDelivery re-fires when it wins the claim", async () => {
    await expect(resendWebhookDelivery(form({ delivery_id: "d1" }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(locks.acquireLock).toHaveBeenCalledWith(
      "webhook_resend:o1:d1",
      expect.any(Number),
    );
    expect(emit.resendDelivery).toHaveBeenCalledWith("d1", "o1");
  });

  // #1076: the outcome reaches the admin, not just the server logs. Every one of
  // these used to re-render the log unchanged, so a refusal looked exactly like a
  // success and the button looked broken.
  it.each(["sent", "payload-erased", "suppressed", "not-found"] as const)(
    "resendWebhookDelivery reports %s back to the admin",
    async (result) => {
      emit.resendDelivery.mockResolvedValueOnce(result);
      await expect(resendWebhookDelivery(form({ delivery_id: "d1" }))).rejects.toThrow(
        `NEXT_REDIRECT:/admin?resend=${encodeURIComponent(result)}`,
      );
    },
  );

  it("resendWebhookDelivery tells the admin when a duplicate lost the claim", async () => {
    // Not a silent no-op any more. A second press that says nothing is
    // indistinguishable from a broken button, and the truthful thing to say is that
    // the receiver already has it.
    locks.acquireLock.mockResolvedValueOnce(null);
    await expect(resendWebhookDelivery(form({ delivery_id: "d1" }))).rejects.toThrow(
      "NEXT_REDIRECT:/admin?resend=deduped",
    );
    expect(emit.resendDelivery).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not release the claim on success, so a later retry stays deduped", async () => {
    await expect(resendWebhookDelivery(form({ delivery_id: "d1" }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(locks.releaseLock).not.toHaveBeenCalled();
  });

  it("replayFailedWebhooks replays when it wins the claim, keyed by org and window", async () => {
    await replayFailedWebhooks(form({ hours: "24" }));
    expect(locks.acquireLock).toHaveBeenCalledWith(
      "webhook_replay:o1:24",
      expect.any(Number),
    );
    expect(emit.replayDeadLetteredDeliveries).toHaveBeenCalledTimes(1);
  });

  it("replayFailedWebhooks is a no-op for a duplicate that loses the claim", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    await replayFailedWebhooks(form({ hours: "24" }));
    expect(emit.replayDeadLetteredDeliveries).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// #600: the Regal API key is the ONLY thing authenticating Slate's booking events to
// Regal. The admin form used to round-trip it as an input's defaultValue and treat a
// blank field as "set it to null", so an admin who edited the webhook URL without
// retyping the key silently wiped it, and every booking event afterwards posted an
// empty Authorization header. Blank must now mean "keep what is there".
describe("setWebhookEndpoint key handling (#600)", () => {
  it("does NOT wipe the stored key when the field is left blank", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { id: "ep1" };

    await setWebhookEndpoint(
      form({ url: "https://events.regalvoice.com/events", format: "regal", auth_header: "" }),
    );

    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    // The whole bug: `auth_header: null` here takes Regal offline silently.
    expect(patch).not.toHaveProperty("auth_header");
    expect(patch.url).toBe("https://events.regalvoice.com/events");
    expect(patch.format).toBe("regal");
  });

  it("treats a whitespace-only field as blank, not as a new key", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { id: "ep1" };

    await setWebhookEndpoint(
      form({ url: "https://events.regalvoice.com/events", format: "regal", auth_header: "   " }),
    );

    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("auth_header");
  });

  it("still updates the key when one is actually supplied", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { id: "ep1" };

    await setWebhookEndpoint(
      form({
        url: "https://events.regalvoice.com/events",
        format: "regal",
        auth_header: "new-key",
      }),
    );

    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.auth_header).toBe("new-key");
  });
});

// #1032: the endpoint URL receives every booking event (lead name, email, phone)
// plus the Regal API key Authorization header, so an http:// URL would send all
// of it in plaintext. Reject a non-https scheme before any write.
describe("setWebhookEndpoint URL scheme guard (#1032)", () => {
  it("rejects an http:// URL with an error redirect and writes nothing", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = null; // would be the insert path if it got that far

    await expect(
      setWebhookEndpoint(form({ url: "http://events.regalvoice.com/events", format: "regal" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    const call = redirect.mock.calls.find(([u]) => String(u).includes("webhook_error"));
    expect(call).toBeTruthy();
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("accepts an https:// URL and inserts the endpoint", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = null;

    await setWebhookEndpoint(form({ url: "https://events.regalvoice.com/events", format: "regal" }));

    expect(insert).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });
});

// #582: the monitor alert-settings save path (#571). The pure parser
// (parseMonitorSettingsForm) is unit-tested on its own; this pins that the action
// WIRES it correctly end to end (form parsing to full-row upsert to audit) so the
// red-team S1/S2 fixes can't quietly regress: a blank field must persist as
// explicit null (never 0), an out-of-range value must refuse to save, each row is
// written whole so clearing one field can't wipe a sibling, and the actor is
// stamped. The real parser runs; only auth, DB, audit and redirect are mocked.
describe("setMonitorSettings save path (#582)", () => {
  beforeEach(() => {
    auth.requireAdmin.mockResolvedValue(admin);
  });

  // Every cooldown field plus floors and channels, all valid, as a baseline the
  // individual cases override one field at a time.
  function monitorForm(overrides: Record<string, string> = {}): FormData {
    const base: Record<string, string> = {
      floor_30: "5",
      floor_120: "20",
      alerts_channel: "#alerts",
      info_channel: "#info",
    };
    for (const k of ALERT_KEYS) base[`cooldown_${k}`] = "30";
    return form({ ...base, ...overrides });
  }

  function settingsUpsertPayload(): Record<string, unknown>[] {
    const call = upsert.mock.calls.find(([payload]) => Array.isArray(payload));
    return (call?.[0] ?? []) as Record<string, unknown>[];
  }

  function configUpsertPayload(): Record<string, unknown> {
    const call = upsert.mock.calls.find(([payload]) => !Array.isArray(payload));
    return (call?.[0] ?? {}) as Record<string, unknown>;
  }

  // S1: a blank field is "revert to fallback", which must be an explicit null so
  // the resolver falls through to the coded default. Writing 0 would instead pin a
  // real (broken) value: a 0-minute cooldown or a 0 low-volume floor.
  it("persists a blank field as explicit null, never 0", async () => {
    const key = ALERT_KEYS[0];
    await expect(
      setMonitorSettings(monitorForm({ [`cooldown_${key}`]: "", floor_30: "" })),
    ).rejects.toThrow(/NEXT_REDIRECT:\/admin\/settings\?ok=1/);

    const rows = settingsUpsertPayload();
    const blankRow = rows.find((r) => r.key === key);
    expect(blankRow?.cooldown_min).toBeNull();
    expect(blankRow?.cooldown_min).not.toBe(0);
    // A sibling with a real value is untouched by the blank one.
    const otherRow = rows.find((r) => r.key === ALERT_KEYS[1]);
    expect(otherRow?.cooldown_min).toBe(30);

    const config = configUpsertPayload();
    expect(config.floor_30).toBeNull();
    expect(config.floor_30).not.toBe(0);
  });

  // S2: an out-of-range value is refused, not coerced. The action redirects to the
  // error page and must NOT write anything (a partial save would be worse).
  it("refuses an out-of-range value and writes nothing", async () => {
    const key = ALERT_KEYS[0];
    // 0 is below the 1-minute floor; the parser rejects it.
    await expect(
      setMonitorSettings(monitorForm({ [`cooldown_${key}`]: "0" })),
    ).rejects.toThrow(/NEXT_REDIRECT:\/admin\/settings\?error=/);

    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // A full row is written per key (onConflict: "key"), each a complete object, so
  // saving one field can never blank a sibling column.
  it("upserts a complete row per key on the key conflict target", async () => {
    await expect(setMonitorSettings(monitorForm())).rejects.toThrow(/ok=1/);

    const settingsCall = upsert.mock.calls.find(([payload]) => Array.isArray(payload));
    expect(settingsCall).toBeTruthy();
    expect(settingsCall?.[1]).toEqual({ onConflict: "key" });

    const rows = settingsUpsertPayload();
    expect(rows).toHaveLength(ALERT_KEYS.length);
    for (const row of rows) {
      expect(row).toHaveProperty("key");
      expect(row).toHaveProperty("cooldown_min");
      expect(row).toHaveProperty("updated_at");
      expect(row).toHaveProperty("updated_by");
    }
    expect(rows.map((r) => r.key).sort()).toEqual([...ALERT_KEYS].sort());

    // The config row is a single upsert on id=1.
    const configCall = upsert.mock.calls.find(([payload]) => !Array.isArray(payload));
    expect(configCall?.[0]).toMatchObject({ id: 1 });
    expect(configCall?.[1]).toEqual({ onConflict: "id" });
  });

  // The acting admin is stamped on both writes and in the audit trail.
  it("stamps updated_by with the acting admin and audits the change", async () => {
    await expect(setMonitorSettings(monitorForm())).rejects.toThrow(/ok=1/);

    const rows = settingsUpsertPayload();
    expect(rows.every((r) => r.updated_by === admin.id)).toBe(true);
    expect(configUpsertPayload().updated_by).toBe(admin.id);

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: admin.id,
        action: "monitor.settings",
      }),
    );
  });
});

// #278: the admin deactivate/reactivate action. The escalation guard
// (requireManageAgent) is unit-tested via its predicates elsewhere; here we pin
// the action-specific gates: a bad action is a no-op, deactivating YOURSELF is
// refused before any write (self-lockout), and a valid call reaches the service
// with the right direction and audits it.
describe("setUserLifecycle (#278)", () => {
  beforeEach(() => {
    auth.requireManager.mockResolvedValue(admin);
  });

  it("ignores an unknown action without touching auth or the service", async () => {
    await setUserLifecycle(form({ user_id: "u2", action: "frobnicate" }));
    expect(auth.requireManager).not.toHaveBeenCalled();
    expect(offboarding.applyLifecycleByUserId).not.toHaveBeenCalled();
  });

  it("refuses to deactivate your own account, and never calls the service", async () => {
    await expect(
      setUserLifecycle(form({ user_id: admin.id, action: "deactivate" })),
    ).rejects.toThrow(/your own account/i);
    expect(offboarding.applyLifecycleByUserId).not.toHaveBeenCalled();
  });

  it("deactivates a lower-ranked target and audits agent.deactivate", async () => {
    dbState.single = { role: "agent" };
    await setUserLifecycle(form({ user_id: "u2", action: "deactivate" }));
    expect(offboarding.applyLifecycleByUserId).toHaveBeenCalledWith("u2", "deactivate");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.deactivate", targetUserId: "u2" }),
    );
  });

  it("reactivates through the service with the reactivate direction", async () => {
    dbState.single = { role: "agent" };
    await setUserLifecycle(form({ user_id: "u2", action: "reactivate" }));
    expect(offboarding.applyLifecycleByUserId).toHaveBeenCalledWith("u2", "reactivate");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.reactivate", targetUserId: "u2" }),
    );
  });
});

// #1046: `requireManageAgent` is the escalation guard on every agent-edit action,
// and it was the one guard in the file that did not fail closed. #1629 stopped it
// swallowing a read ERROR, but a read that succeeds and finds NOTHING still fell
// back to the role `agent`, which is exactly the role a manager is allowed to edit.
// So a target id that does not exist passed the guard, and an audit row was written
// naming a user that is not there. Nothing downstream corrupted anything (the
// service writes match zero rows), which is why it survived: the only visible trace
// was an audit trail asserting an edit to a nonexistent person.
//
// Driven through setUserLifecycle because it is the shortest path to the guard; the
// guard is shared, so refusing here refuses for every action that calls it.
describe("requireManageAgent fails closed on a target that does not exist (#1046)", () => {
  beforeEach(() => {
    auth.requireManager.mockResolvedValue(admin);
  });

  it("refuses when the target user row is absent, and writes nothing", async () => {
    dbState.single = null; // read succeeded, no such user
    dbState.singleError = null;

    await expect(
      setUserLifecycle(form({ user_id: "ghost", action: "deactivate" })),
    ).rejects.toThrow(/not authorized/i);

    expect(offboarding.applyLifecycleByUserId).not.toHaveBeenCalled();
    // No audit row either: an audit entry against an id with no user is worse than
    // no entry, because it reads as a real edit that happened.
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("still permits a target that DOES exist and outranks nobody", async () => {
    // The positive control. Without it, a guard that refused every call would pass
    // the test above while making the whole admin surface unusable.
    dbState.single = { role: "agent" };

    await setUserLifecycle(form({ user_id: "u2", action: "deactivate" }));

    expect(offboarding.applyLifecycleByUserId).toHaveBeenCalledWith("u2", "deactivate");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.deactivate", targetUserId: "u2" }),
    );
  });
});

// #912: the admin bookable toggle now runs the same Google-reachability gate as
// the API (via applyBookableByUserId). A blocked result must HARD-BLOCK: throw a
// clear error and NOT revalidate (nothing changed), so a manager can't put a
// calendar-less agent into the pool from the UI.
describe("setBookable Google guard (#912)", () => {
  beforeEach(() => {
    auth.requireManager.mockResolvedValue(admin);
    dbState.single = { role: "agent" };
  });

  it("routes the flip through the guarded service and revalidates on success", async () => {
    bookable.applyBookableByUserId.mockResolvedValueOnce({ status: "applied", userId: "u2", bookable: true });
    await setBookable(form({ user_id: "u2", bookable: "true" }));
    expect(bookable.applyBookableByUserId).toHaveBeenCalledWith("u2", true);
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("throws a clear error and does not revalidate when the calendar is unreachable", async () => {
    bookable.applyBookableByUserId.mockResolvedValueOnce({
      status: "blocked",
      userId: "u2",
      reason: "google_unreachable",
    });
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(/calendar/i);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("throws a distinct 'could not verify' error on a transient block", async () => {
    bookable.applyBookableByUserId.mockResolvedValueOnce({
      status: "blocked",
      userId: "u2",
      reason: "google_unverified",
    });
    await expect(setBookable(form({ user_id: "u2", bookable: "true" }))).rejects.toThrow(/verify/i);
  });

  it("passes bookable=false straight through (deactivation is never gated)", async () => {
    bookable.applyBookableByUserId.mockResolvedValueOnce({ status: "applied", userId: "u2", bookable: false });
    await setBookable(form({ user_id: "u2", bookable: "false" }));
    expect(bookable.applyBookableByUserId).toHaveBeenCalledWith("u2", false);
  });
});

// #491: a manual admin "Sync from Salesforce" that succeeds must clear the
// hourly cron's consecutive-failure streak, so a human fixing a failing sync
// fully quiets the alarm instead of the cron re-alerting on its next hiccup.
describe("syncSalesforceNow streak reset (#491)", () => {
  beforeEach(() => {
    auth.requireAdmin.mockResolvedValue(admin);
  });

  it("clears the failure streak on a successful sync", async () => {
    salesforce.syncSalesforceAgents.mockResolvedValueOnce({
      updated: 2,
      inserted: 0,
      managersLinked: 0,
      managersCreated: 0,
      managersPromoted: 0,
      deactivated: 0,
    });
    await expect(syncSalesforceNow()).rejects.toThrow(/NEXT_REDIRECT:\/admin\?synced/);
    expect(streak.clearFailureStreak).toHaveBeenCalledWith("cron_agents_failures");
  });

  it("does NOT clear the streak when the sync fails", async () => {
    salesforce.syncSalesforceAgents.mockRejectedValueOnce(new Error("SF down"));
    await expect(syncSalesforceNow()).rejects.toThrow(/NEXT_REDIRECT:\/admin\?sync_error/);
    expect(streak.clearFailureStreak).not.toHaveBeenCalled();
  });

  // #1653: the admin who presses this button is usually pressing it BECAUSE a
  // manager link looks wrong, so the summary is where they find out what the run
  // refused to do. A manager name answering to two Salesforce users and one
  // answering to nobody need opposite fixes, so they are two sentences (L11); one
  // line covering both told the reader neither.
  it("says separately that a manager name was shared and that one matched nobody", async () => {
    salesforce.syncSalesforceAgents.mockResolvedValueOnce({
      updated: 2,
      inserted: 0,
      managersLinked: 0,
      managersUnlinked: 0,
      managersUnresolved: 1,
      managersAmbiguous: 15,
      managerNamesAmbiguous: 1,
      managersCreated: 0,
      managersPromoted: 0,
      deactivated: 0,
    });
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("15 agents left unlinked");
    expect(redirected).toContain("1 manager name in Salesforce answers to more than one user");
    expect(redirected).toContain("1 agent has a manager name nothing in Salesforce matched");
    expect(redirected).not.toContain("undefined");
    expect(redirected).not.toContain("NaN");
  });

  // The count has always been per AGENT. The old line called it a manager name, so
  // one unmatched name shared by a team of fifteen rendered as fifteen names.
  it("counts the unmatched refusal in agents, not in picklist names", async () => {
    salesforce.syncSalesforceAgents.mockResolvedValueOnce({
      updated: 0,
      inserted: 0,
      managersLinked: 0,
      managersUnlinked: 0,
      managersUnresolved: 15,
      managersAmbiguous: 0,
      managerNamesAmbiguous: 0,
      managersCreated: 0,
      managersPromoted: 0,
      deactivated: 0,
    });
    let redirected = "";
    try {
      await syncSalesforceNow();
    } catch (e) {
      redirected = decodeURIComponent(String((e as Error).message));
    }
    expect(redirected).toContain("15 agents have a manager name nothing in Salesforce matched");
    expect(redirected).not.toContain("15 manager names");
  });
});

// Granting elevated access by email (#160). The surface exists because seeding a
// privileged row used to mean a developer editing the users table, so the guards
// on it ARE the feature: this pins that the action refuses server side rather
// than relying on the button being hidden, and that an admin count it could not
// read never becomes a confident answer in either direction.
describe("grantStaffAccess", () => {
  const superAdmin = { id: "sa1", role: "super_admin", org_id: "o1" };

  function staffForm(over: Record<string, string> = {}): FormData {
    return form({ email: "new.person@trypennie.com", role: "admin", ...over });
  }

  function redirectedTo(): string {
    const call = redirect.mock.calls.at(-1);
    return String(call?.[0] ?? "");
  }

  it("refuses a caller who is not a super admin, and never touches the DB", async () => {
    auth.requireSuperAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(grantStaffAccess(staffForm())).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  // The plan refuses independently of the route guard, so a second entry point
  // wired to requireAdmin could not open the door by accident.
  it("refuses an ordinary admin even if the route guard let them through", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(admin);
    await expect(grantStaffAccess(staffForm())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=not_authorized");
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  // The positive control, in the same fixture: without it every refusal above is
  // satisfied by an action that can never write at all.
  it("creates the account, never bookable, and reports the address it wrote", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.single = null;
    await expect(grantStaffAccess(staffForm())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.email).toBe("new.person@trypennie.com");
    expect(row.role).toBe("admin");
    expect(row.org_id).toBe("o1");
    expect(row.bookable).toBe(false);
    expect(redirectedTo()).toContain("staff=granted");
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it("normalizes the address, because login matches on exactly what is stored", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    await expect(
      grantStaffAccess(staffForm({ email: "  New.Person@TryPennie.com " })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.email).toBe("new.person@trypennie.com");
  });

  it("refuses an address held by another org rather than colliding on the unique index", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.single = {
      id: "u9",
      org_id: "other-org",
      role: "agent",
      deactivated_at: null,
      auth_user_id: null,
    };
    await expect(grantStaffAccess(staffForm())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=other_org");
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  // An unreadable lookup is not an absent row. Reading it as absence would send
  // the action down the create path on an address that may already exist.
  it("refuses when the existing-account lookup fails, and writes nothing", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.singleError = { message: "permission denied for table users" };
    await expect(grantStaffAccess(staffForm())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=lookup_failed");
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("blocks a change that would leave the org with no admin", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.single = {
      id: "u9",
      org_id: "o1",
      role: "admin",
      deactivated_at: null,
      auth_user_id: "a9",
    };
    dbState.count = 1;
    await expect(grantStaffAccess(staffForm({ role: "manager" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=last_admin");
    expect(update).not.toHaveBeenCalled();
  });

  // #1165 again, on a new surface. A FAILED count read must refuse in its own
  // words: scoring it as zero produces a confident "no admin would remain" about
  // a roster nothing measured, and scoring it as plenty would let the change
  // through on the same non-answer.
  it("refuses with an unreadable-count message, not a last-admin claim, when the count read fails", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    // Unclaimed on purpose: a row somebody HAS signed in to is refused by the
    // #1669 surface rule before the count is ever consulted, so an unreadable
    // count only decides for a grant nobody has used.
    dbState.single = {
      id: "u9",
      org_id: "o1",
      role: "admin",
      deactivated_at: null,
      auth_user_id: null,
    };
    dbState.count = 5; // plenty of admins; only the READ is broken
    dbState.countError = { message: "permission denied for table users" };
    await expect(grantStaffAccess(staffForm({ role: "manager" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=admin_count_unreadable");
    expect(redirectedTo()).not.toContain("last_admin");
    expect(update).not.toHaveBeenCalled();
  });

  // #1669: the lookalike remedy posted the PENDING row's role and nothing read
  // the target's own, so one click could drop a signed in admin to manager as an
  // ordinary success. Nothing may be written.
  it("refuses to lower a colleague who has signed in, and writes nothing", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.single = {
      id: "u9",
      org_id: "o1",
      role: "admin",
      deactivated_at: null,
      auth_user_id: "a9",
    };
    dbState.count = 5; // plenty of admins, so the last-admin rule is not what refuses
    await expect(grantStaffAccess(staffForm({ role: "manager" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=signed_in_demotion");
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  // The healthy control in the same fixture, so the refusal above cannot be
  // passing because this surface stopped writing at all.
  it("still raises a signed in colleague's access, which is what the panel is for", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.single = {
      id: "u9",
      org_id: "o1",
      role: "manager",
      deactivated_at: null,
      auth_user_id: "a9",
    };
    dbState.count = 5;
    await expect(grantStaffAccess(staffForm({ role: "admin" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=updated");
    expect(update).toHaveBeenCalled();
  });

  // The count only decides a change that TAKES org power away, so a broken count
  // read must not block a grant that never depended on it.
  it("still grants when the count read fails but the change adds org power", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.single = {
      id: "u9",
      org_id: "o1",
      role: "manager",
      deactivated_at: null,
      auth_user_id: "a9",
    };
    dbState.countError = { message: "permission denied for table users" };
    await expect(grantStaffAccess(staffForm({ role: "admin" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=updated");
    expect(update).toHaveBeenCalledTimes(1);
  });

  // A write that failed must not be reported as access somebody now has: the
  // person would be told they are set up and find out at the login screen.
  it("reports a failed write as a failure, and records no audit row for it", async () => {
    auth.requireSuperAdmin.mockResolvedValueOnce(superAdmin);
    dbState.insertError = { message: "duplicate key value violates unique constraint" };
    await expect(grantStaffAccess(staffForm())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectedTo()).toContain("staff=write_failed");
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
