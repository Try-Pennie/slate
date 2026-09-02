import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canManageAgents } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import BookingLookup from "@/components/BookingLookup";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { cardCls, proseCls } from "@/components/ui/styles";

export const dynamic = "force-dynamic";

export default async function BookingLookupPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canManageAgents(me.role)) return <AdminDenied need="a manager or admin" />;
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");

  return (
    <>
      <AdminPageHeader title="Look up a booking">
        Any booking by attendee email, name, phone, or booking id, with its
        reschedule, cancel, and reassign history.
      </AdminPageHeader>
      <section className={cardCls}>
        <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>
          This reaches every booking, including ones older than the recent routing
          list.
        </p>
        <BookingLookup />
      </section>
    </>
  );
}
