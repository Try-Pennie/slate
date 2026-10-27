import { describe, it, expect, vi, beforeEach } from "vitest";

// #4299: the writes behind /admin/reminder-emails.
//
// `save_reminder_email` trusts the actor and org it is handed (the phase 1 security
// review), so these pin where each comes from: the actor is the REAL signed in admin,
// nothing is written while viewing as somebody else, and the org is the actor's own.
// The rest pins each refusal (a manager, a stale page, an unknown fill-in, a fresh
// window nobody confirmed), that a restore never moves the timing or on/off, that a new
// email starts off, and that a test send only ever goes to the admin's own mailbox.
const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  versions: [] as Record<string, unknown>[],
  rpc: [] as { name: string; args: Record<string, unknown> }[],
  rpcAnswer: null as null | ((args: Record<string, unknown>) => unknown),
}));
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
const sendGmailEmail = vi.hoisted(() => vi.fn(async () => "gmail-id"));
const allowRequest = vi.hoisted(() => vi.fn(async () => true));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/notify/email", () => ({ sendGmailEmail }));
vi.mock("@/lib/rate-limit", () => ({ allowRequest }));
vi.mock("@/lib/env", () => ({ googleHostedDomain: () => "trypennie.com" }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const filters: [string, unknown][] = [];
      const rows = () =>
        (table === "reminder_emails" ? state.rows : table === "reminder_email_versions" ? state.versions : []).filter(
          (r) => filters.every(([k, v]) => r[k] === v),
        );
      const q = {
        select: () => q,
        eq(k: string, v: unknown) {
          filters.push([k, v]);
          return q;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
      };
      return q;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpc.push({ name, args });
      return { data: state.rpcAnswer?.(args) ?? null, error: null };
    },
  }),
}));

import { restoreReminderEmailVersion, saveReminderEmail, sendReminderEmailTest } from "./actions";
import { CONFIRM_WINDOW_YES, REMINDER_FIELDS } from "@/lib/admin/reminder-email-form";
import { REMINDER_COPY } from "@/lib/admin/reminder-emails-copy";

const ADMIN = { id: "admin1", role: "admin", org_id: "o1", email: "dana@trypennie.com" };
const STAMP = "2026-10-27T10:00:00.123456+00:00";

const HOUR = {
  id: "e1",
  slug: "hour",
  name: "1 hour reminder",
  minutes_before: 60,
  late_booking: "skip",
  enabled: true,
  subject: "Your Pennie call is {when}",
  body: "Hi, {call with} is {when}.\n\n{signature}",
  card_block: true,
  placeholder_sends: true,
  updated_at: STAMP,
};

function editorForm(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const base: Record<string, string> = {
    [REMINDER_FIELDS.id]: "e1",
    [REMINDER_FIELDS.loadedUpdatedAt]: STAMP,
    [REMINDER_FIELDS.name]: "1 hour reminder",
    [REMINDER_FIELDS.hours]: "1",
    [REMINDER_FIELDS.minutes]: "0",
    [REMINDER_FIELDS.lateBooking]: "skip",
    [REMINDER_FIELDS.enabled]: "true",
    [REMINDER_FIELDS.subject]: "Your Pennie call is {when}",
    [REMINDER_FIELDS.body]: "Hello, {call with} is {when}.\n\n{signature}",
    [REMINDER_FIELDS.cardBlock]: "true",
    [REMINDER_FIELDS.placeholderSends]: "true",
    [REMINDER_FIELDS.previewCase]: "calling_known",
  };
  for (const [k, v] of Object.entries({ ...base, ...over })) fd.set(k, v);
  return fd;
}

/** Runs an action that may redirect, returning where it went or what it returned. */
async function run<T>(p: Promise<T>): Promise<{ to: string } | { value: T }> {
  try {
    return { value: await p };
  } catch (err) {
    const m = String((err as Error).message);
    if (m.startsWith("NEXT_REDIRECT:")) return { to: m.slice("NEXT_REDIRECT:".length) };
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [{ ...HOUR }];
  state.versions = [
    { reminder_email_id: "e1", version: 1, snapshot: { subject: "Old {when}", body: "Old body {manage link}", card_block: false, placeholder_sends: false } },
    { reminder_email_id: "e1", version: 2, snapshot: { subject: HOUR.subject, body: HOUR.body, card_block: true, placeholder_sends: true } },
  ];
  state.rpc = [];
  state.rpcAnswer = (args) => ({
    status: "saved",
    id: (args.p_id as string | null) ?? "new1",
    updated_at: "2026-10-27T11:00:00Z",
    effective_from: "2026-10-27T11:00:00Z",
    version: 3,
    action: "reminder_email.updated",
  });
  auth.requireAdmin.mockResolvedValue(ADMIN);
  auth.realCurrentUser.mockResolvedValue(ADMIN);
});

