import { AlertIcon } from "@/components/icons";
import { proseCls } from "@/components/ui/styles";
import { WARNING_NOTICE_CLASS } from "@/components/ui/warning-notice-paint";

/**
 * Something the reader should act on that is not an error in Slate itself (#3549):
 * the first use is an advisor whose cal.com week differs from the one they set here.
 *
 * Distinct from `UnreadableNotice`, which says a section could not be read. That
 * one is `role="alert"`; this is `role="status"`, because it is drawn with the page
 * rather than arriving mid-task, and an alert would interrupt a screen reader on
 * every load. Colour is never the only signal: the icon and the sentence carry it.
 *
 * `block` holds several paragraphs and a control (the coordinator page's existing call,
 * with the checkbox the coordinator checks once the customer is told, #4205) in a div
 * rather than one paragraph; `labelledBy` names the notice by its own heading line.
 */
export function WarningNotice({
  children,
  block = false,
  id,
  labelledBy,
}: {
  children: React.ReactNode;
  block?: boolean;
  id?: string;
  labelledBy?: string;
}) {
  return (
    <div role="status" id={id} aria-labelledby={labelledBy} className={WARNING_NOTICE_CLASS}>
      <AlertIcon width={20} height={20} className="mt-0.5 shrink-0 text-[var(--error)]" />
      {block ? <div className={proseCls}>{children}</div> : <p className={proseCls}>{children}</p>}
    </div>
  );
}
