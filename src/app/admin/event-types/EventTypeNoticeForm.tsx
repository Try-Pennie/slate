import { SaveForm } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Field } from "@/components/admin/Field";
import { btnCls } from "@/components/ui/styles";
import { setEventTypeNotice } from "@/app/admin/actions";
import type { EventType } from "@/lib/db/types";
import { LOADED_VERSION_FIELD, loadedVersionValue } from "@/lib/admin/edit-version";

/**
 * Edit how far ahead of now the earliest offered time can be, in place on the
 * listed event type (#3003). It is how soon a lead can book, so it is a setting
 * an admin tunes rather than one that needs an engineer.
 *
 * This is an EDIT of a stored record, so the field arrives holding the stored
 * value: an untouched box submits exactly what is already there.
 */
export function EventTypeNoticeForm({ eventType: e }: { eventType: EventType }) {
  return (
    <SaveForm
      action={setEventTypeNotice}
      name={`event-type-notice-${e.id}`}
      unsaved={`the notice for ${e.name} calls`}
      className="flex flex-wrap items-end gap-3"
    >
      <input type="hidden" name="event_type_id" value={e.id} />
      {/* #3122: the version this form was drawn from, so a save over a newer one is refused. */}
      <input type="hidden" name={LOADED_VERSION_FIELD} value={loadedVersionValue(e.updated_at)} />
      <Field
        name="min_notice_min"
        id={`field-min_notice_min-${e.id}`}
        label="Notice (m)"
        defaultValue={String(e.min_notice_min)}
        small
      />
      <SubmitButton className={btnCls} pendingLabel="Saving…">
        Save notice
      </SubmitButton>
    </SaveForm>
  );
}
