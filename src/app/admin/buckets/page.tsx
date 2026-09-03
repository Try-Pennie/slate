import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { deriveAttributeCatalog } from "@/lib/availability/catalog";
import { bucketDepthByCode } from "@/app/admin/bucket-depth";
import { setDefaultBucket } from "@/app/admin/actions";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { BucketForm } from "@/components/admin/BucketForm";
import { RosterProvider } from "@/components/admin/BucketMembersPicker";
import { rosterSectionFor, type RosterEntry } from "@/lib/admin/bucket-member-picker";
import { btnCls, cardCls, labelCls, proseCls, selectCls } from "@/components/ui/styles";
import type { Bucket, BucketMember, EventType, User } from "@/lib/db/types";

export const dynamic = "force-dynamic";

export default async function BucketsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");

  const db = supabaseAdmin();
  // allSettled, not all: a table that does not exist yet during a
  // migrate-before-deploy window REJECTS rather than resolving with an error, and
  // one rejection out of four would take the whole page down instead of marking
  // the one panel that could not be read. A rejection is mapped to the same
  // "unreadable" state a returned error produces, so the two arrive at one place
  // rather than at a 500 and a notice.
  const settled = await Promise.allSettled([
    db.from("users").select("*").eq("org_id", me.org_id).eq("is_test", false),
    db.from("event_types").select("*").eq("org_id", me.org_id),
    db.from("buckets").select("*").eq("org_id", me.org_id),
    db.from("bucket_members").select("*"),
  ]);
  const read = <T,>(i: number): { data: T[] | null; error: unknown } =>
    settled[i]!.status === "fulfilled"
      ? (settled[i] as PromiseFulfilledResult<{ data: T[] | null; error: unknown }>).value
      : { data: null, error: (settled[i] as PromiseRejectedResult).reason };
  const usersRes = read<User>(0);
  const eventTypesRes = read<EventType>(1);
  const bucketsRes = read<Bucket>(2);
  const membersRes = read<BucketMember>(3);
  // #1629: each read is classified separately, because the editor WRITES what it
  // shows. An unreadable buckets or members read draws pools with nobody in them
  // and every attribute group blank, and saving that form would persist the empty
  // reading as fact. Editing stays off until every input behind it really loaded.
  const users = (usersRes.data ?? []) as User[];
  const rosterUnreadable = usersRes.error != null;
  const eventTypes = (eventTypesRes.data ?? []) as EventType[];
  const eventTypesUnreadable = eventTypesRes.error != null;
  const buckets = (bucketsRes.data ?? []) as Bucket[];
  const bucketsUnreadable = bucketsRes.error != null;
  const members = (membersRes.data ?? []) as BucketMember[];
  const membersUnreadable = membersRes.error != null;
  const attrCatalog = deriveAttributeCatalog(users.map((u) => u.attributes));
  // #1760: the members picker is a client component, so only the three strings it
  // can draw cross to the browser, and they cross ONCE (RosterProvider) rather
  // than per bucket form. Sorting and grouping live in the shared predicate, not
  // here, so the server render and the browser's filtering cannot drift.
  //
  // #1762 owns the question of whether departed and non bookable people belong in
  // this list at all; the sections are the seam that answer hangs on, and nothing
  // here pre-empts it.
  const roster: RosterEntry[] = users.map((u) => ({
    id: u.id,
    name: u.name ?? "",
    email: u.email,
    section: rosterSectionFor(u.role),
  }));
  // `null` (not a zeroed map) when either input could not be read: the eligible
  // count beside each bucket then says nothing instead of saying zero.
  const depthByBucketCode =
    rosterUnreadable || bucketsUnreadable || membersUnreadable
      ? null
      : bucketDepthByCode(buckets, users, members);

  // Direct-booking default bucket (#1016): which pool a booking with no bucket
  // code lands in. It picks from the same list this page edits, so it lives here.
  let defaultBucketCode: string | null = null;
  let bucketOptions: { code: string; name: string }[] = [];
  try {
    const [settings, codes] = await Promise.all([
      db.from("booking_settings").select("default_bucket_code").eq("id", 1).maybeSingle(),
      db.from("buckets").select("code, name").eq("is_test", false).order("code"),
    ]);
    if (!settings.error && settings.data) {
      defaultBucketCode = (settings.data as { default_bucket_code: string | null }).default_bucket_code;
    }
    if (!codes.error && codes.data) bucketOptions = codes.data as typeof bucketOptions;
  } catch {
    // Fall through to an empty picker rather than 500ing the whole page during a
    // migrate-before-deploy window.
  }

  return (
    <>
      <AdminPageHeader title="Buckets">
        The round robin pools a lead can be routed into. Changes apply without a
        deploy.
      </AdminPageHeader>
      <SettingsSaveNotice ok={!!sp.ok} error={sp.error} />
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Direct-booking default bucket</h2>
        <p className={`mb-4 text-xs text-fg-muted ${proseCls}`}>
          When a direct-booking API caller does not pass a bucket code (XBC), Slate
          routes to this bucket. Leave it as &ldquo;No default&rdquo; to make a missing
          code an explicit error instead of a silent guess.
        </p>
        <form action={setDefaultBucket} className="space-y-4">
          <div>
            <label className={labelCls} htmlFor="default_bucket_code">
              Default bucket
            </label>
            <select
              id="default_bucket_code"
              name="default_bucket_code"
              defaultValue={defaultBucketCode ?? ""}
              className={`${selectCls} w-72`}
            >
              <option value="">No default (require a bucket code)</option>
              {bucketOptions.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.code} ({b.name})
                </option>
              ))}
            </select>
            {bucketOptions.length === 0 && (
              <p className="mt-1 text-xs text-fg-muted">
                No bookable buckets found to choose from.
              </p>
            )}
          </div>
          <SubmitButton className={btnCls} pendingLabel="Saving…">
            Save default bucket
          </SubmitButton>
        </form>
      </section>
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Buckets (round-robin pools)</h2>
        <p className={`mb-4 text-xs text-fg-muted ${proseCls}`}>
          Edit routing live. Changes apply without a deploy. Routing matches
          agents by attribute; leave all groups empty to pick members manually.
        </p>
        {/* #1629: the editor writes what it shows. An unreadable buckets or
            members read draws pools with nobody in them and every attribute group
            blank, and SAVING that form would then persist the empty reading as
            fact. Neither the existing pools nor the new-bucket form is offered
            until every input behind them was actually read. */}
        {bucketsUnreadable || membersUnreadable || rosterUnreadable || eventTypesUnreadable ? (
          <UnreadableNotice>
            {bucketsUnreadable
              ? "The buckets could not be read, so none are shown."
              : membersUnreadable
                ? "The bucket memberships could not be read, so the pools are not shown."
                : rosterUnreadable
                  ? "The roster could not be read, so the pools are not shown."
                  : "The event types could not be read, so the pools are not shown."}{" "}
            No routing has changed. Editing is off on this panel until it loads,
            because saving it now would write the blanks on screen over what is
            really configured.
          </UnreadableNotice>
        ) : (
          <RosterProvider roster={roster}>
            <div className="space-y-4">
              {buckets.map((b) => (
                <BucketForm
                  key={b.id}
                  bucket={b}
                  eventTypes={eventTypes}
                  roster={roster}
                  memberIds={
                    new Set(
                      members.filter((m) => m.bucket_id === b.id).map((m) => m.user_id),
                    )
                  }
                  catalog={attrCatalog}
                  eligibleCount={depthByBucketCode?.get(b.code) ?? 0}
                />
              ))}
              {buckets.length === 0 && (
                <p className="text-sm text-fg-muted">None yet.</p>
              )}
            </div>
            <div className="mt-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                New bucket
              </h3>
              <BucketForm
                eventTypes={eventTypes}
                roster={roster}
                memberIds={new Set()}
                catalog={attrCatalog}
              />
            </div>
          </RosterProvider>
        )}
      </section>
    </>
  );
}
