import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { setEventDescription } from "@/app/admin/actions";
import { EVENT_DESCRIPTION_MAX } from "@/lib/booking/settings";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { btnCls, cardCls, labelCls, proseCls, textareaCls } from "@/components/ui/styles";

export const dynamic = "force-dynamic";

export default async function BookerCopyPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");

  // #1335: the event types whose lead-facing description is editable here.
  // Guarded like its old neighbours, so a missing table during a
  // migrate-before-deploy window shows an empty editor rather than 500ing.
  let eventTypes: { id: string; name: string; description: string | null }[] = [];
  try {
    // cap-safe: event_types is roster-bounded config (one per offering), a fixed
    // handful of rows that can never fill a page.
    const types = await supabaseAdmin()
      .from("event_types")
      .select("id, name, description")
      .order("created_at");
    if (!types.error && types.data) {
      eventTypes = types.data as typeof eventTypes;
    }
  } catch {
    // Fall through to an empty list.
  }

  return (
    <>
      <AdminPageHeader title="Booker copy">
        The words a lead reads on the booking panel before they pick a time.
      </AdminPageHeader>
      <SettingsSaveNotice ok={!!sp.ok} error={sp.error} saved="Booker copy saved." />
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">What the lead reads before booking</h2>
        <p className={`mb-4 ${proseCls} text-xs text-fg-muted`}>
          The description on the booking panel. Leave a blank line between
          paragraphs; they are shown apart, so a description and an ask do not run
          together. Up to {EVENT_DESCRIPTION_MAX} characters. A change reaches
          leads within a minute or two.
        </p>
        {eventTypes.length === 0 ? (
          <p className="text-xs text-fg-muted">
            No event type yet. Add one on the admin page first.
          </p>
        ) : (
          eventTypes.map((e) => (
            <form
              key={e.id}
              action={setEventDescription}
              // #1945: an explicit column with a real gap. `space-y-3` alone
              // could not separate the field from the button, because both were
              // inline level and sat side by side: a vertical utility has nothing
              // to act on. The field is `block` now AND the form says how the two
              // are laid out, rather than depending on one of them.
              className="mb-4 flex flex-col items-start gap-3 last:mb-0"
            >
              <input type="hidden" name="event_type_id" value={e.id} />
              <label className={labelCls} htmlFor={`description-${e.id}`}>
                {e.name}
              </label>
              <textarea
                id={`description-${e.id}`}
                name="description"
                rows={6}
                maxLength={EVENT_DESCRIPTION_MAX}
                defaultValue={e.description ?? ""}
                // prose-width-ok: this is a text INPUT, not a line of prose.
                // The number is sizing a control, and a 110 character wide box
                // on this page would be wrong.
                className={`${textareaCls} max-w-prose`}
              />
              <SubmitButton className={btnCls} pendingLabel="Saving…">
                Save description
              </SubmitButton>
            </form>
          ))
        )}
      </section>
    </>
  );
}
