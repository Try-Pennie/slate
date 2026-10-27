import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canManageAgents, canEditOrgSettings } from "@/lib/auth/roles";
import { appUrl, consoleHiddenFor, reassignApiKey } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { RecentRoutingTable, type RecentRoutingRow } from "@/components/RecentRoutingTable";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { cardCls, labelCls, proseCls } from "@/components/ui/styles";
import type { User } from "@/lib/db/types";
import { loadTierDropReport, type TierDropReport } from "@/lib/admin/tier-drops-load";
import { TierDropPanel } from "@/components/admin/TierDropPanel";

export const metadata = { title: "Recent routing" };

export const dynamic = "force-dynamic";

function nowMs(): number {
  return Date.now();
}

export default async function RecentRoutingPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canManageAgents(me.role)) return <AdminDenied need="a manager or admin" />;
  const isAdmin = canEditOrgSettings(me.role);

  const db = supabaseAdmin();
  // 2026-10-02: a tier drop no longer pages, so this panel is where it is seen. A
  // failed read draws an unreadable notice, never "no drops" (#1629).
  const tierDrops: Promise<TierDropReport | null> = loadTierDropReport(db, me.org_id, nowMs()).catch(
    () => null,
  );
  const [usersRes, recentRes] = await Promise.all([
    // #1914: test agents INCLUDED. This roster is a display only name map, and
    // the bookings beside it are not filtered, so excluding the test agents from
    // the names while showing their bookings made the two reads disagree about
    // what counts: before cutover the only bookings that exist are the SMOKE ones
    // (#396), so every visible row's agent was missing from the very map used to
    // name it. The `is_test` filter belongs where a test agent must not be
    // CHOSEN (a picker, the pool), not where one has to be named.
    // any-advisor-ok: the #1914 name map, which names the placeholder's bookings too (#4201).
    db.from("users").select("*").eq("org_id", me.org_id),
    // #2660: test bookings are kept OUT of this read through the bucket join,
    // which is where the flag lives (`bookings` has none of its own). A stranger's
    // booking on the public test bucket is not a routing decision worth reading,
    // and before cutover the canary's would otherwise be the whole table. The
    // roster above still includes the test agents (#1914), because the name map
    // and this read must agree about who exists, and that holds either way.
    // The bucket's name rides along for a manager, who reads a pool in words
    // rather than a code, and needs the stored name for a bucket outside the
    // routing matrix, which has no pool name (2026-10-02).
    db
      .from("bookings")
      .select(
        "id, attendee_name, attendee_email, attendee_phone, starts_at, assigned_user_id, status, routing_trace, buckets!inner(is_test, name)",
      )
      .eq("org_id", me.org_id)
      .eq("buckets.is_test", false)
      // #2073: routing decisions only. A booking through an agent's own link was
      // never routed and carries no trace, so it would draw as an empty decision.
      .eq("kind", "routed")
      .order("created_at", { ascending: false })
      .limit(25),
  ]);
  // #1629: an empty trace says "nothing has been booked", which is exactly the
  // question this page is opened to answer, so a failed read must not draw it.
  // unwrap, not `?? []`: the roster is what turns each trace's agent ids into
  // names, so an unreadable one draws a table of "unassigned" against every
  // booking. That is a specific and wrong answer to the question this page is
  // opened to ask, rather than an absence of one.
  const users = unwrap(usersRes, "recent routing roster") as User[];
  const recent = (recentRes.data ?? []) as RecentRoutingRow[];
  const recentUnreadable = recentRes.error != null;
  const tierDropReport = await tierDrops;

  return (
    <>
      {/* #1915: the header describes the PAGE, which holds two cards, rather
          than restating the first one. Its old description was the section's
          sentence with the count taken out, which is the worse of the two: the
          section knows how many bookings it actually read. That sentence stays
          where it is, inside the branch where the read SUCCEEDED, because in the
          header it would claim "the last 0 bookings routed" off a read that
          never ran (#1629). */}
      <AdminPageHeader title="Recent routing">
        Why each recent booking went to the advisor it did, how often a lead dropped
        a debt tier, and the API for forcing one onto a specific advisor.
      </AdminPageHeader>
      <section className={cardCls}>
        {/* #1915: no heading of its own. The page header above names this,
            and a section that IS the page restating the page's title is the
            redundancy Dan read as "this is redundant". A page shell that titles
            itself and a section that titles itself are each correct alone; the
            duplication exists only in the composition, which is the one place
            nobody reads. */}
        {/* An empty trace says "nothing has been booked", which is exactly the
            question this panel is opened to answer (#1629). */}
        {recentUnreadable ? (
          <UnreadableNotice>
            The recent bookings could not be read, so no routing is shown. This is
            not a report that nothing has been booked.
          </UnreadableNotice>
        ) : (
          <>
            <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>
              How the last {recent.length} bookings routed: agents considered, who
              was chosen, whether the fallback fired, and any manual reassignments.
            </p>
            <RecentRoutingTable rows={recent} users={users} showCodes={isAdmin} />
          </>
        )}
      </section>
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Tier drops</h2>
        {tierDropReport === null ? (
          <UnreadableNotice>
            The tier drops could not be read, so none are counted. This is not a
            report that no lead dropped a tier.
          </UnreadableNotice>
        ) : (
          <TierDropPanel report={tierDropReport} showCodes={isAdmin} />
        )}
      </section>
      {isAdmin && (
        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Reassign API</h2>
          <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>
            Force a booking onto a specific owning advisor (the contact owner
            override). Send <code className="break-all">POST {appUrl()}/api/bookings/reassign</code> with
            a bearer token and a JSON body of <code>bookingId</code> and{" "}
            <code>agentEmail</code>.
          </p>
          {/* heading-gloss-ok: the SCHEME the value is sent under, which the
              caller has to match. A format note, not a definition. */}
          {/* A caption for a value shown, not a form control, so a heading
              rather than a label (#3080). */}
          <h3 className={labelCls}>Authorization key (Bearer)</h3>
          <code className="mt-1 block break-all rounded-sm bg-[var(--pennie-wild-sand)] px-3 py-2 text-xs dark:bg-fg/10">
            {reassignApiKey() ||
              "not configured (set REASSIGN_API_KEY on the worker)"}
          </code>
        </section>
      )}
    </>
  );
}
