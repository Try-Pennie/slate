"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { realCurrentUser, requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { recordAudit } from "@/lib/audit";
import { log } from "@/lib/log";
import { googleHostedDomain } from "@/lib/env";
import { allowRequest } from "@/lib/rate-limit";
import { REMINDER_TEST_SEND_RATE_RULES } from "@/lib/rate-limit-core";
import { savedQuery, type SaveOutcome } from "@/lib/admin/save-outcomes";
import { PAGE_OUT_OF_DATE } from "@/lib/admin/edit-version";
import { sendGmailEmail } from "@/lib/notify/email";
import { asEmailSendError } from "@/lib/notify/email-errors";
import { shortErrorReason } from "@/lib/notify/error-text";
import { advisorContactCard } from "@/lib/booking/advisor-contact-card";
import { PENNIE_CARD_LOGO } from "@/lib/booking/pennie-card-logo";
import { describeTemplateProblem, validateTemplate } from "@/lib/booking/reminder-template";
import { SAMPLE_CALLING_NUMBER, joinMinutes, previewCase, previewReminder } from "@/lib/booking/reminder-preview";
import {
  CONFIRM_WINDOW_YES,
  REMINDER_EMAIL_COLUMNS,
  REMINDER_FIELDS,
  freshWindowMessage,
  listWords,
  opensFreshWindow,
  parseReminderEmailForm,
  readSnapshot,
  restoreChanges,
  slugForNewEmail,
} from "@/lib/admin/reminder-email-form";
import { REMINDER_COPY, REMINDER_EMAILS_PATH, reminderEmailPath } from "@/lib/admin/reminder-emails-copy";
import type { ReminderEmailRow, ReminderEmailSaveResult, User } from "@/lib/db/types";

/**
 * The writes behind /admin/reminder-emails (#4299, milestone "Editable reminder
 * emails").
 *
 * Every save goes through `save_reminder_email` (migration 0211), which refuses a
 * stale save, writes the copy version and the audit row in one transaction. That
 * function TRUSTS the actor and org it is handed (the phase 1 security review), so
 * both come from here: the actor is the signed in person from `realCurrentUser`, and
 * nothing is saved while they are viewing as somebody else, so an admin can never put
 * another person's name on an edit. The org is the actor's own row, never a field.
 *
 * A save that lands redirects back with a named outcome. A refusal is RETURNED, so the
 * editor keeps everything typed and draws the reasons beside the form.
 */

/** What the editor's save and restore hand back when nothing was saved. */
export interface ReminderEmailRefusal {
  refused: string[];
}

/** What "Send me a test" hands back. */
export interface ReminderTestState {
  error: string | null;
  sent: { to: string; subject: string; cardAttached: boolean } | null;
}

/**
 * The person allowed to write: an admin (`requireAdmin`, which throws for anyone
 * else) who is acting as themselves. Viewing as somebody is refused, with a sentence,
 * because the session's actor would otherwise be the person being viewed.
 */
async function realAdmin(): Promise<{ ok: true; actor: User } | { ok: false; reason: string }> {
  const acting = await requireAdmin();
  const real = await realCurrentUser();
  if (!real || real.id !== acting.id) return { ok: false, reason: REMINDER_COPY.viewingAsRefused };
  return { ok: true, actor: real };
}


type EditableRow = Pick<
  ReminderEmailRow,
  | "id"
  | "slug"
  | "name"
  | "minutes_before"
  | "late_booking"
  | "enabled"
  | "subject"
  | "body"
  | "card_block"
  | "placeholder_sends"
  | "updated_at"
>;

/** One email by id, or null when there is none; a failed read is a fault. */
async function readRow(id: string): Promise<EditableRow | null> {
  const { data, error } = await supabaseAdmin().from("reminder_emails").select(REMINDER_EMAIL_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`read failed [reminder email ${id}]: ${error.message}`);
  return (data as EditableRow | null) ?? null;
}

