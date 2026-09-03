import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { replayFailedWebhooks, resendWebhookDelivery, setWebhookEndpoint } from "@/app/admin/actions";
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
            .select(
              "id, endpoint_id, event, status, attempts, last_response, created_at, suppressed",
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
        <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>
          Slate POSTs booking.* events here. <strong>Regal</strong> format sends
          the Regal event shape with your API key as the Authorization header;{" "}
          <strong>Generic</strong> sends a signed <code>{"{event,data}"}</code>{" "}
          body (good for webhook.site).
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
        {webhook && (
          <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>
            Current: <code className="break-all">{webhook.url}</code> · {webhook.format} ·{" "}
            {webhook.format === "regal"
              ? webhook.auth_header
                ? "API key stored"
                : "no API key set"
              : "signing secret stored"}
          </p>
        )}
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
              <select
                name="format"
                aria-label="Format"
                defaultValue={webhook?.format ?? "regal"}
                className={inputCls}
              >
                <option value="regal">Regal</option>
                <option value="generic">Generic (signed)</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>
              Authorization header (Regal API key)
            </label>
            {/* #600: never render the stored key. It used to come down as this input's
                defaultValue, which put the live secret in the page HTML and on screen in
                plain text. Write only: blank leaves the saved key untouched. */}
            <input
              name="auth_header"
              type="password"
              autoComplete="off"
              defaultValue=""
              placeholder={
                webhook?.auth_header ? "Leave blank to keep the current key" : "Regal API key"
              }
              className={inputCls}
            />
            <p className="mt-1 text-xs text-fg-muted">
              {webhook?.auth_header
                ? "A key is saved. Leave this blank to keep it, or type a new one to replace it."
                : "No key saved yet. Regal deliveries will fail until one is set."}
            </p>
          </div>
          <SubmitButton className={btnCls} pendingLabel="Saving…">
            Save
          </SubmitButton>
        </form>
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
          <select
            id="replay-hours"
            name="hours"
            defaultValue="24"
            className={`${inputCls} w-auto`}
          >
            <option value="2">2 hours</option>
            <option value="6">6 hours</option>
            <option value="24">24 hours</option>
            <option value="72">3 days</option>
            <option value="168">7 days</option>
          </select>
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
