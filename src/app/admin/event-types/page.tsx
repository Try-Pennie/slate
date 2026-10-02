import { redirect } from "next/navigation";
import { SaveForm } from "@/components/ui/SaveForm";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createEventType } from "@/app/admin/actions";
import { EventTypeGapForm } from "@/app/admin/event-types/EventTypeGapForm";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { Field } from "@/components/admin/Field";
import { btnCls, cardCls, labelCls, textareaCls } from "@/components/ui/styles";
import {
  EVENT_TYPE_DEFAULTS,
  EVENT_TYPE_FIELD_NOTES,
} from "@/lib/booking/event-type-defaults";
import type { EventType } from "@/lib/db/types";

export const dynamic = "force-dynamic";

export default async function EventTypesPage({
  searchParams,
}: {
  /** What the add form came back saying (#2385). A duplicate title and a blank
   *  one are both refusals the reader can fix, and both used to throw. */
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const saved = savedSentence(savedOutcome(sp.ok));
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;

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
        What a bucket can be booked for, and how long each one runs.
      </AdminPageHeader>
      {saved && <SettingsSaveNotice ok saved={saved} error={sp.error} />}
      {sp.error && !saved && <SettingsSaveNotice ok={false} error={sp.error} saved="" />}
      <section className={cardCls}>
        {/* #1915: no heading of its own. The page header above names this,
            and a section that IS the page restating the page's title is the
            redundancy Dan read as "this is redundant". A page shell that titles
            itself and a section that titles itself are each correct alone; the
            duplication exists only in the composition, which is the one place
            nobody reads. */}
        {/* "None yet." beside a form that creates one is an invitation, so it may
            only be shown when the read that says so actually ran (#1629). */}
        {eventTypesUnreadable ? (
          <UnreadableNotice className="mb-4">
            The event types could not be read, so none are listed. Do not add one
            from this screen until it loads, or you may create a duplicate.
          </UnreadableNotice>
        ) : (
          <ul className="mb-4 space-y-4 text-sm">
            {eventTypes.map((e) => (
              <li key={e.id} className="space-y-2">
                <p className="text-fg tabular-nums">
                  {e.name} · {e.duration_min}m · {e.min_notice_min}m notice ·{" "}
                  {e.slot_interval_min}m grid
                  {e.daily_cap ? ` · cap ${e.daily_cap}/day` : ""}
                </p>
                <EventTypeGapForm eventType={e} />
              </li>
            ))}
            {eventTypes.length === 0 && (
              <li className="text-fg-muted">None yet.</li>
            )}
          </ul>
        )}
        {/* #1950: the add form is COLLAPSED, and that is the last half of the
            two numbers Dan read off one screen. The placeholders below are the
            default a NEW event type gets, and the line above them is the live
            record, so a 15 minute grid and a "10m grid" were sitting inches
            apart both telling the truth about different things. Behind a
            disclosure they are never on screen together, and the form also
            stops reading as an edit of the record it sits under.

            Native details/summary: keyboard operable, needs no client JS, and
            the pattern this repo already uses (#740). */}
        <details className="group">
          <summary className="cursor-pointer text-sm font-semibold text-fg marker:text-fg-muted">
            Add an event type
          </summary>
          <p className="mt-1 mb-3 text-xs text-fg-muted">
            A box left blank takes the value shown in it. The title is yours to
            pick and has to be new.
          </p>
        <SaveForm action={createEventType} name="event-type" unsaved="this new call type" className="space-y-3">
          {/* #1950: every box arrives EMPTY, and the numbers appear only as
              placeholders. A `defaultValue` submits when untouched, so the six
              literals that used to sit here were values nobody typed reaching
              the database, and two of them had drifted from the record listed
              directly above: the form offered 30 minutes on a 15 minute grid
              against a live 20 on a 10. The placeholders quote
              EVENT_TYPE_DEFAULTS, which the guard holds to the column's own DDL
              default, so the number shown is the number a blank field gets.

              `items-start`, not `items-end`. A row aligned on its children's
              bottom edges aligns the CONTAINERS, so the moment one column
              carries a hint line its input is pushed out of line with the rest
              while every column still reads as correct on its own. */}
          <div className="grid grid-cols-2 items-start gap-x-3 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
            <div className="col-span-2">
              <Field
                name="name"
                label="Title (eventTitle)"
                placeholder="Senior Loan Advisor Call"
                required
              />
            </div>
            <Field
              name="regal_type"
              label="Regal type slug"
              placeholder={EVENT_TYPE_DEFAULTS.regal_type}
              small
            />
            <Field
              name="duration_min"
              label="Duration (m)"
              placeholder={String(EVENT_TYPE_DEFAULTS.duration_min)}
              small
            />
            <Field
              name="slot_interval_min"
              label="Grid (m)"
              placeholder={String(EVENT_TYPE_DEFAULTS.slot_interval_min)}
              hint={EVENT_TYPE_FIELD_NOTES.slot_interval_min}
              small
            />
            <Field
              name="min_notice_min"
              label="Notice (m)"
              placeholder={String(EVENT_TYPE_DEFAULTS.min_notice_min)}
              hint={EVENT_TYPE_FIELD_NOTES.min_notice_min}
              small
            />
            <Field
              name="gap_min"
              label="Gap between calls (m)"
              placeholder={String(EVENT_TYPE_DEFAULTS.buffer_after_min)}
              hint={EVENT_TYPE_FIELD_NOTES.gap_min}
              small
            />
            <Field
              name="daily_cap"
              label="Daily cap"
              placeholder="No cap"
              hint={EVENT_TYPE_FIELD_NOTES.daily_cap}
              small
            />
          </div>
          <div>
            {/* heading-gloss-ok: WHERE the value goes, which is what somebody
                needs while typing it, not a definition of the word Description. */}
            <label className={labelCls}>Description (shown to lead + sent to Regal)</label>
            {/* #1945: a FOURTH textarea wearing the single line style, which
                Dan's report did not name and the guard found. Same three
                consequences: `rows` inert against `h-[44px]`, no vertical
                padding so the text touches both edges, and inline so the Add
                button could flow beside it. */}
            <textarea
              name="description"
              rows={2}
              className={textareaCls}
              placeholder="Twenty minutes with a senior advisor to confirm your income…"
            />
          </div>
          <SubmitButton className={btnCls} pendingLabel="Adding…">
            Add event type
          </SubmitButton>
        </SaveForm>
        </details>
      </section>
    </>
  );
}
