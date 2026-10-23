import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { SaveForm } from "@/components/ui/SaveForm";
import { currentUser } from "@/lib/auth";
import {
  canManageAgents,
  canManageUser,
  canEditOrgSettings,
  canSetRole,
  roleLabel,
  ROLES,
} from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isActive } from "@/lib/active-user";
import { appUrl, consoleHiddenFor } from "@/lib/env";
import {
  setUserRole,
  setBookable,
  clearPendingBookableFlip,
  setOooCalendarId,
  setWorkingHours,
  useDefaultHours,
  setUserLifecycle,
  refreshAdvisorPhotoFor,
  relinkGoogleAccount,
} from "@/app/admin/actions";
import { DestructiveConfirm } from "@/components/ui/DestructiveConfirm";
import { GOOGLE_RELINK_COPY } from "@/lib/auth/google-identity-copy";
import { CopyLinkField } from "@/components/ui/CopyLinkField";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { loadAgentLinkName } from "@/lib/agent-link/store";
import { agentLinkUrl } from "@/lib/agent-link/link";
import BulkReassignCoverage from "@/components/BulkReassignCoverage";
import { StrandedCallsCard, type StrandedCallsState } from "@/components/admin/StrandedCallsCard";
import { loadAgentStrandedCalls } from "@/lib/booking/agent-stranded-calls";
import { backendServiceOf, teamsOf } from "@/lib/admin/agent-display";
import { debtTeamCoverage, debtTeamValueText } from "@/lib/admin/debt-team";
import PoolExitConfirmButton from "@/components/PoolExitConfirmButton";
import { previewBulkReassign } from "@/lib/booking/service";
import { log } from "@/lib/log";
import { unwrap } from "@/lib/db/result";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { WorkingHoursForm } from "@/components/ui/WorkingHoursForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { AdvisorAvatar } from "@/components/ui/AdvisorAvatar";
import { loadPhotoRecords } from "@/lib/advisor-photos/store";
import { photoSrc, resolveAdvisorPhoto, type PhotoRecord } from "@/lib/advisor-photos/resolve";
import { agentPhotoStateText, photoOutcomeFromParams, photoOutcomeText } from "@/lib/advisor-photos/copy";
import { orgDefaultWeek, workingHoursDays } from "@/lib/schedule-week";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import {
  deactivateExplanation,
  notBookableContrast,
  reactivateExplanation,
} from "@/lib/offboarding/account-status-copy";
import {
  btnSecondaryCls,
  cardCls,
  inputCls,
  labelCls,
  proseCls,
} from "@/components/ui/styles";
import { Pill } from "@/components/ui/Pill";
import { ViewAsButton } from "@/components/admin/ViewAsButton";
import type { Organization, User } from "@/lib/db/types";
import { BookablePill } from "@/components/ui/BookablePill";
import { heldByTwilio as isHeldByTwilio } from "@/lib/bookable/bookable-state";
import { CLEAR_PENDING_FLIP_LABEL, pendingFlipSentence } from "@/lib/bookable/pending-flip-copy";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { SelectField } from "@/components/ui/SelectField";

export const metadata = { title: "Agent" };

export const dynamic = "force-dynamic";

/**
 * How many active future appointments this agent still holds (#1215), or null
 * when the count could not be read.
 *
 * Null, never 0, on a read error. Zero is what the UI uses to skip the confirm
 * entirely, so turning a failed read into 0 would wave the admin through with an
 * implied "nothing is booked" that nothing measured, the same defect as an
 * all-clear off a query that never ran (#1134). The profile page still renders:
 * an unreadable count degrades to a confirm that says so, not to a blank page.
 */
async function upcomingBookingCount(agentId: string): Promise<number | null> {
  try {
    return await previewBulkReassign(agentId, new Date().toISOString(), null);
  } catch (err) {
    log.error("admin-agent", { msg: "upcoming booking count failed", user_id: agentId }, err);
    return null;
  }
}

/**
 * The calls the last coverage sweep could not place that are still with this agent
 * (#3595), by the predicate the coverage needs human alert pages on.
 *
 * A failed read is its own state and never an empty list, which would say nothing is
 * waiting when nothing was measured (L10). The profile page still renders around it.
 */
async function readStrandedCalls(agentId: string): Promise<StrandedCallsState> {
  try {
    return { kind: "read", ...(await loadAgentStrandedCalls(agentId, Date.now())) };
  } catch (err) {
    log.error("admin-agent", { msg: "stranded calls unreadable", user_id: agentId }, err);
    return { kind: "unreadable" };
  }
}

/** Links the refused Make bookable to the sentence saying why (#3028). */
const REDISTRIBUTE_HOLD_ID = "bookable-redistribute-hold";

/** Links the stop button to the sentence saying what it stops (#2078). */
const PENDING_FLIP_ID = "bookable-pending-flip";

/**
 * One stored routing attribute as a reader sees it (#1874).
 *
 * An absent value is NAMED rather than rendered blank. These were text inputs,
 * where empty reads as an empty box; as text, a blank line beside a label reads
 * as the page having failed to load something.
 *
 * #2120: it takes an already-resolved label now, rather than a raw
 * `Attributes[string]`. Two of its three callers went (the debt teams draw the
 * ladder, the Salesforce profile is off the panel), and the one that remains
 * hands it a value that has already been read out of whichever shape it was
 * stored in and matched against its vocabulary. The array, number and boolean
 * branches had no caller left, so they are gone rather than kept as a shape
 * nothing produces (L29).
 */
