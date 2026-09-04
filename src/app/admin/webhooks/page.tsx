import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
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
import { resendFeedback, type ResendResult } from "@/lib/webhooks/resend-feedback";
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
  searchParams: Promise<{ resend?: string; webhook_error?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");

  const db = supabaseAdmin();
  const webhookRes = await db
    .from("webhook_endpoints")
    .select("*")
    .eq("org_id", me.org_id)
    .limit(1)
    .maybeSingle();
  const webhook = webhookRes.data as WebhookEndpoint | null;
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
      {/* #1076: every resend outcome says something. A refusal used to be logged
          server side and nothing else, so the admin pressed the button and watched
          the log re-render unchanged, which is indistinguishable from it working. */}
      {sp.resend &&
        (() => {
          const fb = resendFeedback(sp.resend as ResendResult);
          return fb.tone === "ok" ? (
            <div
              role="status"
              className="rounded-md bg-[var(--pennie-green-wash)] px-5 py-4 text-sm text-fg"
            >
              {fb.message}
            </div>
          ) : (
            <div
              role="alert"
              className="rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
            >
              {fb.message}
            </div>
          );
        })()}
      {sp.webhook_error && (
        <div
          role="alert"
          className="rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
        >
          Webhook not saved: {sp.webhook_error}
        </div>
      )}
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
        <form action={setWebhookEndpoint} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <label className={labelCls}>URL</label>
              <input
                name="url"
                defaultValue={webhook?.url ?? "https://events.regalvoice.com/events"}
                placeholder="https://events.regalvoice.com/events"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Format</label>
              {/* The options are DERIVED from the same record the builders are
                  keyed on, so a format added to the union cannot be missing from
                  this list, and one listed here cannot be missing a builder. It
                  used to be an array written by hand beside the union. */}
              <SelectField
                name="format"
                ariaLabel="Format"
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
          <div>
            {/* #1901, the fourth instance of the pattern, found by the guard
                rather than by eye. The field IS the Regal API key; sending it as
                the Authorization header is the mechanism, and the placeholder
                below already says which. So the label is the name. */}
            {/* #1952: the key's state as a MARKER, not as two sentences that
                differ only in wording. Both states used to be the same empty
                password input with the same grey hint under it, so a reader
                scanning the page saw an empty field, which reads as "not set",
                and had to read to learn otherwise.

                And the failing state was drawn like the healthy one. `buildRequest`
                REFUSES to build a regal request with no key (#600), so "no key
                saved" means every booking event is failing to deliver: that is an
                error, and it now looks like one.

                Deliberately NOT a masked value. Rendering dots invents a length,
                and rendering the real length leaks something about the key; #600
                exists because the key used to reach this page at all. */}
            <div className="flex flex-wrap items-center gap-2">
              <label className={labelCls} htmlFor="webhook-auth-header">
                Regal API key
              </label>
              {/* The state is judged on the SAVED format, not on the dropdown's
                  current selection: a generic endpoint authenticates with the
                  HMAC secret and needs no key here at all, so a red "No key
                  saved" on one would be a false alarm about a field it does not
                  use. And an endpoint that does not exist yet gets no marker,
                  because "nothing is configured" is not a key that is missing. */}
              {webhook == null ? null : webhook.format !== "regal" ? (
                <Pill variant="outline">Not used by this format</Pill>
              ) : webhook.auth_header ? (
                <Pill variant="status-ok">Key saved</Pill>
              ) : (
                <Pill variant="status-error">No key saved</Pill>
              )}
            </div>
            {/* #600: never render the stored key. It used to come down as this input's
                defaultValue, which put the live secret in the page HTML and on screen in
                plain text. Write only: blank leaves the saved key untouched. */}
            <input
              id="webhook-auth-header"
              name="auth_header"
              type="password"
              autoComplete="off"
              defaultValue=""
              placeholder={
                webhook?.auth_header ? "Leave blank to keep the current key" : "Regal API key"
              }
              className={inputCls}
            />
            {webhook?.auth_header ? (
              <p className="mt-1 text-xs text-fg-muted">
                Leave this blank to keep the saved key, or type a new one to replace it.
              </p>
            ) : webhook != null && webhook.format === "regal" ? (
              <p className="mt-1 text-xs text-error">
                Regal deliveries fail until a key is set, because Slate refuses to
                send an unauthenticated one.
              </p>
            ) : (
              <p className="mt-1 text-xs text-fg-muted">
                Needed only by the Regal format, which sends it as the
                Authorization header.
              </p>
            )}
          </div>
          <SubmitButton className={btnCls} pendingLabel="Saving…">
            Save
          </SubmitButton>
        </form>
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
            ? "Resend re-fires one delivery immediately. Test bucket bookings are recorded as “not sent”: they never reach a downstream system, so they cannot be resent."
            : `The last ${deliveries.length} delivery attempts. Resend re-fires one immediately. Test bucket bookings are recorded as “not sent”: they never reach a downstream system, so they cannot be resent.`}
        </p>
        <form
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
        </form>
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
                          <form action={resendWebhookDelivery}>
                            <input type="hidden" name="delivery_id" value={d.id} />
                            <SubmitButton className={btnSecondaryCls} pendingLabel="Resending…">
                              Resend
                            </SubmitButton>
                          </form>
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
