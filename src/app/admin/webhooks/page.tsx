import { redirect } from "next/navigation";
import { SaveForm } from "@/components/ui/SaveForm";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { consoleHiddenFor, regalWebhookKey, webhookSigningSecret } from "@/lib/env";
import {
  credentialSourcesFor,
  type CredentialSource,
} from "@/lib/webhooks/credentials";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { readPrimaryWebhookEndpoint } from "@/lib/webhooks/primary-endpoint";
import {
  replayFailedWebhooks,
  resendWebhookDelivery,
  sendTestWebhook,
  setWebhookEndpoint,
} from "@/app/admin/actions";
import { WebhookTestSend } from "@/components/admin/WebhookTestSend";
import { deliveryDisplay } from "@/lib/webhooks/delivery-display";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import {
  replayFeedback,
  resendFeedback,
  type ResendFeedback,
  type ResendResult,
} from "@/lib/webhooks/resend-feedback";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Pill } from "@/components/ui/Pill";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { btnCls, btnSecondaryCls, cardCls, inputCls, labelCls, proseCls } from "@/components/ui/styles";
import type { WebhookDelivery, WebhookEndpoint } from "@/lib/db/types";
import { SelectField } from "@/components/ui/SelectField";
import {
  WEBHOOK_FORMATS,
  WEBHOOK_FORMAT_NOTE,
  WEBHOOK_FORMAT_OPTIONS,
} from "@/lib/webhooks/formats";

export const metadata = { title: "Webhooks" };

export const dynamic = "force-dynamic";

type DeliveryRow = Pick<
  WebhookDelivery,
  | "id"
  | "endpoint_id"
  | "event"
  | "status"
  | "attempts"
  | "last_response"
  | "created_at"
  | "suppressed"
  | "payload"
>;