/** The function's answer, or a refusal sentence when the call itself failed. */
async function callSave(args: {
  id: string | null;
  loadedUpdatedAt: string | null;
  slug: string;
  name: string;
  minutesBefore: number;
  lateBooking: "send_now" | "skip";
  enabled: boolean;
  subject: string;
  body: string;
  cardBlock: boolean;
  placeholderSends: boolean;
  restoredFromVersion: number | null;
  actor: User;
}): Promise<{ result: ReminderEmailSaveResult } | { refused: string }> {
  const { data, error } = await supabaseAdmin().rpc("save_reminder_email", {
    p_id: args.id,
    p_loaded_updated_at: args.loadedUpdatedAt,
    p_slug: args.slug,
    p_name: args.name,
    p_minutes_before: args.minutesBefore,
    p_late_booking: args.lateBooking,
    p_enabled: args.enabled,
    p_subject: args.subject,
    p_body: args.body,
    p_card_block: args.cardBlock,
    p_placeholder_sends: args.placeholderSends,
    p_restored_from_version: args.restoredFromVersion,
    p_actor_id: args.actor.id,
    p_org_id: args.actor.org_id,
  });
  if (error) {
    log.error("reminder-emails", { msg: "save_reminder_email refused", code: error.code ?? null, id: args.id }, error);
    return { refused: `${REMINDER_COPY.saveFailed} ${error.message}` };
  }
  return { result: data as ReminderEmailSaveResult };
}

/** The trail's row for one test send, with whether Gmail confirmed taking it. */
async function recordTestSend(
  actor: User,
  form: FormData,
  sampleCall: string,
  cardAttached: boolean,
  gmail: "accepted" | "unconfirmed",
): Promise<void> {
  const emailId = String(form.get(REMINDER_FIELDS.id) ?? "").trim();
  await recordAudit({
    orgId: actor.org_id,
    actorId: actor.id,
    action: "reminder_email.test_sent",
    details: { reminder_email_id: emailId === "" ? null : emailId, sample_call: sampleCall, card_attached: cardAttached, gmail },
  });
}

/** The refusal for an update that did not land, or null when it saved. */
function notSaved(saved: { result: ReminderEmailSaveResult } | { refused: string }): ReminderEmailRefusal | null {
  if ("refused" in saved) return { refused: [saved.refused] };
  if (saved.result.status === "stale") return { refused: [REMINDER_COPY.stale] };
  if (saved.result.status === "missing") return { refused: [REMINDER_COPY.missing] };
  return null;
}

const read = (form: FormData) => (field: string) => {
  const v = form.get(field);
  return typeof v === "string" ? v : null;
};

