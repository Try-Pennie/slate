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
  resendDelivery: vi.fn(async () => {}),
  replayDeadLetteredDeliveries: vi.fn(async () => 0),
}));
const offboarding = vi.hoisted(() => ({
  applyLifecycleByUserId: vi.fn(async () => ({ status: "applied", userId: "u2", deactivate: true })),
  applyLifecycleByEmail: vi.fn(),
}));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "claim" as string | null),
  releaseLock: vi.fn(async () => {}),
}));

const dbState = vi.hoisted(() => ({ single: null as unknown, count: 0 }));
const updateEq = vi.hoisted(() => vi.fn(async () => ({})));
const update = vi.hoisted(() =>
  vi.fn((_patch: Record<string, unknown> = {}) => ({ eq: updateEq })),
);
const insert = vi.hoisted(() => vi.fn(async () => ({})));
const upsert = vi.hoisted(() =>
  vi.fn(async (_rows: unknown, _opts?: { onConflict: string }) => ({})),
);
const from = vi.hoisted(() =>
  vi.fn((_table: string) => {
    const q: Record<string, unknown> = {
      select: vi.fn(() => q),
      eq: vi.fn(() => q),
      in: vi.fn(async () => ({ count: dbState.count })),
      maybeSingle: vi.fn(async () => ({ data: dbState.single })),
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

import {
  setUserRole,
  startImpersonation,
  stopImpersonation,
  endDroppedImpersonation,
  resendWebhookDelivery,
  replayFailedWebhooks,
  setWebhookEndpoint,
  setMonitorSettings,
  setUserLifecycle,
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
  dbState.count = 0;
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
      expect.objectContaining({ action: "impersonate.stop", targetId: "agent1" }),
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
        targetId: "agent1",
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
    await resendWebhookDelivery(form({ delivery_id: "d1" }));
    expect(locks.acquireLock).toHaveBeenCalledWith(
      "webhook_resend:o1:d1",
      expect.any(Number),
    );
    expect(emit.resendDelivery).toHaveBeenCalledWith("d1", "o1");
  });

  it("resendWebhookDelivery is a no-op for a duplicate that loses the claim", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    await resendWebhookDelivery(form({ delivery_id: "d1" }));
    expect(emit.resendDelivery).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not release the claim on success, so a later retry stays deduped", async () => {
    await resendWebhookDelivery(form({ delivery_id: "d1" }));
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
      expect.objectContaining({ action: "agent.deactivate", targetId: "u2" }),
    );
  });

  it("reactivates through the service with the reactivate direction", async () => {
    dbState.single = { role: "agent" };
    await setUserLifecycle(form({ user_id: "u2", action: "reactivate" }));
    expect(offboarding.applyLifecycleByUserId).toHaveBeenCalledWith("u2", "reactivate");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.reactivate", targetId: "u2" }),
    );
  });
});
