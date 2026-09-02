import { inputCls, labelCls } from "@/components/ui/styles";

/**
 * A labelled text input, used by the event type and bucket editors (#1748). It
 * was a local helper on the old single-page /admin; both of its callers are their
 * own routes now, so it moved out rather than being written twice.
 */
export function Field({
  name,
  label,
  defaultValue,
  small,
}: {
  name: string;
  label: string;
  defaultValue: string;
  small?: boolean;
}) {
  return (
    <div>
      <label className={labelCls}>
        {label}
      </label>
      <input
        name={name}
        aria-label={label}
        defaultValue={defaultValue}
        className={`${inputCls} ${small ? "w-24" : "w-48"}`}
      />
    </div>
  );
}