/** Create or update one reminder email from the editor. */
export async function saveReminderEmail(form: FormData): Promise<ReminderEmailRefusal> {
  const gate = await realAdmin();
  if (!gate.ok) return { refused: [gate.reason] };
  const { actor } = gate;

  const parsed = parseReminderEmailForm(read(form));
  if (!parsed.ok) return { refused: parsed.reasons };
  const input = parsed.value;
  const id = String(form.get(REMINDER_FIELDS.id) ?? "").trim();

  if (id === "") {
    // A new email always starts off, whatever was posted: it reaches no lead until
    // somebody has read its preview and switched it on.
    // cap-safe: reminder_emails is a handful of admin made rows (SAFE_TABLES).
    const { data: slugs, error } = await supabaseAdmin().from("reminder_emails").select("slug");
    if (error) throw new Error(`read failed [reminder email slugs]: ${error.message}`);
    const taken = new Set(((slugs ?? []) as { slug: string }[]).map((r) => r.slug));
    const saved = await callSave({
      ...input,
      id: null,
      loadedUpdatedAt: null,
      slug: slugForNewEmail(input.name, taken),
      enabled: false,
      restoredFromVersion: null,
      actor,
    });
    if ("refused" in saved) return { refused: [saved.refused] };
    if (saved.result.status !== "saved") return { refused: [REMINDER_COPY.saveFailed] };
    revalidatePath(REMINDER_EMAILS_PATH);
    redirect(`${reminderEmailPath(saved.result.id)}&${savedQuery("reminder-email-created").slice(1)}`);
  }

  const loaded = String(form.get(REMINDER_FIELDS.loadedUpdatedAt) ?? "");
  if (loaded === "") return { refused: [PAGE_OUT_OF_DATE] };
  const row = await readRow(id);
  if (!row) return { refused: [REMINDER_COPY.missing] };
  if (row.updated_at !== loaded) return { refused: [REMINDER_COPY.stale] };

  const before = { enabled: row.enabled, minutesBefore: row.minutes_before };
  const after = { enabled: input.enabled, minutesBefore: input.minutesBefore };
  // The editor asks before this save, and its confirm posts this field. A save that
  // opens a fresh window without it is refused with the same question, so the
  // consequence is never skipped by a page that did not ask.
  if (opensFreshWindow(before, after) && form.get(REMINDER_FIELDS.confirmWindow) !== CONFIRM_WINDOW_YES) {
    return { refused: [freshWindowMessage(input.name, before, after)] };
  }

  const saved = await callSave({
    ...input,
    id,
    loadedUpdatedAt: loaded,
    slug: row.slug,
    restoredFromVersion: null,
    actor,
  });
  const refusal = notSaved(saved);
  if (refusal) return refusal;

  const outcome: SaveOutcome = opensFreshWindow(before, after)
    ? "reminder-email-on"
    : before.enabled && !after.enabled
      ? "reminder-email-off"
      : "reminder-email-saved";
  revalidatePath(REMINDER_EMAILS_PATH);
  redirect(`${reminderEmailPath(id)}&${savedQuery(outcome).slice(1)}`);
}

/**
 * Bring back one earlier version's copy: subject, body and the two switches. Never
 * the name, timing or on/off, which the function itself refuses to restore.
 */
export async function restoreReminderEmailVersion(form: FormData): Promise<ReminderEmailRefusal> {
  const gate = await realAdmin();
  if (!gate.ok) return { refused: [gate.reason] };

  const id = String(form.get(REMINDER_FIELDS.id) ?? "").trim();
  const loaded = String(form.get(REMINDER_FIELDS.loadedUpdatedAt) ?? "");
  const version = Number(form.get(REMINDER_FIELDS.version));
  if (id === "" || !Number.isInteger(version) || version < 1) return { refused: [REMINDER_COPY.noVersion] };
  if (loaded === "") return { refused: [PAGE_OUT_OF_DATE] };

  const row = await readRow(id);
  if (!row) return { refused: [REMINDER_COPY.missing] };
  if (row.updated_at !== loaded) return { refused: [REMINDER_COPY.stale] };

  const { data, error } = await supabaseAdmin()
    .from("reminder_email_versions")
    .select("snapshot")
    .eq("reminder_email_id", id)
    .eq("version", version)
    .maybeSingle();
  if (error) throw new Error(`read failed [reminder email ${id} version ${version}]: ${error.message}`);
  const snapshot = readSnapshot((data as { snapshot: unknown } | null)?.snapshot);
  if (!snapshot) return { refused: [REMINDER_COPY.noVersion] };

  // A version was saved under whatever fill-ins existed then, so it is checked again.
  const problems = validateTemplate(snapshot.subject, snapshot.body);
  if (problems.length > 0) {
    return { refused: [REMINDER_COPY.versionUnusable(version), ...problems.map(describeTemplateProblem)] };
  }
  const changes = restoreChanges(
    { subject: row.subject, body: row.body, card_block: row.card_block, placeholder_sends: row.placeholder_sends },
    snapshot,
  );
  if (changes.length === 0) return { refused: [REMINDER_COPY.versionIsCurrent(version)] };

  const saved = await callSave({
    id,
    loadedUpdatedAt: loaded,
    slug: row.slug,
    name: row.name,
    minutesBefore: row.minutes_before,
    lateBooking: row.late_booking,
    enabled: row.enabled,
    subject: snapshot.subject,
    body: snapshot.body,
    cardBlock: snapshot.card_block,
    placeholderSends: snapshot.placeholder_sends,
    restoredFromVersion: version,
    actor: gate.actor,
  });
  const refusal = notSaved(saved);
  if (refusal) return refusal;
  log.info("reminder-emails", { msg: "restored", id, version, changed: listWords(changes) });
  revalidatePath(REMINDER_EMAILS_PATH);
  redirect(`${reminderEmailPath(id)}&${savedQuery("reminder-email-restored").slice(1)}`);
}

