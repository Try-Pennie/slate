import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { consoleHiddenFor } from "@/lib/env";
import { cardCls } from "@/components/ui/styles";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { PlaceholderBookingSwitch } from "@/components/admin/PlaceholderBookingSwitch";
import { CoordinatorList } from "@/components/admin/CoordinatorList";
import { TransferOfferSettings } from "@/components/admin/TransferOfferSettings";
import StandaloneTheme from "@/components/StandaloneTheme";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import { readPlaceholderBookingEnabled, readTransferOfferSettings } from "@/lib/booking/settings";
import type { TransferOfferSettings as TransferSettings } from "@/lib/coordinator/transfer-queue";
import { loadCoordinators } from "@/lib/admin/coordinators-load";
import type { CoordinatorsRead } from "@/lib/admin/coordinators";
import { COORDINATOR_BOOKING_COPY as COPY } from "@/lib/admin/coordinator-booking-copy";
import { coordinatorFrame, type CoordinatorDesignFixture } from "@/lib/admin/coordinator-admin-fixture";
import { readDesignFixture } from "@/lib/admin/design-fixture-read";

export const metadata = { title: "Coordinator booking" };

export const dynamic = "force-dynamic";

/**
 * Coordinator booking (#4264), settled as docs/design/coordinator-admin.html: whether the
 * scheduling coordinators can book a call nobody is free for on Marcia, and who they are.
 *
 * WHO: a super admin, and nobody else (D2). Every lower role is answered not found rather
 * than refused on the page, so the page, like its sidebar item, does not exist for them; a
 * coordinator is nobody to the console (`currentUser`) and is sent to sign in. Both server
 * actions check super admin themselves, so this gate is presentation, not the control.
 * WHOSE DATA: the org wide settings row, and the caller's own org's coordinators.
 *
 * `?frame=` draws one of the design's frames from its committed fixture, so the design
 * match score compares like with like; it answers only when the e2e run sets the flag and
 * the request is to this machine (`designFixturesEnabled`), and only after the role gate.
 */
export default async function CoordinatorBookingPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; frame?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (me.role !== "super_admin") notFound();

  const fixture = await readDesignFixture<CoordinatorDesignFixture>(sp.frame, "coordinator-admin");
  if (fixture && sp.frame) {
    const f = coordinatorFrame(fixture, sp.frame);
    return (
      <>
        <StandaloneTheme theme={f.theme} />
        <View
          on={f.switchState === "on"}
          read={f.read}
          initiallyAsking={f.switchState === "confirm-on"}
          initiallyRemoving={f.removing}
        />
      </>
    );
  }

  // Each its own read, and each failure its own state: an unreadable switch is null, never
  // drawn as off, and an unreadable list is a failure, never nobody (L10, L530).
  const [on, read, transfer] = await Promise.all([readPlaceholderBookingEnabled(), loadCoordinators(me.org_id), readTransferOfferSettings()]);
  const saved = savedSentence(savedOutcome(sp.ok));
  return (
    <View
      on={on}
      read={read}
      transfer={{ settings: transfer }}
      notice={
        <>
          {saved && <SettingsSaveNotice ok saved={saved} error={sp.error} />}
          {sp.error && !saved && <SettingsSaveNotice ok={false} error={sp.error} saved="" />}
        </>
      }
    />
  );
}

function View({
  on,
  read,
  notice,
  initiallyAsking,
  initiallyRemoving,
  transfer,
}: {
  on: boolean | null;
  read: CoordinatorsRead;
  /**
   * #4380: the live transfer settings, or absent in the coordinator admin design's frames,
   * which were settled before the setting existed and do not draw it.
   */
  transfer?: { settings: TransferSettings | null };
  notice?: React.ReactNode;
  initiallyAsking?: boolean;
  initiallyRemoving?: string | null;
}) {
  return (
    <>
      {/* D5: who coordinators are, once, under the title (L604). */}
      <AdminPageHeader title={COPY.page.title}>{COPY.page.intro}</AdminPageHeader>
      {notice}
      {/* D4: one card, the switch first and the people it governs under the divider, so the
          rule and the people are read together. */}
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">{COPY.section.heading}</h2>
        <div className="mt-4">
          <PlaceholderBookingSwitch on={on} initiallyAsking={initiallyAsking} />
        </div>
        <div className="mt-6 border-t border-border pt-4">
          <CoordinatorList read={read} initiallyRemoving={initiallyRemoving} />
        </div>
        {transfer && (
          <div className="mt-6 border-t border-border pt-4">
            <TransferOfferSettings settings={transfer.settings} />
          </div>
        )}
      </section>
    </>
  );
}
