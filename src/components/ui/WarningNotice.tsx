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
 */
export function WarningNotice({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className={WARNING_NOTICE_CLASS}>
      <AlertIcon width={20} height={20} className="mt-0.5 shrink-0 text-[var(--error)]" />
      <p className={proseCls}>{children}</p>
    </div>
  );
}
