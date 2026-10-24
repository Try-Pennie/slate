import { SaveForm } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnCls, labelCls, textareaCls } from "@/components/ui/styles";
import { setEventDescription } from "@/app/admin/actions";
import { EVENT_DESCRIPTION_MAX } from "@/lib/booking/settings";
import type { EventType } from "@/lib/db/types";
import { loadedFieldName, loadedFieldValue } from "@/lib/admin/edit-version";

/**
 * Edit the description a lead reads before booking, for one event type (#1335).
 * Its own component, like the gap and notice editors, so a test can render what
 * it submits (#3798).
 */
export function EventDescriptionForm({
  eventType: e,
}: {
  eventType: Pick<EventType, "id" | "name" | "description">;
}) {
  return (
    <SaveForm
      action={setEventDescription}
      // #1998: the name carries the EVENT TYPE, because this form is
      // rendered once per event type. A single name would file every
      // one of them under one key, so a save killed by a deploy would
      // restore one event type's description onto another's field.
      name={`booker-copy-${e.id}`}
      unsaved="changes to this description"
      // #1945: an explicit column with a real gap. `space-y-3` alone
      // could not separate the field from the button, because both were
      // inline level and sat side by side: a vertical utility has nothing
      // to act on. The field is `block` now AND the form says how the two
      // are laid out, rather than depending on one of them.
      className="mb-4 flex flex-col items-start gap-3 last:mb-0"
    >
      <input type="hidden" name="event_type_id" value={e.id} />
      {/* #3122, #3798: the description this form was drawn with, so a save over
          somebody else's newer description is refused, while a save of the gap or
          the notice in between is not. */}
      <input type="hidden" name={loadedFieldName("description")} value={loadedFieldValue(e.description)} />
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
    </SaveForm>
  );
}