describe("saveReminderEmail", () => {
  it("refuses a manager before anything is read or written", async () => {
    auth.requireAdmin.mockRejectedValue(new Error("Not authorized"));
    await expect(saveReminderEmail(editorForm())).rejects.toThrow();
    expect(state.rpc).toEqual([]);
  });

  it("saves through save_reminder_email with the real admin as actor and their own org", async () => {
    const out = await run(saveReminderEmail(editorForm({ org_id: "someone-elses", actor_id: "someone" })));
    expect(out).toEqual({ to: "/admin/reminder-emails?email=e1&ok=reminder-email-saved" });
    expect(state.rpc).toHaveLength(1);
    expect(state.rpc[0].name).toBe("save_reminder_email");
    expect(state.rpc[0].args).toMatchObject({
      p_id: "e1",
      p_loaded_updated_at: STAMP,
      p_slug: "hour",
      p_body: "Hello, {call with} is {when}.\n\n{signature}",
      p_actor_id: "admin1",
      p_org_id: "o1",
      p_restored_from_version: null,
    });
  });

  it("refuses while viewing as someone else, even an admin, and writes nothing", async () => {
    // A super admin viewing as an admin passes requireAdmin as the person viewed.
    auth.requireAdmin.mockResolvedValue({ ...ADMIN, id: "viewed-admin" });
    auth.realCurrentUser.mockResolvedValue({ ...ADMIN, id: "super1", role: "super_admin" });
    const out = await run(saveReminderEmail(editorForm()));
    expect(out).toEqual({ value: { refused: [REMINDER_COPY.viewingAsRefused] } });
    expect(state.rpc).toEqual([]);
  });

  it("refuses a page drawn before somebody else's save, with its own sentence", async () => {
    const out = await run(saveReminderEmail(editorForm({ [REMINDER_FIELDS.loadedUpdatedAt]: "2026-10-26T09:00:00Z" })));
    expect(out).toEqual({ value: { refused: [REMINDER_COPY.stale] } });
    expect(state.rpc).toEqual([]);
  });

  it("refuses when the function itself answers stale", async () => {
    state.rpcAnswer = () => ({ status: "stale", id: "e1", updated_at: "x" });
    const out = await run(saveReminderEmail(editorForm()));
    expect(out).toEqual({ value: { refused: [REMINDER_COPY.stale] } });
  });

  it("refuses an unknown fill-in, naming each one, and writes nothing", async () => {
    const out = await run(saveReminderEmail(editorForm({ [REMINDER_FIELDS.body]: "Hi {advisor name}, see {link}" })));
    expect("value" in out).toBe(true);
    const refused = "value" in out ? out.value.refused : [];
    expect(refused.some((r) => r.includes("{advisor name}"))).toBe(true);
    expect(refused.some((r) => r.includes("{link}"))).toBe(true);
    expect(state.rpc).toEqual([]);
  });

  it("refuses to switch an email on without the confirmation, saying who misses it", async () => {
    state.rows[0].enabled = false;
    const out = await run(saveReminderEmail(editorForm()));
    expect("value" in out && out.value.refused[0]).toMatch(/will not get it/);
    expect(state.rpc).toEqual([]);
  });

  it("switches on once confirmed, and says so", async () => {
    state.rows[0].enabled = false;
    const fd = editorForm();
    fd.set(REMINDER_FIELDS.confirmWindow, CONFIRM_WINDOW_YES);
    expect(await run(saveReminderEmail(fd))).toEqual({ to: "/admin/reminder-emails?email=e1&ok=reminder-email-on" });
    expect(state.rpc[0].args.p_enabled).toBe(true);
  });

  it("asks before retiming an email that is on", async () => {
    const out = await run(saveReminderEmail(editorForm({ [REMINDER_FIELDS.hours]: "2" })));
    expect("value" in out && out.value.refused[0]).toMatch(/2 hours/);
    expect(state.rpc).toEqual([]);
  });

  it("says when a save switched the email off", async () => {
    const out = await run(saveReminderEmail(editorForm({ [REMINDER_FIELDS.enabled]: "false" })));
    expect(out).toEqual({ to: "/admin/reminder-emails?email=e1&ok=reminder-email-off" });
  });

  it("creates a new email switched off, whatever was posted, with a key of its own", async () => {
    const out = await run(
      saveReminderEmail(editorForm({ [REMINDER_FIELDS.id]: "", [REMINDER_FIELDS.loadedUpdatedAt]: "", [REMINDER_FIELDS.name]: "Hour", [REMINDER_FIELDS.enabled]: "true" })),
    );
    expect(out).toEqual({ to: "/admin/reminder-emails?email=new1&ok=reminder-email-created" });
    expect(state.rpc[0].args).toMatchObject({ p_id: null, p_enabled: false, p_loaded_updated_at: null, p_actor_id: "admin1" });
    // "hour" is taken by the seeded email, so the new one gets its own.
    expect(state.rpc[0].args.p_slug).toBe("hour_2");
  });
});

