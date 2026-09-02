import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createEventType } from "@/app/admin/actions";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { Field } from "@/components/admin/Field";
import { btnCls, cardCls, inputCls, labelCls } from "@/components/ui/styles";
import type { EventType } from "@/lib/db/types";

export const dynamic = "force-dynamic";

export default async function EventTypesPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");

  const res = await supabaseAdmin()
    .from("event_types")
    .select("*")
    .eq("org_id", me.org_id);
  // #1629: empty reads as "no event types configured", and the form below invites
  // the admin to create one, so a broken read invites a duplicate.
  const eventTypes = (res.data ?? []) as EventType[];
  const eventTypesUnreadable = res.error != null;

  return (
    <>
      <AdminPageHeader title="Event types">
        The meeting kinds a bucket can be booked for, and how long each one runs.
      </AdminPageHeader>
      <section className={cardCls}>
        <h2 className="mb-4 text-sm font-semibold">Event types</h2>
        {/* "None yet." beside a form that creates one is an invitation, so it may
            only be shown when the read that says so actually ran (#1629). */}
        {eventTypesUnreadable ? (
          <UnreadableNotice className="mb-4">
            The event types could not be read, so none are listed. Do not add one
            from this screen until it loads, or you may create a duplicate.
          </UnreadableNotice>
        ) : (
          <ul className="mb-4 space-y-1 text-sm">
            {eventTypes.map((e) => (
              <li key={e.id} className="text-fg tabular-nums">
                {e.name} · {e.duration_min}m · {e.min_notice_min}m notice ·{" "}
                {e.slot_interval_min}m grid
                {e.daily_cap ? ` · cap ${e.daily_cap}/day` : ""}
              </li>
            ))}
            {eventTypes.length === 0 && (
              <li className="text-fg-muted">None yet.</li>
            )}
          </ul>
        )}
        <form action={createEventType} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field name="name" label="Title (eventTitle)" defaultValue="Senior Loan Advisor Call" />
            <Field name="regal_type" label="Regal type slug" defaultValue="call" small />
            <Field name="duration_min" label="Duration (m)" defaultValue="30" small />
            <Field name="slot_interval_min" label="Grid (m)" defaultValue="15" small />
            <Field name="min_notice_min" label="Notice (m)" defaultValue="120" small />
            <Field name="buffer_after_min" label="Buffer after (m)" defaultValue="0" small />
            <Field name="daily_cap" label="Daily cap" defaultValue="" small />
          </div>
          <div>
            <label className={labelCls}>Description (shown to lead + sent to Regal)</label>
            <textarea
              name="description"
              rows={2}
              className={inputCls}
              placeholder="Twenty minutes with a senior advisor to confirm your income…"
            />
          </div>
          <SubmitButton className={btnCls} pendingLabel="Adding…">
            Add event type
          </SubmitButton>
        </form>
      </section>
    </>
  );
}
