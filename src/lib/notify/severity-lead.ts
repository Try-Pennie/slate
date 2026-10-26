/**
 * The first line of every message the alert dispatcher posts but an ordinary page
 * (#1825): whether the reader is being asked to do anything. Pure, so the rule is pinned offline
 * (`scripts/test-alert-severity-lead.ts`) and the preview shows exactly what ships.
 *
 * On 2026-09-03 a page (a parked detector able to watch and still switched off) and
 * a whisper (twelve tiers thinly staffed) arrived back to back in one channel, in
 * the same plain text from the same app, with nothing saying which one needed
 * acting on. The info channel falls back to the alerts channel when it is unset, so
 * a separate channel alone cannot carry the difference; the message has to. Slack
 * shows the start of the text in the phone notification, so the lead is also what
 * somebody sees before opening it.
 *
 * The lead is chosen from two facts the dispatcher already holds, never at a send
 * site (L621): which sender carried the message (a page, a whisper, or an all
 * clear) and the catalog classification of its key. A whisper wins over the key's
 * kind, because a check that chose the quiet sender judged it needs no action; an
 * info key is a whisper whichever sender carried it; a key the catalog does not
 * classify reads as a page, the loud side.
 */
import { alertKindOf, isUrgentCondition } from "@/lib/notify/alert-catalog";

/** Which dispatcher entry point posted the message. */
export type AlertVoice = "page" | "info" | "recovery";

/** What the lead tells the reader. */
export type AlertSeverity = "urgent" | "attention" | "whisper" | "resolved";

/**
 * The lead lines, in Slack mrkdwn. An urgent page and an all clear are bold; a whisper
 * is italic, so the quiet one also LOOKS quieter, not only reads so. Words rather than
 * emoji (project copy rule), and colour is never the only signal.
 *
 * A page needing attention, the commonest post, carries NO lead and opens with its own
 * text (Dan, 2026-10-25: "We can just remove it everywhere"). The ones that differ from
 * it still say so: urgent above it, a whisper and an all clear beside it.
 */
export const SEVERITY_LEADS: Readonly<Record<AlertSeverity, string | null>> = {
  urgent: "*URGENT: leads are affected now.*",
  attention: null,
  whisper: "_FYI, no action needed now._",
  resolved: "*Resolved.*",
};

/** The severity a message from `voice` about `key` carries. */
export function severityOf(key: string, voice: AlertVoice): AlertSeverity {
  if (voice === "recovery") return "resolved";
  if (voice === "info") return "whisper";
  const kind = alertKindOf(key);
  if (kind === "info") return "whisper";
  if (isUrgentCondition(key)) return "urgent";
  return "attention";
}

/** `text` as posted: the lead, if its severity has one, on its own first line, the text below it untouched. */
export function withSeverityLead(text: string, key: string, voice: AlertVoice): string {
  const lead = SEVERITY_LEADS[severityOf(key, voice)];
  return lead === null ? text : `${lead}\n${text}`;
}

/**
 * The text a post was built from, with its lead taken off. A post that opens with no
 * lead is a page needing attention and is its own text; a lead with nothing under it
 * is no post, and null. For a reader of posted text (a test faking Slack) that
 * asserts what a condition SAYS.
 */
export function withoutSeverityLead(posted: string): string | null {
  const leads = Object.values(SEVERITY_LEADS).filter((l): l is string => l !== null);
  if (leads.includes(posted)) return null;
  const at = posted.indexOf("\n");
  return at >= 0 && leads.includes(posted.slice(0, at)) ? posted.slice(at + 1) : posted;
}
