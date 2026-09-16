import { DateTime } from "luxon";
import { formatClockTime, formatLongDate } from "@/lib/date/parse";

/**
 * What the sales side reads when a lead's call goes to the advisor who owns them
 * (#2372), as one pure builder.
 *
 * It replaces the Slack post at the end of the Pipedream owner reassign flow, which
 * sent the owner's email address, the start time in Eastern, and the lead's email
 * address. Two deliberate differences:
 *
 *  - it names people rather than addresses, because a channel of people reads names;
 *  - it gives the call time in the ADVISOR's own clock as well as Eastern. The roster
 *    spans seven zones, 27 in Phoenix and 16 in Los Angeles among them (#1739), so
 *    Eastern alone is the wrong time for a large part of it.
 *
 * It carries the lead's NAME and nothing else about them: no address, no number, and
 * never the manage token or a manage link. That token is the lead's own key to their
 * call and it can reschedule or cancel it (#1340); a channel is not the lead.
 *
 * It DOES link the admin booking page, which the advisor only calendar alert (#2371)
 * deliberately does not. The two have different readers: that alert is written for an
 * advisor, who is refused at `/admin/bookings/<id>` because `loadBookingDetail` answers
 * `forbidden` below manager (L651). This notice goes to the handoff channel, read by
 * the same sales managers the booking handoff notices are written for, and those
 * already link the same page. The one thing somebody may want to do on reading this,
 * put the call back if the move was wrong, lives there.
 *
 * Held as a builder, not inline at the send site, so `pnpm preview:alerts` renders the
 * words that actually ship rather than a second copy of them (L41).
 */

/** The zone the sales side works in. The same anchor the handoff notices use. */
const SALES_ZONE = "America/New_York";

export interface OwnerReassignNotice {
  /** The advisor now holding the call. */
  advisorName: string | null;
  /** Their address, used only when Slate holds no name for them. */
  advisorEmail: string | null;
  /**
   * The advisor's OWN zone, or null when Slate holds no working hours for them.
   * Never a default: `fetchAgentWorkingHours` answers `America/New_York` for an
   * agent with no schedule, and a notice built on that would state a fact about
   * somebody's location that nothing measured (L192).
   */
  advisorTimezone: string | null;
  /** The call's start, as an ISO instant. */
  startsAt: string;
  /** The lead's name, or null on a redacted booking. */
  leadName: string | null;
  /** The admin booking page for this call, absolute. */
  bookingUrl: string;
}

const nonEmpty = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null);

export function formatOwnerReassignNotice(input: OwnerReassignNotice): string {
  const lead = nonEmpty(input.leadName);
  const advisor = nonEmpty(input.advisorName) ?? nonEmpty(input.advisorEmail);
  const eastern = DateTime.fromISO(input.startsAt, { zone: SALES_ZONE });
  const day = formatLongDate(eastern);
  const time = formatClockTime(eastern);
  const when = day && time ? `${day} at ${time} Eastern` : null;
  // Whose clock the second time belongs to. The NAME, when there is one; "they" when
  // the sentence has just had to fall back to a thirty character address, which read
  // twice in one line is noise rather than clarity; and "the advisor" only when the
  // sentence never named them at all, where "they" would read as the lead.
  const name = nonEmpty(input.advisorName);
  const whereTheyAre = name ? `where ${name} is` : advisor ? "where they are" : "where the advisor is";
  const local = when === null ? null : advisorClock(input.startsAt, input.advisorTimezone, whereTheyAre);

  const whose = lead ? `${lead}'s call` : "A lead's call";
  const withWhom = advisor ? ` with ${advisor}` : "";
  // An unreadable start is SAID rather than guessed at, exactly as the handoff
  // notices say it: the rest of the notice is still worth having, and a reader sent
  // to the booking page finds the real time there.
  const at = when ? ` on ${when}` : " at a time Slate could not read";

  return [
    "A lead was routed to the advisor they have already spoken with.",
    `${whose} is${withWhom}${at}${local ? `, which is ${local}` : ""}.`,
    `See the booking: ${input.bookingUrl}`,
  ].join(" ");
}

/**
 * The same instant on the advisor's own clock, or null when saying it adds nothing.
 *
 * Null in three cases, and each is a case where a second time would be noise or a
 * claim nothing measured:
 *
 *  - Slate holds no zone for this advisor;
 *  - the zone is one Luxon cannot read, so no time could be computed from it;
 *  - it reads the same clock on the same day as Eastern. Nine of the pairs the
 *    cal.com sweep found are `America/Denver` against `America/Boise`, which differ
 *    on no hour of the year, and repeating an identical time twice in one sentence
 *    is the second statement of one fact (L605).
 *
 * The zone is never NAMED, and that is not squeamishness. Collapsing a zone's two
 * seasonal abbreviations is wrong for Arizona, which is MST every day and sits an
 * hour behind Denver from March to November (#2117), and the roster has 27 agents
 * there. "where <advisor> is" cannot be wrong in that way, and is what the reader
 * actually wants to know.
 */
function advisorClock(
  startsAt: string,
  zone: string | null,
  where: string,
): string | null {
  if (!zone) return null;
  const local = DateTime.fromISO(startsAt, { zone });
  if (!local.isValid) return null;
  const time = formatClockTime(local);
  const day = formatLongDate(local);
  if (!time || !day) return null;

  const eastern = DateTime.fromISO(startsAt, { zone: SALES_ZONE });
  const sameClock = time === formatClockTime(eastern) && day === formatLongDate(eastern);
  if (sameClock) return null;

  // A zone far enough east or west lands on another calendar day, and a bare
  // "11:30pm" would then be the wrong day as well as a different time.
  return day === formatLongDate(eastern) ? `${time} ${where}` : `${time} on ${day} ${where}`;
}
