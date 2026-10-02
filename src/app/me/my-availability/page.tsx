import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { setMyWorkingHours } from "@/app/admin/actions";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { cardCls, proseCls } from "@/components/ui/styles";
import { InfoIcon } from "@/components/icons";
import { WorkingHoursForm } from "@/components/ui/WorkingHoursForm";
import { workingHoursDays } from "@/lib/schedule-week";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { BookablePill } from "@/components/ui/BookablePill";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { ME_TABS } from "@/lib/me/nav";
import { CopyLinkField } from "@/components/ui/CopyLinkField";
import { loadAgentLinkName } from "@/lib/agent-link/store";
import { agentLinkUrl } from "@/lib/agent-link/link";
import { appUrl } from "@/lib/env";
import { log } from "@/lib/log";
import { hoursOriginNote } from "@/lib/admin/working-hours-copy";
import type { AvailabilitySchedule } from "@/lib/db/types";

export const dynamic = "force-dynamic";

/**
 * My Availability: the hours somebody can be booked in.
 *
 * TWO THINGS CHANGED HERE ON 2026-09-08, and they are separate.
 *
 * The page SPLIT. It used to carry time off as well, which pushed the working
 * hours card below a form most visits did not need. Time off is now
 * `/me/time-off`, and this is the landing page, because the hours are what
 * decide whether an agent gets calls at all.
 *
 * And it stopped being hidden. `AGENT_SCHEDULING_LIVE` gated this whole surface
 * behind `consoleHiddenFor`, so for 112 agents it did not exist: the form, the reset
 * controls and the bookable pill were all built, tested and unreachable. The
 * flag was written while the scheduling tool was unfinished and the reasoning
 * outlived the condition. It still hides the CONSOLE from managers and admins,
 * which is a live decision; it no longer decides whether a person may read their
 * own hours. Note the action it guarded never consulted it either
 * (`setMyWorkingHours` has always only required a signed-in user), so what the
 * flag hid was the form, never the write.
 */