export default async function WebhooksPage({
  searchParams,
}: {
  /**
   * What this page's four forms came back saying (#2384).
   *
   * All of them used to name `/admin`, which declares no search params, so every
   * outcome they wrote was encoded, attached to a URL and thrown away while the
   * admin was moved off the page they pressed the button on. `ok` and `error` are
   * the same channel every other admin page uses; `resend` and `replay` carry the
   * two action results, which are not saves and have more than two endings each.
   */
  searchParams: Promise<{
    ok?: string;
    error?: string;
    resend?: string;
    replay?: string;
  }>;
}) {
  const sp = await searchParams;
  const saved = savedSentence(savedOutcome(sp.ok));
  const replay = replayFeedback(sp.replay);
  const resend = sp.resend ? resendFeedback(sp.resend as ResendResult) : null;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;

  const db = supabaseAdmin();
  // #4381: the org's primary (oldest) endpoint, the one this page's form edits.
  const webhookRes = await readPrimaryWebhookEndpoint(db, me.org_id, "id, url, format");
  // #3091: the credentials are Worker secrets and their old columns are never
  // read, so this page holds no key or secret it could render by accident. Each
  // secret is turned into PRESENCE here.
  const webhook = webhookRes.data as Pick<WebhookEndpoint, "id" | "url" | "format"> | null;
  const credentialSources = webhook
    ? credentialSourcesFor({
        regalKeySet: regalWebhookKey().trim().length > 0,
        signingSecretSet: webhookSigningSecret().trim().length > 0,
      })
    : null;
  // #1629: a null here means "no endpoint configured" AND "could not read", and
  // the two differ by a data loss: the form below is prefilled from this row, so
  // saving a blank one over a real endpoint is the worst direction to fail in.
  const webhookUnreadable = webhookRes.error != null;

  let deliveries: DeliveryRow[] = [];
  let deliveriesUnreadable = false;
  const endpointUrl = new Map<string, string>();
  {
    try {
      const eps = (unwrap(
        await db.from("webhook_endpoints").select("id, url").eq("org_id", me.org_id),
        "admin webhook endpoints",
      ) ?? []) as { id: string; url: string }[];
      for (const e of eps) endpointUrl.set(e.id, e.url);
      if (eps.length) {
        deliveries = (unwrap(
          await db
            .from("webhook_deliveries")
            // #1951: `payload` is the exact body that was sent, and the page
            // used to omit it from this select, so real examples sat in the
            // database unread while nobody could see what Slate sends without
            // querying it. Better than any hand written sample: it is what
            // actually went out, per event, with nothing to keep in sync.
            .select(
              "id, endpoint_id, event, status, attempts, last_response, created_at, suppressed, payload",
            )
            .in(
              "endpoint_id",
              eps.map((e) => e.id),
            )
            .order("created_at", { ascending: false })
            .limit(25),
          "admin webhook deliveries",
        ) ?? []) as DeliveryRow[];
      }
    } catch (err) {
      log.error("admin", { msg: "webhook delivery log read failed" }, err);
      deliveries = [];
      deliveriesUnreadable = true;
    }
  }

  return (
    <>
      <AdminPageHeader title="Webhooks">
        Where Slate posts booking events, and what it has tried to deliver.
      </AdminPageHeader>
      {/* #2384: all four outcomes, drawn by the SAME component every other admin
          page draws its outcome with, rather than by this page's own copy of the
          markup. Two panels differing only in which file they live in is how the
          save confirmation and the resend confirmation drifted apart in the first
          place, and the shared one is the piece that also clears the parameter out
          of the address bar so a reload does not re-show a stale notice.

          #1076: every resend outcome says something. A refusal used to be logged
          server side and nothing else, so the admin pressed the button and watched
          the log re-render unchanged, which is indistinguishable from it working. */}
      {saved && <SettingsSaveNotice ok saved={saved} error={sp.error} />}
      {sp.error && !saved && <SettingsSaveNotice ok={false} error={sp.error} saved="" />}
      <ActionNotice feedback={resend} />
      <ActionNotice feedback={replay} />
      <section className={cardCls}>
        <h2 className="mb-2 text-sm font-semibold">Webhook endpoint</h2>
        {/* #1952: what a format IS now lives beside the CONTROL below, derived
            from WEBHOOK_FORMATS, rather than being described in a paragraph up
            here that was a second hand written copy of the same two facts (L41).
            The old copy called generic "a signed body" and never said what the
            signature covers, which is the one thing a subscriber needs to know
            in order to reject a replayed delivery. */}
        <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>
          Slate POSTs booking.* events here.
        </p>
        {/* #1629: `webhookRes.data` is null both when no endpoint is configured
            and when the read failed, and the form below is PREFILLED from it. On
            the second reading a save writes the placeholder URL over the live
            Regal endpoint, which is a data loss made from a reading that never
            happened, so the form is withheld rather than shown blank. */}
        {webhookUnreadable ? (
          <UnreadableNotice>
            The webhook endpoint could not be read, so it is not shown and cannot be
            edited here right now. Nothing has changed, and whatever is configured
            is still configured.
          </UnreadableNotice>
        ) : (
          <>
        {/* #1952: the "Current:" line is gone. It restated three facts that
            each sit in an editable control immediately below it (the URL in the
            URL field, the format in the dropdown, the key's state in the marker
            beside the key field), and the form is prefilled from the saved
            endpoint, so on load the two always agreed. Its key clause was the
            worst of the three: it said "no API key set" in the same muted grey
            as "API key stored", which is the exact failure this issue is about,
            and after adding the marker there were two captions of one fact (L558). */}
        <SaveForm action={setWebhookEndpoint} name="webhook-endpoint" unsaved="changes to this endpoint" className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <label className={labelCls} htmlFor="webhook-url">
                URL
              </label>
              <input
                id="webhook-url"
                name="url"
                defaultValue={webhook?.url ?? "https://events.regalvoice.com/events"}
                placeholder="https://events.regalvoice.com/events"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="webhook-format">
                Format
              </label>
              {/* The options are DERIVED from the same record the builders are
                  keyed on, so a format added to the union cannot be missing from
                  this list, and one listed here cannot be missing a builder. It
                  used to be an array written by hand beside the union. */}
              <SelectField
                id="webhook-format"
                name="format"
                defaultValue={webhook?.format ?? "regal"}
                className="w-full"
                options={WEBHOOK_FORMAT_OPTIONS}
              />
            </div>
          </div>
          {/* What each one is, next to the control that picks it, and the fact
              that the list is closed so nobody hunts for a way to add a third. */}
          <dl className={`space-y-1.5 text-xs text-fg-muted ${proseCls}`}>
            {WEBHOOK_FORMAT_OPTIONS.map((o) => (
              <div key={o.value}>
                <dt className="inline font-semibold text-fg">{o.label}: </dt>
                <dd className="inline">{WEBHOOK_FORMATS[o.value].what}</dd>
              </div>
            ))}
          </dl>
          <p className={`text-xs text-fg-muted ${proseCls}`}>{WEBHOOK_FORMAT_NOTE}</p>
          {/* #3091: both credentials are Worker secrets, readable by the running
              Worker alone, so there is no field for either. Changing one is a
              deploy step (DEPLOY.md, section 2b). What is left here is whether
              each is set, as a MARKER (#1952), never a masked value: dots invent a
              length and the real length leaks something about the key (#600).

              Judged on the SAVED format, not the dropdown: a credential the saved
              format does not use is not one that is missing. And an endpoint that
              does not exist yet gets no markers, because nothing configured is not
              a credential that is missing. */}
          {webhook && credentialSources ? (
            <dl className="space-y-1.5 text-xs">
              <CredentialRow
                label="Regal API key"
                source={credentialSources.key}
                used={webhook.format === "regal"}
              />
              <CredentialRow
                label="Signing secret"
                source={credentialSources.signing}
                used={webhook.format === "generic"}
              />
            </dl>
          ) : null}
          <SubmitButton className={btnCls} pendingLabel="Saving…">
            Save
          </SubmitButton>
        </SaveForm>
        {/* #1951: a real POST at a URL you paste, so the request, the headers
            and the response can all be looked at. Dan's call over a preview
            only panel and over firing at the configured endpoint. */}
        <div className="mt-5 border-t border-border pt-4">
          <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>
            Paste a scratch endpoint (webhook.site or similar) and Slate sends one
            sample event at it, built by the same code the live path uses, in the
            format saved above. Nothing reaches {" "}
            {webhook ? "your live endpoint" : "a real destination"}: the live host
            is refused, as are private addresses. The sample carries no real lead,
            no real API key and no real signing secret, and no delivery is
            recorded below, so it is safe to press as often as you like.
          </p>
          <WebhookTestSend action={sendTestWebhook} />
        </div>
          </>
        )}
      </section>
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Webhook deliveries</h2>
        {/* An empty log says "nothing has been sent", on the panel opened
            precisely to check whether something was (#1629). */}
        {deliveriesUnreadable && (
          <UnreadableNotice className="mb-3">
            The delivery log could not be read, so no attempts are listed. This is
            not a report that nothing was sent.
          </UnreadableNotice>
        )}
        <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>
          {deliveriesUnreadable
            ? "Resend re-fires one delivery immediately. Test bucket bookings and test agents are recorded as “not sent”: they never reach a downstream system, so they cannot be resent."
            : `The last ${deliveries.length} delivery attempts. Resend re-fires one immediately. Test bucket bookings and test agents are recorded as “not sent”: they never reach a downstream system, so they cannot be resent.`}
        </p>
        <SaveForm
          name="webhook-replay"
          unsaved="nothing typed here"
          action={replayFailedWebhooks}
          className="mb-3 flex flex-wrap items-center gap-2"
        >
          <label htmlFor="replay-hours" className="text-xs text-fg-muted">
            Replay every failed delivery from the last
          </label>
          <SelectField
            id="replay-hours"
            name="hours"
            defaultValue="24"
            className="w-40"
            options={[
              { value: "2", label: "2 hours" },
              { value: "6", label: "6 hours" },
              { value: "24", label: "24 hours" },
              { value: "72", label: "3 days" },
              { value: "168", label: "7 days" },
            ]}
          />
          <SubmitButton className={btnSecondaryCls} pendingLabel="Replaying…">
            Replay failed deliveries
          </SubmitButton>
        </SaveForm>
        {deliveriesUnreadable ? null : deliveries.length === 0 ? (
          <p className="text-sm text-fg-muted">No deliveries yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-fg-muted">
                <tr>
                  <th className="py-1 pr-3 font-semibold">When</th>
                  <th className="py-1 pr-3 font-semibold">Event</th>
                  <th className="py-1 pr-3 font-semibold">Endpoint</th>
                  <th className="py-1 pr-3 font-semibold">Status</th>
                  <th className="py-1 pr-3 font-semibold">Tries</th>
                  <th className="py-1 pr-3 font-semibold">Payload</th>
                  <th className="py-1 font-semibold" />
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => {
                  const view = deliveryDisplay(d);
                  return (
                    <tr key={d.id} className="border-t border-border align-top">
                      <td className="whitespace-nowrap py-1.5 pr-3 text-fg-muted tabular-nums">
                        {new Date(d.created_at).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="py-1.5 pr-3">{d.event}</td>
                      <td
                        className="max-w-[160px] truncate py-1.5 pr-3 text-fg-muted"
                        title={endpointUrl.get(d.endpoint_id) ?? ""}
                      >
                        {endpointUrl.get(d.endpoint_id) ?? "?"}
                      </td>
                      <td className="py-1.5 pr-3">
                        <Pill
                          title={view.hint ?? d.last_response ?? ""}
                          variant={view.variant}
                          alignToColumn
                        >
                          {view.label}
                        </Pill>
                      </td>
                      <td className="py-1.5 pr-3 text-fg-muted tabular-nums">{d.attempts}</td>
                      <td className="py-1.5 pr-3">
                        {d.payload == null ? (
                          // A row with no stored body is not a row whose body
                          // was empty, and saying nothing here would read as the
                          // second (L10).
                          <span className="text-fg-muted">Not stored</span>
                        ) : (
                          <details>
                            <summary className="cursor-pointer font-semibold marker:text-fg-muted">
                              Show
                            </summary>
                            {/* A suppressed row was RECORDED and never POSTed, so
                                its body is what would have been sent. Left
                                unsaid it reads as delivered, which is the one
                                thing this panel exists to tell apart. */}
                            {d.suppressed && (
                              <p className="mt-1 w-105 text-fg-muted">
                                Never sent: this is what would have gone out.
                              </p>
                            )}
                            <pre className="mt-1 max-h-80 w-105 overflow-y-auto rounded-[var(--radius-md)] bg-[var(--field)] px-3 py-2 whitespace-pre-wrap break-all text-fg">
                              {JSON.stringify(d.payload, null, 2)}
                            </pre>
                          </details>
                        )}
                      </td>
                      <td className="py-1.5">
                        {view.resendable ? (
                          <SaveForm action={resendWebhookDelivery} name={`webhook-resend-${d.id}`} unsaved="nothing typed here">
                            <input type="hidden" name="delivery_id" value={d.id} />
                            <SubmitButton className={btnSecondaryCls} pendingLabel="Resending…">
                              Resend
                            </SubmitButton>
                          </SaveForm>
                        ) : (
                          // resendDelivery() refuses a suppressed row, so a button
                          // here would be a no-op that looks like an action.
                          <span className="text-xs text-fg-muted">Not resendable</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/**
 * One of this page's two ACTION results (#2384), drawn by the same notice every
 * admin save uses.
 *
 * Written once rather than at each of the two call sites, because the tone to
 * `ok`/`error` mapping is the same decision both times and a second hand rolled
 * copy of it is how the resend banner and the save banner drifted apart before
 * this (L613). `null` is the ordinary case: nobody has pressed either button.
 */
function ActionNotice({ feedback }: { feedback: ResendFeedback | null }) {
  if (!feedback) return null;
  const ok = feedback.tone === "ok";
  return (
    <SettingsSaveNotice
      ok={ok}
      saved={ok ? feedback.message : ""}
      error={ok ? undefined : feedback.message}
    />
  );
}

/**
 * One credential's state (#3091). Three states, each its own marker, because each
 * sends the reader somewhere different: nothing to do, a delivery that is failing
 * now, or a credential this format never sends.
 */
function CredentialRow({
  label,
  source,
  used,
}: {
  label: string;
  source: CredentialSource;
  used: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <dt className="font-semibold text-fg">{label}</dt>
      <dd>
        {!used ? (
          <Pill variant="outline">Not used by this format</Pill>
        ) : source === "worker" ? (
          <Pill variant="status-ok">Set</Pill>
        ) : (
          <Pill variant="status-error">Not set, deliveries are refused</Pill>
        )}
      </dd>
    </div>
  );
}