/**
 * Email the signed in admin the editor's CURRENT text, saved or not, rendered for one
 * sample call. It goes from and to their own mailbox: never a lead, never an advisor's
 * mailbox, and never built from a real booking.
 */
export async function sendReminderEmailTest(form: FormData): Promise<ReminderTestState> {
  const gate = await realAdmin();
  if (!gate.ok) return { error: gate.reason, sent: null };
  const { actor } = gate;

  const domain = googleHostedDomain().toLowerCase();
  const own = actor.email.trim().toLowerCase();
  if (!own.endsWith(`@${domain}`)) return { error: REMINDER_COPY.testNeedsOwnMailbox(domain), sent: null };

  const sample = previewCase(String(form.get(REMINDER_FIELDS.previewCase) ?? ""));
  if (!sample) return { error: REMINDER_COPY.testNeedsCase, sent: null };
  const timing = joinMinutes(String(form.get(REMINDER_FIELDS.hours) ?? ""), String(form.get(REMINDER_FIELDS.minutes) ?? ""));
  if (!timing.ok) return { error: timing.reason, sent: null };

  const preview = previewReminder(
    {
      minutesBefore: timing.total,
      subject: String(form.get(REMINDER_FIELDS.subject) ?? "").replace(/\r\n?/g, "\n"),
      body: String(form.get(REMINDER_FIELDS.body) ?? "").replace(/\r\n?/g, "\n"),
      cardBlock: form.get(REMINDER_FIELDS.cardBlock) === "true",
      placeholderSends: form.get(REMINDER_FIELDS.placeholderSends) === "true",
    },
    sample,
  );
  if (preview.kind === "refused") return { error: preview.problems.map(describeTemplateProblem).join(" "), sent: null };
  if (preview.kind === "not_sent") return { error: REMINDER_COPY.testNotSentForPlaceholder, sent: null };

  const allowed = await allowRequest({ kind: "opaque", key: `reminder-test:${actor.id}` }, REMINDER_TEST_SEND_RATE_RULES);
  if (!allowed) return { error: REMINDER_COPY.testTooMany, sent: null };

  try {
    await sendGmailEmail({
      from: own,
      fromName: preview.fromName,
      to: [own],
      subject: preview.subject,
      body: preview.body,
      ...(preview.cardAttached
        ? {
            attachments: [
              advisorContactCard({
                agentEmail: own,
                agentName: sample.call.agentName,
                callingNumber: SAMPLE_CALLING_NUMBER,
                photo: PENNIE_CARD_LOGO,
              }),
            ],
          }
        : {}),
    });
  } catch (err) {
    const typed = asEmailSendError(err);
    const outcome = typed?.outcome ?? "unknown";
    log.error("reminder-emails", { msg: "test send failed", outcome, stage: typed?.stage ?? null }, err);
    // Gmail may still have delivered one it never answered for, and the trail is the
    // only record of a test send, so that one is recorded as unconfirmed.
    if (outcome === "unknown") await recordTestSend(actor, form, sample.id, preview.cardAttached, "unconfirmed");
    return { error: REMINDER_COPY.testFailed(outcome, shortErrorReason(err)), sent: null };
  }

  await recordTestSend(actor, form, sample.id, preview.cardAttached, "accepted");
  return { error: null, sent: { to: own, subject: preview.subject, cardAttached: preview.cardAttached } };
}