describe("restoreReminderEmailVersion", () => {
  function restoreForm(version: number): FormData {
    const fd = new FormData();
    fd.set(REMINDER_FIELDS.id, "e1");
    fd.set(REMINDER_FIELDS.loadedUpdatedAt, STAMP);
    fd.set(REMINDER_FIELDS.version, String(version));
    return fd;
  }

  it("brings back the copy only, never the name, timing, late booking choice or on/off", async () => {
    const out = await run(restoreReminderEmailVersion(restoreForm(1)));
    expect(out).toEqual({ to: "/admin/reminder-emails?email=e1&ok=reminder-email-restored" });
    expect(state.rpc[0].args).toMatchObject({
      p_restored_from_version: 1,
      p_subject: "Old {when}",
      p_body: "Old body {manage link}",
      p_card_block: false,
      p_placeholder_sends: false,
      // Exactly what the row holds now.
      p_name: HOUR.name,
      p_minutes_before: HOUR.minutes_before,
      p_late_booking: HOUR.late_booking,
      p_enabled: HOUR.enabled,
      p_actor_id: "admin1",
    });
  });

  it("refuses a version that holds a fill-in no longer known", async () => {
    state.versions[0].snapshot = { subject: "Old", body: "Hi {first name}", card_block: true, placeholder_sends: true };
    const out = await run(restoreReminderEmailVersion(restoreForm(1)));
    expect("value" in out && out.value.refused.join(" ")).toMatch(/\{first name\}/);
    expect(state.rpc).toEqual([]);
  });

  it("refuses a restore that would change nothing", async () => {
    const out = await run(restoreReminderEmailVersion(restoreForm(2)));
    expect(out).toEqual({ value: { refused: [REMINDER_COPY.versionIsCurrent(2)] } });
  });

  it("refuses while viewing as someone else", async () => {
    auth.realCurrentUser.mockResolvedValue({ ...ADMIN, id: "super1" });
    const out = await run(restoreReminderEmailVersion(restoreForm(1)));
    expect(out).toEqual({ value: { refused: [REMINDER_COPY.viewingAsRefused] } });
    expect(state.rpc).toEqual([]);
  });
});

describe("sendReminderEmailTest", () => {
  it("sends the unsaved text for a sample call, from and to the admin's own mailbox only", async () => {
    const out = await sendReminderEmailTest(
      editorForm({ [REMINDER_FIELDS.subject]: "Draft subject {when}", [REMINDER_FIELDS.body]: "Hi.\n\n{how we call}" }),
    );
    expect(out.error).toBeNull();
    expect(sendGmailEmail).toHaveBeenCalledTimes(1);
    const msg = (sendGmailEmail.mock.calls[0] as unknown as [{ from: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; attachments?: unknown[] }])[0];
    expect(msg.from).toBe("dana@trypennie.com");
    expect(msg.to).toEqual(["dana@trypennie.com"]);
    expect(msg.cc).toBeUndefined();
    expect(msg.bcc).toBeUndefined();
    expect(msg.subject).toBe("Draft subject in about an hour, at 2:30pm EST");
    expect(msg.attachments).toHaveLength(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "reminder_email.test_sent", actorId: "admin1", orgId: "o1" }),
    );
  });

  it("is refused while viewing as someone else, and sends nothing", async () => {
    auth.requireAdmin.mockResolvedValue({ ...ADMIN, id: "viewed-admin", email: "viewed@trypennie.com" });
    auth.realCurrentUser.mockResolvedValue({ ...ADMIN, id: "super1", email: "boss@trypennie.com" });
    const out = await sendReminderEmailTest(editorForm());
    expect(out.error).toBe(REMINDER_COPY.viewingAsRefused);
    expect(sendGmailEmail).not.toHaveBeenCalled();
  });

  it("goes nowhere for an admin without an address on the company domain", async () => {
    auth.requireAdmin.mockResolvedValue({ ...ADMIN, email: "dana@gmail.com" });
    auth.realCurrentUser.mockResolvedValue({ ...ADMIN, email: "dana@gmail.com" });
    const out = await sendReminderEmailTest(editorForm());
    expect(out.error).toMatch(/trypennie\.com/);
    expect(sendGmailEmail).not.toHaveBeenCalled();
  });

  it("refuses a draft with an unknown fill-in and sends nothing", async () => {
    const out = await sendReminderEmailTest(editorForm({ [REMINDER_FIELDS.body]: "Hi {nickname}" }));
    expect(out.error).toMatch(/\{nickname\}/);
    expect(sendGmailEmail).not.toHaveBeenCalled();
  });

  it("says a test may or may not have arrived when Gmail gave no answer", async () => {
    const { EmailSendError } = await import("@/lib/notify/email-errors");
    sendGmailEmail.mockRejectedValueOnce(new EmailSendError("no response", { outcome: "unknown", stage: "post", transient: true }));
    const out = await sendReminderEmailTest(editorForm());
    expect(out.error).toMatch(/may or may not arrive/);
    expect(out.sent).toBeNull();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("is refused past the rate limit, before Gmail is called", async () => {
    allowRequest.mockResolvedValueOnce(false);
    const out = await sendReminderEmailTest(editorForm());
    expect(out.error).toBe(REMINDER_COPY.testTooMany);
    expect(sendGmailEmail).not.toHaveBeenCalled();
  });
});
