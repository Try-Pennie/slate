import { SaveForm } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Field } from "@/components/admin/Field";
import { btnCls } from "@/components/ui/styles";
import { setEventTypeNotice } from "@/app/admin/actions";
import type { EventType } from "@/lib/db/types";
import { loadedFieldName, loadedFieldValue } from "@/lib/admin/edit-version";

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
      {/* #3122, #3798: the notice this form was drawn with, so a save over somebody
          else's newer notice is refused, while a save of the gap or the
          description in between is not. */}
      <input type="hidden" name={loadedFieldName("min_notice_min")} value={loadedFieldValue(e.min_notice_min)} />
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
