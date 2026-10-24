import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { EventDescriptionForm } from "@/app/admin/booker-copy/EventDescriptionForm";
import { EVENT_DESCRIPTION_MAX } from "@/lib/booking/settings";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { cardCls, proseCls } from "@/components/ui/styles";

export const metadata = { title: "Booker copy" };

export const dynamic = "force-dynamic";

export default async function BookerCopyPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const saved = savedSentence(savedOutcome(sp.ok));
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;

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
      {/* #1990: the sentence comes from the OUTCOME, so it names the form
          that saved rather than whatever this page had written down. An
          unrecognised value (a bookmarked `?ok=1` from before outcomes were
          named) shows nothing, rather than confirming a save nobody made. */}
      {saved && <SettingsSaveNotice ok saved={saved} error={sp.error} />}
      {sp.error && !saved && <SettingsSaveNotice ok={false} error={sp.error} saved="" />}
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
          eventTypes.map((e) => <EventDescriptionForm key={e.id} eventType={e} />)
        )}
      </section>
    </>
  );
}
