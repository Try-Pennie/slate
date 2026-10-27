import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { consoleHiddenFor } from "@/lib/env";
import { unwrap } from "@/lib/db/result";
import { TeamAccessPanel } from "@/components/TeamAccessPanel";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { isStaffAccessOutcome } from "@/lib/admin/staff-access";
import { pendingPrivilegedAccess } from "@/lib/admin/pending-access";
import type { User } from "@/lib/db/types";
import { realAdvisorsOnly } from "@/lib/advisors/real-advisor";

export const metadata = { title: "Team access" };

export const dynamic = "force-dynamic";

// Read once, outside the render tree, so how long each unclaimed grant has waited
// is measured against a single instant and not a different one per row.
function pendingAccessNow(users: User[]) {
  return pendingPrivilegedAccess(users, Date.now());
}

export default async function TeamAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ staff?: string; staff_email?: string; staff_role?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  // Granting Slate access to somebody outside the debt team is a super admin
  // action, and the server action enforces that itself. This is presentation.
  if (me.role !== "super_admin") return <AdminDenied need="a super admin" />;

  // #1629: unwrap rather than `(data ?? [])`. An unreadable roster draws the same
  // empty queue an actually-empty one draws, and this page's whole subject is who
  // is waiting, so the empty picture reads as "nobody is waiting for access".
  const users = unwrap(
    await realAdvisorsOnly(supabaseAdmin().from("users").select("*").eq("org_id", me.org_id)),
    "team-access roster",
  ) as User[];

  return (
    <>
      {/* #1907: the ONE name and the ONE description for this page. The panel
          below used to repeat both, one card apart. The second sentence came from
          the panel and is the one worth keeping: it is what tells somebody why a
          granted account can sit unused forever. */}
      <AdminPageHeader title="Team access">
        Slate accounts for people who are not debt team agents, so nothing creates
        them automatically. They pick the access up the first time they sign in with
        this exact address, so the address is the thing to get right.
      </AdminPageHeader>
      <TeamAccessPanel
        outcome={sp.staff && isStaffAccessOutcome(sp.staff) ? sp.staff : null}
        outcomeEmail={sp.staff_email ?? ""}
        outcomeRole={sp.staff_role ?? ""}
        pending={pendingAccessNow(users)}
      />
    </>
  );
}