function attrValue(label: string | null): React.ReactNode {
  if (!label) return <span className="text-[color:var(--pn-muted)]">Not set</span>;
  return label;
}

// nav-ok: a row in the roster opens this, so no navigation entry can name it: the address contains the agent's id
export default async function AgentProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /**
   * `job` opens the coverage panel on an existing sweep (#1239), which is how the
   * time off queue links to the sweep an approval enqueued.
   *
   * `bookable` is what the pool toggle came back saying (#1769). A CODE rather
   * than a sentence, so the wording lives here where the copy rules and the
   * preview can see it, and nothing an admin types can reach the banner.
   */
  searchParams?: Promise<{
    job?: string;
    bookable?: string;
    /** Set by the two hours actions on a successful write (#1988). */
    ok?: string;
    /** A refusal the person can act on, from the same actions (#1994). */
    error?: string;
    /** What "Refresh photo from Google" came back with (#3027): a code. */
    photo?: string;
    pn?: string;
  }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const openJobId = query?.job;
  const bookableOutcome = query?.bookable;
  const me = await currentUser();
  if (!me) redirect("/login");
  // OOO-only launch: agent management is part of the booking tool; managers are
  // limited to the OOO surfaces until scheduling goes live. Admins keep it.
  if (consoleHiddenFor(me.role)) {
    redirect("/admin/ooo");
  }
  if (!canManageAgents(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need a manager or admin account to manage agents.
      </main>
    );
  }
  const isAdmin = canEditOrgSettings(me.role);
  const db = supabaseAdmin();
  // Roles this actor may assign to this target. A regular admin can't grant or
  // revoke super_admin (so the option is hidden and the form disappears for a
  // super_admin target).
  const roleOptions = (target: User["role"]) =>
    ROLES.filter((r) => canSetRole(me.role, target, r));

  // #1629: a swallowed error made this null, and null here means notFound(): the
  // page told an admin the agent does not exist when the read simply failed.
  // `unwrap` throws instead, so a real 404 still means a real 404.
  const agentData = unwrap(
    await db.from("users").select("*").eq("id", id).eq("org_id", me.org_id).maybeSingle(),
    "agent detail row",
  );
  const agent = agentData as User | null;
  if (!agent) notFound();
  const active = isActive(agent);
  const isSelf = agent.id === me.id;
  // Control visibility must match what the mutating actions permit (#550/#544).
  // requireManageAgent enforces the strict-outrank rule (canManageUser), so a
  // manager viewing a peer or higher-ranked user (or an admin viewing a
  // super_admin) would otherwise see manager+ controls that 403 on click. Gate
  // those controls on the SAME predicate. Admin-only controls (role, OOO calendar)
  // keep their own isAdmin gates, which are already correct.
  const canManageThisAgent = canManageUser(me.role, agent.role, isSelf);
  // #3028: a flip into the pool the hourly Twilio sync would undo. Only asked of
  // somebody out of the pool: taking an advisor out is never held back.
  const heldByTwilio = isHeldByTwilio(agent);
  // #2078: the stamp of a flip the sync is still waiting to make, only while they
  // are out of the pool (any bookable write clears it, so bookable and pending
  // together is a state nothing should leave behind).
  const pendingFlip = !agent.bookable && agent.bookable_pending_since ? agent.bookable_pending_since : null;

  // #2120: the agent's debt coverage, read once, from the two functions the
  // roster's ladder also composes from. `teamsOf` reads whichever shape the sync
  // stored (an array on most agents, a bare string on a few) and
  // `debtTeamCoverage` splits it into rungs and everything else, dropping a blank
  // on the way, so the panel can never print an empty string for an agent whose
  // stored value is `[""]`.
  const debtCoverage = debtTeamCoverage(teamsOf(agent));
  // #1878: whether the role is shown as a CONTROL or as read only text. ONE
  // predicate with both branches hanging off it, so the role cannot end up named
  // nowhere the way it would if each branch tested its own condition.
  const canSetThisRole = isAdmin && roleOptions(agent.role).length > 0;

  // #1215: how many upcoming appointments this agent still holds, read ONCE and
  // shared by both pool-exit controls (deactivate and the bookable toggle). Two
  // reads of the same question could disagree with each other on the same page.
  // Only needed when the controls actually render.
  const heldUpcoming = canManageThisAgent ? await upcomingBookingCount(agent.id) : null;

  // #3595: the calls the last coverage sweep could not place that are still with
  // this agent. Read for whoever may manage this agent, the same gate as the Move
  // panel these calls came from, since placing one by hand is a reassign.
  const strandedCalls = canManageThisAgent ? await readStrandedCalls(agent.id) : null;

  // #2073: the agent's own booking link, for admins only, by its readable name
  // since #3026. A failed read is its own state, never drawn as "no link yet".
  let bookingLink: { kind: "link"; url: string } | { kind: "none" } | { kind: "unreadable" } = {
    kind: "none",
  };
  if (isAdmin) {
    try {
      const name = await loadAgentLinkName(agent.id);
      bookingLink = name ? { kind: "link", url: agentLinkUrl(appUrl(), name) } : { kind: "none" };
    } catch (err) {
      log.error("agent-link", { msg: "could not read an agent's booking link", user_id: agent.id }, err);
      bookingLink = { kind: "unreadable" };
    }
  }

  const [schedRes, usersRes, orgRes] = await Promise.all([
    db
      .from("availability_schedules")
      .select("id, timezone, updated_at")
      .eq("user_id", agent.id)
      .maybeSingle(),
    // Hide the synthetic smoke-test agent (#396) from the manager picker.
    db.from("users").select("id, name, email, role, deactivated_at").eq("org_id", me.org_id).eq("is_test", false),
    db.from("organizations").select("*").eq("id", me.org_id).single(),
  ]);
  // #1629: all three, and the rules read below, feed FORMS whose save replaces
  // what they show. An unreadable schedule renders as "this agent has no hours"
  // and saving that writes an empty week (the #1308 lossy-projection shape); an
  // unreadable roster renders the manager of record as unassigned. None of these
  // may be guessed, so each throws rather than drawing a blank the admin acts on.
  const sched = unwrap(schedRes, "agent schedule") as {
    id: string;
    timezone: string;
    updated_at: string;
  } | null;
  const rulesData = sched
    ? unwrap(
        await db
          // cap-safe: one agent's schedule rules, at most a few per weekday.
          .from("availability_rules")
          .select("weekday, start_minute, end_minute")
          .eq("schedule_id", sched.id),
        "agent schedule rules",
      )
    : [];
  const rules = (rulesData ?? []) as {
    weekday: number;
    start_minute: number;
    end_minute: number;
  }[];
  // #1308: a window PER DAY, read back from each day's own rule rather than from
  // rules[0], which showed Monday's hours for the whole week and then overwrote
  // the rest on save.

  const allUsers = (unwrap(usersRes, "agent detail roster") ?? []) as Pick<
    User,
    "id" | "name" | "email" | "role" | "deactivated_at"
  >[];
  // The manager of record is DISPLAYED, not chosen (#1474): Salesforce owns the
  // link and the hourly sync converges on it, so there is no picker to build a
  // candidate list for. Resolved from the full user set, including deactivated
  // ones, so an existing assignment still shows who it points at.
  const assignedManager = agent.manager_id
    ? allUsers.find((u) => u.id === agent.manager_id)
    : null;
  const org = unwrap(orgRes, "agent detail org") as Organization;

  const initials = (agent.name ?? agent.email).slice(0, 2).toUpperCase();
  // #3027: through the one resolver. A failed read is its own state, said in a
  // line under the name, never drawn as "Google holds no photo".
  let photoRecords: Map<string, PhotoRecord> | null = null;
  try {
    photoRecords = await loadPhotoRecords([agent.id]);
  } catch (err) {
    log.error("agent-detail", { msg: "advisor photo unreadable" }, err);
  }
  const photo = resolveAdvisorPhoto(agent, photoRecords);
  const photoLine = agentPhotoStateText(photo, agent);
  // #3027: a code looked up in copy.ts, never words from the address.
  const photoRun = photoOutcomeFromParams(query ?? {}, "photo");
  const photoNoticeFromRun = photoRun ? photoOutcomeText(photoRun) : null;

  return (
    <>
      <>
        <Link
          href="/admin/agents"
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
        >
          &larr; All agents
        </Link>

        <BookableOutcome code={bookableOutcome} />

        {/* #2385: every refusal this page's forms can speak, in one place. The
            role select, the deactivate button and the working hours week each
            computed a sentence and THREW it, which production replaces with the
            generic error boundary, so "Cannot remove the last admin" and "You
            cannot deactivate your own account" had never been drawn for anybody.
            #1994 wrote the channel for the hours form; these three now use it. */}
        {query?.error ? (
          <SettingsSaveNotice ok={false} error={query.error} saved="" />
        ) : null}
        {/* #3100: the time off calendar save redirects here with its own outcome,
            and nothing drew it, so the save wrote the calendar and said nothing.
            The working hours outcome keeps its place inside its own card. */}
        {!query?.error && savedOutcome(query?.ok) === "agent-ooo-calendar" ? (
          <SettingsSaveNotice ok saved={savedSentence("agent-ooo-calendar") ?? ""} />
        ) : null}
        {/* #3526: the relink control sits inside the closed section at the bottom,
            and a redirect lands the reader at the top, so its outcome is drawn
            here beside the page's other outcomes. */}
        {!query?.error && savedOutcome(query?.ok) === "agent-google-relinked" ? (
          <SettingsSaveNotice ok saved={savedSentence("agent-google-relinked") ?? ""} />
        ) : null}

        {/* Identity band */}
        <AdminPageHeader
          title={agent.name ?? agent.email}
          leading={
            <AdvisorAvatar
              src={photoSrc(photo)}
              initials={initials}
              imgClassName="h-12 w-12 rounded-full object-cover"
              fallbackClassName="flex h-12 w-12 items-center justify-center rounded-full bg-pennie-sky text-sm font-semibold text-pennie-graphite"
            />
          }
          aside={
            <>
              {/* #1838: the band this sat in is an ordinary card now, so these
                  pills take the page theme like every other pill. The `onDark`
                  they used to pass would INVERT them here.

                  #1878 removed the role pill that stood here. The Bookable pill
                  below carries its own justification: "nothing else on this page
                  names the fact". The role failed that same test, because the
                  Access card names it in a control that both shows it and
                  changes it, so the pill was the redundant half. The roster still
                  has its own role pill (#1844) and that is untouched: there the
                  column is the only thing naming a row's role. */}
              {!active && <Pill variant="outline">Deactivated</Pill>}
              {/* #1823: the same component the roster uses, so the variant and
                  the mark are one decision and the two screens cannot drift.
                  Nothing else on this page names the fact, so it carries the
                  noun rather than Yes or No. #3030: it reads Redistribute
                  from the same `heldByTwilio` the refused toggle below uses, so
                  the pill and the control cannot disagree about who is held. */}
              <BookablePill bookable={agent.bookable} heldByTwilio={heldByTwilio} wording="full" />
            </>
          }
          action={
            /* #1749: this page had no view-as action at all, so an admin looking
               at a specific person still had to copy their address to a field
               elsewhere. It renders only where it could actually work, and the
               whole banner and two hour expiry behind it are unchanged.

               #1878 moved it into the header, where the person it acts on is
               named, rather than leaving it loose between two cards, where it
               read as belonging to the card beneath it. It is in `action` rather
               than beside the pills so it stays visibly a control, and so its
               absence (an admin cannot view as another admin) moves nothing. */
            <ViewAsButton
              actorRole={me.role}
              actorId={me.id}
              target={agent}
              className={btnSecondaryCls}
            />
          }
        >
          <p className="truncate text-sm">{agent.email}</p>
          {photoLine && <p className="mt-1 text-xs text-fg-muted">{photoLine}</p>}
          {/* #3027: so a photo fixed in Google shows the same minute. Admins only,
              matching the server side check in the action. */}
          {isAdmin && active && (
            <SaveForm action={refreshAdvisorPhotoFor} name="advisor-photo-refresh" unsaved="nothing typed here" className="mt-2">
              <input type="hidden" name="user_id" value={agent.id} />
              <SubmitButton className={`${btnSecondaryCls} min-h-11 disabled:opacity-80`} pendingLabel="Reading their photo from Google">
                Refresh photo from Google
              </SubmitButton>
            </SaveForm>
          )}
        </AdminPageHeader>
        {photoNoticeFromRun && (
          <div
            role={photoNoticeFromRun.ok ? undefined : "alert"}
            className={
              photoNoticeFromRun.ok
                ? "rounded-md bg-[var(--pennie-green-wash)] px-5 py-4 text-sm text-pennie-graphite"
                : "rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
            }
          >
            {photoNoticeFromRun.text}
          </div>
        )}

        {/* #3595: calls nobody owns are the most urgent thing on this page, so they
            sit straight under the agent's own card (Dan's design round, 2026-10-21),
            outside the closed section below, which by design hides no signal. No
            card at all when nothing waits. */}
        {strandedCalls && <StrandedCallsCard state={strandedCalls} agentName={agent.name ?? agent.email} />}

        {/* Access: role + bookable + manager */}
        <section className={cardCls}>
          <p className="pn-eyebrow text-fg-muted">Access</p>
          {!canManageThisAgent && (
            <p className="mt-2 text-xs text-fg-muted">
              You can view {agent.name ?? agent.email} but cannot change their
              settings: managing an agent needs a role above theirs.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-4">
            {/* #1878: the role is named exactly ONCE on this page, and this is
                where. The header pill is gone, so this control is the only thing
                that says it, which means it has to render for a reader who cannot
                CHANGE it too: a manager sees no assignment control at all, and an
                admin looking at a super admin has no assignable role (#550), so
                deleting the pill without this branch would leave the role named
                nowhere. Read only text rather than a pill kept for everybody.

                `roleLabel` for the option labels rather than a second rule about
                underscores, so "team lead" cannot be spelled two ways on one
                page (L41). */}
            {canSetThisRole ? (
              <SaveForm action={setUserRole} name="agent-role" unsaved="this role change" className="flex items-end gap-2">
                <input type="hidden" name="user_id" value={agent.id} />
                <div>
                  <label className={labelCls} htmlFor="agent-role">
                    Role
                  </label>
                  <SelectField
                    id="agent-role"
                    name="role"
                    defaultValue={agent.role}
                    className="w-40"
                    options={roleOptions(agent.role).map((r) => ({
                      value: r,
                      label: roleLabel(r),
                    }))}
                  />
                </div>
                <SubmitButton className={btnSecondaryCls} pendingLabel="Setting role">Set role</SubmitButton>
              </SaveForm>
            ) : (
              <div>
                <span className={labelCls}>Role</span>
                <p className="text-sm">{roleLabel(agent.role)}</p>
              </div>
            )}
            {canManageThisAgent && (
              <SaveForm action={setBookable} name="agent-bookable" unsaved="this bookable change" className="flex items-end">
                <input type="hidden" name="user_id" value={agent.id} />
                <input
                  type="hidden"
                  name="bookable"
                  value={agent.bookable ? "false" : "true"}
                />
                {/* #1215: taking an agent out of the pool via this toggle
                    strands their booked appointments exactly as deactivating
                    does, so the person who flips it is asked the same question.
                    The other direction strands nothing, so it stays one click. */}
                {agent.bookable ? (
                  <PoolExitConfirmButton
                    action="not_bookable"
                    agentId={agent.id}
                    agentName={agent.name ?? agent.email}
                    upcomingBookings={heldUpcoming}
                  />
                ) : (
                  <SubmitButton
                    className={btnSecondaryCls}
                    pendingLabel="Making bookable"
                    refused={heldByTwilio}
                    describedBy={heldByTwilio ? REDISTRIBUTE_HOLD_ID : undefined}
                  >
                    Make bookable
                  </SubmitButton>
                )}
              </SaveForm>
            )}
            {/* #3028, reversing #2097's choice to leave the toggle usable. The
                hourly Twilio sync turns off every bookable advisor whose worker
                carries Redistribute, so a flip in here was undone within the hour,
                and admins pressed it twice for one person before anybody worked out
                why. So the flip is refused (the action refuses it too, through the
                same predicate) and this says why, naming the place the fix is made
                rather than the mechanism that enforces it (L399). Shown to every
                reader, since it is also the reason they are out of the pool, and
                read as the disabled button's description. */}
            {heldByTwilio && (
              <p id={REDISTRIBUTE_HOLD_ID} className={`basis-full text-xs text-fg-muted ${proseCls}`}>
                Twilio has this advisor on Redistribute, so the hourly sync turns them
                off again; remove the tag in Twilio to make them bookable.
              </p>
            )}
            {/* #2078: a flip the roster sync planned and the activation gate
                refused. It retries hourly and re-alerts until something settles
                it, and the toggle above cannot (not bookable on somebody already
                not bookable is a noop), so the wait is named here with the one
                control that ends it without making them bookable. Admins only,
                matching the action's own check. */}
            {pendingFlip && (
              <div className="basis-full">
                <p id={PENDING_FLIP_ID} className={`text-xs text-fg-muted ${proseCls}`}>
                  {pendingFlipSentence(pendingFlip)}
                </p>
                {isAdmin && canManageThisAgent && (
                  <SaveForm
                    action={clearPendingBookableFlip}
                    name="agent-pending-flip"
                    unsaved="nothing typed here"
                    className="mt-2"
                  >
                    <input type="hidden" name="user_id" value={agent.id} />
                    <SubmitButton
                      className={`${btnSecondaryCls} min-h-11`}
                      pendingLabel="Stopping"
                      describedBy={PENDING_FLIP_ID}
                    >
                      {CLEAR_PENDING_FLIP_LABEL}
                    </SubmitButton>
                  </SaveForm>
                )}
              </div>
            )}
            {/* Read only on purpose (#1474). Salesforce owns this link: the hourly
                roster sync converges on Agent_Manager__c, clearing a link
                Salesforce no longer backs, so anything set here would be undone
                within the hour. An editable control that silently reverts is worse
                than none, so the value is shown and nothing offers to change it.

                #1877 removed the two qualifiers this field used to carry: the
                "(time off approvals)" in the label and the "Set in Salesforce
                (Agent Manager), and synced hourly." line beneath the name. So the
                field no longer says where to change it, deliberately: the whole
                roster is synced from Salesforce and the panel that carries a hand
                editable copy of Salesforce data (routing attributes) says so once
                for itself. Do not re-add an explanation here per field. */}
            {canManageThisAgent && (
              <div>
                <span className={labelCls}>Manager</span>
                <p className="text-sm">
                  {assignedManager ? (
                    assignedManager.name ?? assignedManager.email
                  ) : (
                    <span className="text-[color:var(--pn-muted)]">No manager</span>
                  )}
                </p>
              </div>
            )}
          </div>
          {isAdmin && agent.role !== "agent" && (
            <SaveForm
              name="agent-ooo-calendar" unsaved="changes to this calendar"
              action={setOooCalendarId}
              /* Not a row of two columns aligned on their bottom edges: adding
                 the hint below the box made the column taller and pushed the Save
                 button out of line with the thing it saves (L549). The box and the
                 button are one row, and the hint sits under both. */
              className="mt-4"
            >
              <input type="hidden" name="user_id" value={agent.id} />
              <div>
                {/* #2161. Dan, looking at this page: "what the hell is this
                    image?" of the graphic, and then of this box, "what is this
                    for?". It said "OOO calendar ID" over a Google calendar id,
                    which tells a reader what to TYPE and nothing about what it
                    does. The name and the hint now carry the domain instead: whose
                    calendar it is, what lands on it, and that blank is a real
                    choice rather than an unfinished one (L604). */}
                <label htmlFor="ooo-calendar-id" className={labelCls}>
                  Team time off calendar
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="ooo-calendar-id"
                    name="ooo_calendar_id"
                    aria-describedby="ooo-calendar-id-hint"
                    defaultValue={agent.ooo_calendar_id ?? ""}
                    placeholder="c_xxxx@group.calendar.google.com"
                    /* max-w, not w-80: `inputCls` already carries `w-full`, and
                       two width utilities on one element are decided by the order
                       Tailwind emits them rather than the order they are written,
                       so the fixed width silently lost the moment this stopped
                       being a content sized flex item. A max width is a different
                       property and cannot be overruled by it. */
                    className={`${inputCls} max-w-80`}
                  />
                  <SubmitButton className={btnSecondaryCls} pendingLabel="Saving calendar">
                    Save calendar
                  </SubmitButton>
                </div>
                <p id="ooo-calendar-id-hint" className="mt-1.5 max-w-lg text-xs text-fg-muted">
                  Approved time off for the people who report to {agent.name ?? agent.email}{" "}
                  is added to this Google calendar. Blank sends it to the shared
                  Pennie time off calendar instead.
                </p>
              </div>
            </SaveForm>
          )}
        </section>

        {/* #2073: the agent's own booking link, which books them directly with no
            routing. Since #3026 it is their readable name and cannot be replaced:
            a link that is being abused is stopped by making the agent not
            bookable. */}
        {isAdmin && (
          <section className={cardCls}>
            <p className="pn-eyebrow text-fg-muted">Booking link</p>
            {bookingLink.kind === "unreadable" ? (
              <UnreadableNotice className="mt-3">
                This booking link could not be read just now, so it is not shown. The
                link itself still works. Reload to try again.
              </UnreadableNotice>
            ) : (
              <div className="mt-3">
                {bookingLink.kind === "link" ? (
                  <CopyLinkField label="Booking link" url={bookingLink.url} labelHidden />
                ) : (
                  <p className={`text-sm text-fg-muted ${proseCls}`}>
                    {agent.name ?? agent.email} has no booking link yet.
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {/* Working hours */}
        <section className={cardCls}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="pn-eyebrow text-fg-muted">Working hours</p>
            {!agent.bookable && (
              <span className="text-xs text-fg-muted">
                Not bookable, so these don&apos;t affect availability yet.
              </span>
            )}
          </div>
          {canManageThisAgent ? (
            <>
              {/* #1873: "Apply company default hours" is INSIDE this form now,
                  submitted to its own action, rather than a second form below it.
                  It has to be, because it discards whatever is unsaved here and
                  only this form knows whether anything is. `orgDefaultWeek` is
                  the week that action writes, so the confirm names it rather than
                  asking a generic question. */}
              {/* #1988: the save wrote the week and said nothing, so it read
                  as a click that did nothing. Built from the week this render
                  just READ rather than from what the action meant to write, so
                  a save that partly landed says what really landed (L78). */}
              {/* #2385: the refusal notice moved OUT of this card and up beside
                  the page's other outcome, because four cards on this page can
                  now refuse (the role select, the pool toggle, the two lifecycle
                  buttons and this week) and they cannot each own a copy of the
                  one `?error=` channel: whichever card drew it would be speaking
                  for the other three. A redirect lands the reader at the top of
                  the page, which is where the notice now is. */}
              {savedOutcome(query?.ok) === "working-hours" ? (
                <div className="mt-4">
                  <SettingsSaveNotice ok saved={savedSentence("working-hours") ?? ""} />
                </div>
              ) : null}
              <div className="mt-4">
                <WorkingHoursForm
                  action={setWorkingHours}
                  days={workingHoursDays(rules, org.default_weekdays)}
                  timezone={sched?.timezone ?? org.default_timezone}
                  timezoneLabel="Timezone (agent home tz)"
                  userId={agent.id}
                  saveLabel="Save hours"
                  defaultsAction={useDefaultHours}
                  companyDefaultDays={orgDefaultWeek(org)}
                  loadedUpdatedAt={sched?.updated_at ?? null}
                />
              </div>
            </>
          ) : (
            <p className="mt-4 text-xs text-fg-muted">
              Only someone who outranks this agent can change their hours.
            </p>
          )}
        </section>

        {/* #2145: the rare, the dangerous and the irreversible, behind one
            disclosure, closed on every visit.

            Dan, 2026-09-09: "let's put all of this into a collapsed section. It's
            not typically something people will be looking at and I want deactivate
            account hard to reach especially."

            This does not argue with the rule that a page's purpose is always open
            (L610), which is about hiding the content the reader came for. Nobody
            opens an agent's page to deactivate them: they come for hours,
            bookability and calendar health, all of which stay open above. These
            three are exactly the material the ordering rule puts last (L609), and a
            disclosure is the next step past last.

            NOT REMEMBERED per viewer, deliberately. A remembered open state would
            leave the destructive control one click away for whoever last used it,
            which is the opposite of what it is for.

            IT HIDES NO SIGNAL. The one status a reader needs at a glance from in
            here is that this person has left, and that is already a pill beside
            their name at the top of the page.

            A native details and summary, so the keyboard and the screen reader
            contract comes for free rather than being owed (L568).

            `open` when the page is addressed with a job, because the time off queue
            deep links to the sweep an approval enqueued (#1239) and a disclosure
            closed over the target would make that link land on nothing. */}
        <details className="group" open={Boolean(openJobId)}>
          <summary className={`${cardCls} cursor-pointer list-none`}>
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-fg">
                {/* The OPERATIONS, not the panels (L604). A reader deciding
                    whether to open this needs to know what they could do in
                    there, not what the sections inside are called. */}
                Move their bookings, close their account, and what they route for
              </span>
              <span aria-hidden="true" className="text-fg-muted transition-transform group-open:rotate-180">
                &#9662;
              </span>
            </span>
          </summary>
          <div className="mt-4 space-y-4">
        {/* Routing attributes */}
        <section className={cardCls}>
          <p className="pn-eyebrow text-fg-muted">Routing attributes</p>
          {/* #1874: `debt_team` and `backend_service` are READ ONLY, and that was
              the whole of that change. They were free text boxes, and routing
              MATCHES on both: a typo produces no error, it produces an agent who
              silently belongs to no bucket, and the only symptom is a pool one
              person shorter than expected.

              A picker would have made the value unrepresentable, and it would
              still have been an override that silently reverted: the hourly
              roster sync deletes and rewrites them. An editable control that is
              undone within the hour is worse than none, which is the call #1474
              already made for the manager field. Dan chose read only on
              2026-09-04.

              #2152 changed WHICH sync rewrites them, not whether one does: they
              came from Salesforce checkboxes and come from the agent's Twilio
              TaskRouter tags now, which is what feeds cal.com. So the reason this
              is read only is unchanged and the place to correct a wrong value
              moved: it is the Twilio worker's `teams` tags.

              #2120: THREE THINGS WENT, and each was the panel doing something the
              reader did not ask for.

              The paragraph that stood here explained the INTERFACE, not the
              domain: "What this agent can be routed for. The first three come
              from Salesforce and are rewritten by the hourly roster sync, so
              they are shown here rather than edited". That says what the panel
              is and which system owns it, which is a sentence written for
              whoever built it (L604). The read only-ness is already carried by
              there being no control to type in, and the reason it is read only
              is this comment, which is where a maintainer meets it.

              `Salesforce profile` rendered `attributes.role`, and NOTHING routes
              on it: every bucket keys on debt_team and backend_service. A field
              nothing routes on, under a heading about
              routing, is a fact the reader has to work out is irrelevant. Its
              only other reader is the audit trail, which records it as
              `details.profile` when Salesforce makes somebody bookable
              (`salesforce/sync.ts`), so taking it off the screen leaves the data
              and the record of who was made bookable untouched.

              And the debt teams printed the stored keys, `very_high, high,
              medium`, which is the machine spelling of a vocabulary `DEBT_TIER`
              has paired with labels all along. They read as FULL WORDS here (Dan,
              2026-09-09: "make the debt teams full words here so it's clear").
              Not as the roster's ladder: five letters earn their place in a
              COLUMN, where they align down every row and that alignment is the
              entire argument for drawing a mark instead of writing the words. A
              single record has no column, so the letters would buy nothing and
              cost a legend the reader has to go and find. Both surfaces compose
              from one function (`debtTeamValueText`), so they cannot drift into
              saying different things about one agent (L41). The backend had the
              same problem in miniature, so it takes the same vocabulary treatment
              through `backendServiceOf`.

              #2218 RETIRED LEGAL ELIGIBLE, which used to be the third field in
              this row. Dan, 2026-09-10: the attribute is no longer used, so the
              ten bucket criteria keyed on it went and nothing stores it. */}
          <div
            data-attr-row
            className="mt-4 flex flex-wrap items-start gap-x-8 gap-y-4"
          >
            <div>
              {/* heading-gloss-ok: a plural marker, not a gloss. An agent can hold several. */}
              <span className={labelCls}>Debt team(s)</span>
              {/* A blank beside a label reads as a panel that failed to load
                  rather than as an agent with no team (L10, L67), so the absent
                  case is named in the SAME words its neighbours use for the same
                  state (L118). The question is asked of the function that
                  composes the words, never of the raw attribute, or a stored
                  blank prints an empty string here while the ladder correctly
                  shows nothing (L70).

                  A stored value that is not one of the five rungs is still
                  coverage and is still named, as stored, or the panel that exists
                  to say what an agent covers would under report them (L113). */}
              <p className="text-sm">{attrValue(debtTeamValueText(debtCoverage))}</p>
            </div>
            <div>
              <span className={labelCls}>Backend</span>
              <p className="text-sm">{attrValue(backendServiceOf(agent))}</p>
            </div>
          </div>

        </section>

        {/* Move this agent's upcoming bookings to somebody else (#974). The id
            stays `coverage` deliberately even though the panel is named for the
            action now (#1876): it is in links people already hold, and the
            anchor is not what anybody reads. */}
        {canManageThisAgent && (
          <div id="coverage">
            <BulkReassignCoverage
              agentId={agent.id}
              agentName={agent.name ?? agent.email}
              reassignReasons={(await loadReasonOptions()).reassign.active}
              initialJobId={openJobId}
            />
          </div>
        )}
        {/* Account status: deactivate / reactivate (#278).

            LAST on the page (#1875). A control that says somebody has left the
            company was sitting above ordinary editing, so scrolling to the hours
            or the routing attributes went past it every time. It is below the
            panel that moves their bookings now, which is also the order the work
            happens in: move the bookings, then close the account. */}
        <section className={cardCls}>
          <p className="pn-eyebrow text-fg-muted">Account status</p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <Pill variant={active ? "status-ok" : "outline"}>
              {active ? "Active" : "Deactivated"}
            </Pill>
            {!canManageThisAgent ? (
              <span className="text-xs text-fg-muted">
                Only someone who outranks this agent can change this.
              </span>
            ) : active ? (
              isSelf ? (
                <span className="text-xs text-fg-muted">
                  You can&apos;t deactivate your own account.
                </span>
              ) : (
                <SaveForm action={setUserLifecycle} name="agent-lifecycle" unsaved="nothing typed here" className="flex items-end">
                  <input type="hidden" name="user_id" value={agent.id} />
                  <input type="hidden" name="action" value="deactivate" />
                  {/* #1215: confirm (never block) when this agent still holds
                      upcoming appointments, because deactivating does not move
                      them. The count comes from previewBulkReassign, the same
                      helper the coverage sweep enqueues from, so the warning and
                      the panel below can never disagree about the same gap. */}
                  <PoolExitConfirmButton
                    action="deactivate"
                    agentId={agent.id}
                    agentName={agent.name ?? agent.email}
                    upcomingBookings={heldUpcoming}
                  />
                </SaveForm>
              )
            ) : (
              <SaveForm action={setUserLifecycle} name="agent-lifecycle" unsaved="nothing typed here" className="flex items-end">
                <input type="hidden" name="user_id" value={agent.id} />
                <input type="hidden" name="action" value="reactivate" />
                <SubmitButton className={btnSecondaryCls} pendingLabel="Reactivating account">
                  Reactivate account
                </SubmitButton>
              </SaveForm>
            )}
          </div>
          {/* #1875: the copy lives in a pure builder, because the defect here
              WAS a sentence. It said deactivating is "Fully reversible by
              reactivating", which is the one claim on this panel that is false:
              deactivating clears `bookable` in the same write and reactivating
              deliberately does not restore it. A test that checked the button
              rendered would have passed straight through that.

              #2123: each control is explained where it IS. An active account
              offers Deactivate, so it reads what deactivating does; a deactivated
              one offers Reactivate, so it reads what reactivating does and does
              not restore. The explanation of a control the reader cannot see is
              a fact they have to hold until it becomes relevant, which is what
              put the reactivating sentence inside the deactivating one. */}
          <p className={`mt-3 text-xs text-fg-muted ${proseCls}`}>
            {active ? deactivateExplanation() : reactivateExplanation()}
          </p>
          <p className={`mt-2 text-xs text-fg-muted ${proseCls}`}>{notBookableContrast()}</p>
          {/* #3526: sign in refuses a Google account other than the one this
              account holds, so a reused address never hands the account to
              somebody new. A rehire on a new Google account meets the same
              refusal, and this is how an admin lets them through. Admins only,
              matching the action's own check, and only while an account is on
              record, since with none there is nothing to forget. Rare and
              consequential, so it lives here at the bottom of the closed section
              (L609), behind the shared destructive confirm that names what
              happens next (L180). */}
          {/* Never on your own page: relinking deletes the sign in it acts on. */}
          {/* Offered while an account OR a sign in is on record: a row with no
              account recorded whose sign in holds no Google account, or two, is
              refused on every request, and this is its way out too. */}
          {isAdmin && canManageThisAgent && !isSelf && (agent.google_sub || agent.auth_user_id) ? (
            <div className="mt-4 border-t border-border pt-4">
              <p className={`text-xs text-fg-muted ${proseCls}`}>
                {agent.google_sub
                  ? GOOGLE_RELINK_COPY.explanation(agent.name ?? agent.email)
                  : GOOGLE_RELINK_COPY.signInOnlyExplanation(agent.name ?? agent.email)}
              </p>
              <div className="mt-3">
                <DestructiveConfirm
                  openLabel={GOOGLE_RELINK_COPY.openLabel}
                  question={GOOGLE_RELINK_COPY.question(agent.name ?? agent.email)}
                  consequence={GOOGLE_RELINK_COPY.consequence(agent.name ?? agent.email, agent.email)}
                  dismissLabel={GOOGLE_RELINK_COPY.dismissLabel}
                  confirmLabel={GOOGLE_RELINK_COPY.confirmLabel}
                  pendingLabel={GOOGLE_RELINK_COPY.pendingLabel}
                  action={relinkGoogleAccount}
                  hidden={<input type="hidden" name="user_id" value={agent.id} />}
                  openGroupClassName="flex"
                  panelClassName="max-w-lg"
                />
              </div>
            </div>
          ) : null}
        </section>
          </div>
        </details>

      </>
    </>
  );
}

/**
 * What the pool toggle came back saying (#1769).
 *
 * The toggle used to return void: on success the only thing that changed was one
 * button being replaced by another in the corner of a dense row, and on a refusal
 * it threw, which on a route with no error boundary means Next's generic error
 * page with the message scrubbed. So the action that makes a LIVE Google call
 * before it writes anything was also the one that said the least.
 *
 * The refusals keep the wording that tells somebody what to DO, because the two
 * causes need different actions: an account gone from the Workspace is a
 * credential repair, and a temporary Google failure is worth retrying (see "Three
 * ways a Google calendar can fail, not two" in AGENTS.md).
 */
function BookableOutcome({ code }: { code?: string }) {
  if (!code) return null;

  const ok = code === "on" || code === "off" || code === "pending-cleared" || code === "pending-none";
  const said =
    code === "on"
      ? "This agent is now bookable. New bookings can be routed to them."
      : code === "off"
        ? "This agent is no longer bookable. New bookings will not be routed to them."
        : code === "blocked-gone"
          ? "Not made bookable: their Google calendar is unreachable, so the account may be gone from the Workspace or the delegation may be broken. Fix the calendar, then try again."
          : code === "blocked-not-provisioned"
            ? "Not made bookable: their Google account has never been given Google Calendar. Retrying will not help. A Workspace admin has to give them Calendar first."
            : code === "blocked-transient"
              ? "Not made bookable: their Google calendar could not be checked just now, which is usually a temporary Google issue. Try again shortly."
              : code === "blocked-unread"
                ? "Not made bookable: their Google account answered, and Slate could not load what is on their calendar. In the pool they would be offered as free for every hour of their working week, so they are being kept out until it can be read. Check the calendar sync lane for this account; the hourly roster sync retries on its own."
                : code === "blocked-timeout"
                  ? "Not made bookable: reading their calendar took longer than one activation is allowed, so it was stopped part way and nothing was measured. This is usually Google being slow rather than a problem with the account. Try again, or leave it: the hourly roster sync retries on its own."
                  : code === "blocked-contended"
                    ? "Not made bookable yet: Slate was refreshing their calendar in another job at the same moment, so this attempt stood down. Nothing is wrong with the account. Try again in a minute, or leave it: the hourly roster sync retries on its own."
                  : code === "blocked-redistribute"
                    ? "Not made bookable: Twilio has this advisor on Redistribute, so the hourly sync would turn them off again. Remove the tag in Twilio, and once the next hourly sync has run they can be made bookable."
                  : code === "unreadable"
                    ? "Nothing was changed: Slate could not read this agent's record just now, so the change could not be checked. Try again shortly."
                  : code === "pending-cleared"
                    ? "Slate has stopped trying to make this agent bookable. They stay not bookable until somebody makes them bookable here."
                  : code === "pending-none"
                    ? "Nothing was changed: Slate was no longer waiting to make this agent bookable."
                  : code === "not-permitted"
                    ? "Nothing was changed: changing this person's settings needs a role above theirs."
                  : code === "missing"
                    ? "That agent could not be found, so nothing was changed."
                    : null;
  if (!said) return null;

  return (
    <p
      role="status"
      className={`rounded-[var(--radius-md)] border px-4 py-3 text-sm ${
        ok ? "border-border bg-[var(--bg-alt)] text-fg" : "border-error text-error"
      }`}
    >
      {said}
    </p>
  );
}