export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{
    /** Set by the two hours actions on a successful write (#1988). */
    ok?: string;
    /** A refusal the person can act on, from the same actions (#1994). */
    error?: string;
  }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");

  // #1647: both reads bind `error`. They feed a surface that OFFERS A WRITE over
  // what it shows, so a dropped error draws exactly the screen a genuinely empty
  // answer draws, and the obvious correction is a write made from a reading that
  // never happened.
  const db = supabaseAdmin();
  const { data: schedule, error: schedErr } = await db
    .from("availability_schedules")
    .select("id, timezone, hours_source")
    .eq("user_id", me.id)
    .maybeSingle();
  const sched = schedErr
    ? null
    : (schedule as {
        id: string;
        timezone: string;
        hours_source: AvailabilitySchedule["hours_source"];
      } | null);

  const { data: rulesData, error: rulesErr } = sched
    ? await db
        // cap-safe: the signed in agent's own schedule rules, at most a few per weekday.
        .from("availability_rules")
        .select("weekday, start_minute, end_minute")
        .eq("schedule_id", sched.id)
    : { data: [], error: null };
  const rules = (rulesData ?? []) as {
    weekday: number;
    start_minute: number;
    end_minute: number;
  }[];
  // The worst empty result on this page (#1647). `workingHoursDays` ticks Monday
  // to Friday, 9 to 5, when NOTHING is stored, because that is the right start
  // for a new agent; an unreadable read reaches the same branch, so the form
  // draws a plausible week that is not this agent's, and `setMyWorkingHours`
  // REPLACES every rule for the schedule (the #1308 lossy-projection shape). One
  // save on a page nobody suspected and their real hours are gone. So the hours
  // section renders its own state instead, and offers nothing that writes.
  const hoursUnreadable = schedErr != null || rulesErr != null;
  // #1308: a window PER DAY, read back from each day's own rule rather than from
  // rules[0], which showed Monday's hours for the whole week and then overwrote
  // the rest on save.
  const hoursDays = workingHoursDays(rules);
  // #1757: said only when Slate RECORDED that somebody else wrote this week. An
  // agent opening self service finds hours they never set, and the one writer that
  // can be named from the record is the cal.com import.
  const originNote = rules.length > 0 ? hoursOriginNote(sched?.hours_source ?? null) : null;

  // #2073: the agent's own booking link, by its readable name since #3026. A failed
  // read is its own state, never "no link yet".
  let bookingLink: { kind: "link"; url: string } | { kind: "none" } | { kind: "unreadable" };
  try {
    const name = await loadAgentLinkName(me.id);
    bookingLink = name ? { kind: "link", url: agentLinkUrl(appUrl(), name) } : { kind: "none" };
  } catch (err) {
    log.error("agent-link", { msg: "could not read an agent's own booking link" }, err);
    bookingLink = { kind: "unreadable" };
  }

  const firstName = me.name?.trim().split(/\s+/)[0] ?? null;
  const timeOffHref = ME_TABS[1].href;

  return (
    <>
      {/* The pill is INSIDE the children rather than in the header's `aside`
          slot, and that is deliberate. Setting `aside` switches the component
          into its row layout, which renders the title `pn-h4` instead of
          `pn-h3`; this greeting and the identical one on /me/time-off would
          then be two sizes of the same heading on two sibling pages, which
          reads as two levels rather than one (L634). Caught by screenshotting
          it rather than by reading either file, since each is correct alone.

          The pill is on this page at all because of what it tells the reader
          (Dan, 2026-09-08): an agent who thinks they should be getting calls
          and is not can see why without asking anybody. `wording="self"` says
          "Not bookable yet", because the reader is the agent. */}
      <AdminPageHeader title={firstName ? `Hi, ${firstName}.` : "Hi there."}>
        {/* The steer matters more than the description. The failure it exists
            to prevent is an agent editing their weekly hours to take next
            Tuesday off and never putting them back, which silently narrows
            their availability for good. So the consequence is stated rather
            than implied: a change here applies to every week. */}
        <p>
          These are your regular weekly hours, and a change here applies to
          every week. For a single day or a vacation,{" "}
          <Link
            href={timeOffHref}
            className="font-semibold text-pennie-blue underline dark:text-pennie-sky"
          >
            request time off
          </Link>{" "}
          instead.
        </p>
        <p className="mt-3">
          <BookablePill bookable={me.bookable} wording="self" />
        </p>
      </AdminPageHeader>

      {/* #2103: the warning stays, its button does not. The button applied the
          company default week, and a new agent never needed it: `runRosterSync`
          calls `ensureDefaultSchedules` in the same run that inserts them, so
          their week is seeded before they can open this page. It was a manual
          route to something that had already happened, and it taught an agent
          about a company default they have no other reason to know exists (Dan,
          2026-09-08).

          The sentence is not left as a notice with no remedy (L109): the form
          directly below it is the remedy, and it is the one an agent should be
          using. */}
      {!hoursUnreadable && rules.length === 0 && (
        <div className="flex items-center gap-2.5 rounded-md bg-pennie-sky-soft p-4 text-sm text-fg dark:bg-accent/15">
          <InfoIcon
            width={20}
            height={20}
            className="shrink-0 text-pennie-blue dark:text-pennie-sky"
          />
          You have no working hours set, so you won&apos;t get bookings.
        </div>
      )}

      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Working hours</h2>
        {hoursUnreadable ? (
          /* #1647: the form and BOTH reset controls are withheld, not
             disabled with a warning beside them. Every one of them
             replaces the whole week, so any of them pressed here writes a
             guess over hours nobody has read. The notice says which way
             round it is, because the empty version of this card reads as
             "you have no hours" and that is the frightening direction. */
          <UnreadableNotice className="mt-3">
            Your working hours could not be read just now, so they are not
            shown and cannot be changed from here. Your saved hours are
            unaffected. Reload to try again.
          </UnreadableNotice>
        ) : (
          <>
            <p className={`mb-4 text-xs text-fg-muted ${proseCls}`}>
              Set your home timezone and weekly hours. Leads always see times
              in their own timezone.
            </p>
            {originNote ? (
              <p className={`mb-4 text-sm text-fg ${proseCls}`}>{originNote}</p>
            ) : null}
            {/* #1988: pressing Save wrote the week and then said
                nothing, so it looked exactly like a click that did
                nothing. The sentence is built from the week this render
                just READ, not from what the action meant to write, so it
                reports what is actually stored (L78). */}
            {savedOutcome(sp.ok) === "working-hours" ? (
              <div className="mb-4">
                <SettingsSaveNotice ok saved={savedSentence("working-hours") ?? ""} />
              </div>
            ) : null}
            {/* #1994: a week the server refused says WHY. These sentences
                name the day and what is wrong with it, and until now none
                of them could be read: a thrown error is redacted in
                production and arrived as the generic error boundary. */}
            {sp.error ? (
              <div className="mb-4">
                <SettingsSaveNotice ok={false} error={sp.error} saved="" />
              </div>
            ) : null}
            <WorkingHoursForm
              action={setMyWorkingHours}
              days={hoursDays}
              timezone={sched?.timezone ?? "America/New_York"}
              timezoneLabel="Your timezone"
            />
          </>
        )}
      </section>

      {/* #2073: the link an agent sends a lead for a later call with them. It
          books this person directly, with no routing, so it replaces the
          personal cal.com link cutover removes. */}
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Your booking link</h2>
        {bookingLink.kind === "unreadable" ? (
          <UnreadableNotice className="mt-3">
            Your booking link could not be read just now. The link itself still
            works. Reload to try again.
          </UnreadableNotice>
        ) : bookingLink.kind === "none" ? (
          <p className={`text-sm text-fg-muted ${proseCls}`}>
            You do not have a booking link yet.
          </p>
        ) : (
          <>
            <p className={`mb-4 text-xs text-fg-muted ${proseCls}`}>
              Send this to a lead for a later call with you. It books you
              directly, in your working hours, and skips routing.
            </p>
            <CopyLinkField label="Booking link" url={bookingLink.url} labelHidden />
          </>
        )}
      </section>
    </>
  );
}
