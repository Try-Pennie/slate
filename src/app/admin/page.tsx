import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { deriveAttributeCatalog } from "@/lib/availability/catalog";
import { bucketDepthByCode } from "@/app/admin/bucket-depth";
import { appUrl, reassignApiKey, oooOnlyFor } from "@/lib/env";
import { normalizeBookerLayout } from "@/lib/booking/layout";
import { paginateRows } from "@/lib/paginate-rows";
import { RecentRoutingTable, type RecentRoutingRow } from "@/components/RecentRoutingTable";
import { CronLaneHealth } from "@/components/CronLaneHealth";
import { loadLaneHealth } from "@/lib/monitor/lane-health-view";
import { readAllHeartbeatMs } from "@/lib/monitor/heartbeat";
import { isActive } from "@/lib/active-user";
import { dedupeFailingAgents, type FailingCalendarRow } from "@/lib/notify/alerts";
import {
  createBucket,
  createEventType,
  replayFailedWebhooks,
  resendWebhookDelivery,
  setOrgDefaultHours,
  startImpersonation,
  setWebhookEndpoint,
  syncSalesforceNow,
  updateBucket,
} from "@/app/admin/actions";

async function setOrgBookerLayout(formData: FormData): Promise<void> {
  "use server";
  const admin = await requireAdmin();
  const layout = normalizeBookerLayout(formData.get("booker_layout"));
  await supabaseAdmin()
    .from("organizations")
    .update({ booker_layout: layout })
    .eq("id", admin.org_id);
  revalidatePath("/admin");
}
import {
  atLeast,
  canManageAgents,
  canEditOrgSettings,
  canEditOrgDefaults,
  roleLabel,
  ROLES,
} from "@/lib/auth/roles";
import { AppHeader } from "@/components/AppHeader";
import { labelCls, inputCls, cardCls, btnCls, btnSecondaryCls } from "@/components/ui/styles";
import { Pill } from "@/components/ui/Pill";
import { deliveryDisplay } from "@/lib/webhooks/delivery-display";
import { AutoSubmitSelect } from "@/components/ui/AutoSubmitSelect";
import { FilterForm } from "@/components/ui/FilterForm";
import { InPlaceLink } from "@/components/ui/InPlaceLink";
import { TimeField } from "@/components/ui/TimeField";
import { DayToggles } from "@/components/ui/DayToggles";
import { SyncButton } from "@/components/SyncButton";
import { SubmitButton } from "@/components/ui/SubmitButton";
import BookingLookup from "@/components/BookingLookup";
import { SyncHealthPanel, type SyncHealthRow } from "@/components/ui/SyncHealthPanel";
import type {
  AuditEntry,
  Bucket,
  BucketMember,
  Criteria,
  EventType,
  Organization,
  User,
  WebhookDelivery,
  WebhookEndpoint,
} from "@/lib/db/types";

type DeliveryRow = Pick<
  WebhookDelivery,
  | "id"
  | "endpoint_id"
  | "event"
  | "status"
  | "attempts"
  | "last_response"
  | "created_at"
  | "suppressed"
>;

const AUDIT_LABEL: Record<string, string> = {
  "role.set": "changed role",
  "agent.hours": "set hours",
  "agent.use_default_hours": "applied default hours",
  "agent.bookable": "set bookable",
  "agent.attributes": "set attributes",
  "monitor.settings": "changed alert settings",
};


export const dynamic = "force-dynamic";

// Load + classify cron-lane heartbeats against "now". At module scope so the
// Date.now() call doesn't trip react-hooks/purity in render (#288), matching
// liveWatchedUserIds. The read-error -> unavailable logic lives in loadLaneHealth
// (unit-tested); this only supplies the clock.
function loadLaneHealthNow(read: () => Promise<Record<string, number | null>>) {
  return loadLaneHealth(read, Date.now());
}

// User ids with at least one live (non-expired) calendar watch. At module
// scope so the Date.now() call doesn't trip react-hooks/purity in render.
function liveWatchedUserIds(
  rows: { user_id: string; watch_expiration: string | null }[],
): Set<string> {
  const now = Date.now();
  const set = new Set<string>();
  for (const r of rows) {
    if (r.watch_expiration && Date.parse(r.watch_expiration) > now) {
      set.add(r.user_id);
    }
  }
  return set;
}

/** Checkbox grid of routable attribute keys/values, derived from live agents. */
function CriteriaEditor({
  catalog,
  current,
}: {
  catalog: Record<string, string[]>;
  current: Criteria;
}) {
  const keys = Object.keys(catalog);
  if (keys.length === 0) {
    return (
      <p className="mt-1 text-xs text-fg-muted">
        No agent attributes synced yet. Sync from Salesforce to route by attribute.
      </p>
    );
  }
  return (
    <div className="mt-1 space-y-2">
      {keys.map((key) => {
        const cur = current[key];
        const selected = new Set(
          (Array.isArray(cur) ? cur : cur != null ? [cur] : []).map(String),
        );
        return (
          <div key={key} className="flex flex-wrap items-center gap-2">
            <code className="rounded-xs bg-[var(--pennie-wild-sand)] px-1 text-xs dark:bg-fg/10">{key}</code>
            {catalog[key].map((v) => (
              <label key={v} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  name={`crit_${key}`}
                  value={v}
                  defaultChecked={selected.has(v)}
                  className="accent-pennie-sky"
                />
                {v}
              </label>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Create/edit form for one bucket (shared between the list rows and "new").
 *  `eligibleCount` (bookable-agent depth) is computed once by the page via the
 *  shared staffing-depth helper so it can never diverge from the booker's pool. */
function BucketForm({
  bucket,
  eventTypes,
  users,
  memberIds,
  catalog,
  eligibleCount = 0,
}: {
  bucket?: Bucket;
  eventTypes: EventType[];
  users: User[];
  memberIds: Set<string>;
  catalog: Record<string, string[]>;
  eligibleCount?: number;
}) {
  const editing = !!bucket;
  return (
    <form
      action={editing ? updateBucket : createBucket}
      className="space-y-3 rounded-md border border-border p-3"
    >
      {editing && <input type="hidden" name="bucket_id" value={bucket.id} />}
      {editing && (
        <p
          className={`text-xs ${
            eligibleCount === 0
              ? bucket.fallback_user_id
                ? "text-fg-muted"
                : "text-[var(--error)]"
              : "text-fg-muted"
          }`}
        >
          {eligibleCount} eligible agent{eligibleCount === 1 ? "" : "s"}
          {eligibleCount === 0
            ? bucket.fallback_user_id
              ? " (using fallback agent)"
              : " (no fallback set, bookings will fail)"
            : ""}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={labelCls}>Code (xbc)</label>
          <input name="code" aria-label="Code (xbc)" defaultValue={bucket?.code ?? ""} className={`${inputCls} w-28`} required />
        </div>
        <div>
          <label className={labelCls}>Name</label>
          <input name="name" aria-label="Name" defaultValue={bucket?.name ?? ""} className={inputCls} required />
        </div>
        <div>
          <label className={labelCls}>Event type</label>
          <select
            name="event_type_id"
            aria-label="Event type"
            defaultValue={bucket?.event_type_id ?? ""}
            className={inputCls}
            required
          >
            {eventTypes.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Cal routing form id (optional)</label>
          <input
            name="routing_form_id"
            aria-label="Cal routing form id (optional)"
            defaultValue={bucket?.routing_form_id ?? ""}
            className={`${inputCls} w-44`}
          />
        </div>
        <div>
          <label className={labelCls}>Fallback agent (when none match)</label>
          <select
            name="fallback_user_id"
            aria-label="Fallback agent (when none match)"
            defaultValue={bucket?.fallback_user_id ?? ""}
            className={inputCls}
          >
            <option value="">None</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ?? u.email}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <span className={labelCls}>
          Route to agents matching every group below (any value within a group)
        </span>
        <CriteriaEditor catalog={catalog} current={bucket?.criteria ?? {}} />
      </div>
      <div>
        <label className={labelCls}>Manual members (optional)</label>
        <div className="mt-1 flex flex-wrap gap-3">
          {users.map((u) => (
            <label key={u.id} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                name="members"
                value={u.id}
                defaultChecked={memberIds.has(u.id)}
                className="accent-pennie-sky"
              />
              {u.name ?? u.email}
            </label>
          ))}
        </div>
      </div>
      <SubmitButton className={btnCls} pendingLabel={editing ? "Saving…" : "Creating…"}>
        {editing ? "Save bucket" : "Create bucket"}
      </SubmitButton>
    </form>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    role?: string;
    team?: string;
    manager?: string;
    bookable?: string;
    page?: string;
    imp_error?: string;
    imp_email?: string;
    synced?: string;
    sync_error?: string;
  }>;
}) {
  const sp = await searchParams;
  const query = (sp.q ?? "").trim().toLowerCase();
  const roleFilter = sp.role ?? "";
  const teamFilter = sp.team ?? "";
  const managerFilter = sp.manager ?? "";
  const bookableFilter = sp.bookable ?? ""; // "" all · "yes" · "no"
  const requestedPage = Number.parseInt(sp.page ?? "1", 10);
  const hasFilter =
    !!query || !!roleFilter || !!teamFilter || !!managerFilter || !!bookableFilter;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canManageAgents(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need a manager or admin account to manage Slate.
      </main>
    );
  }
  // OOO-only launch: the agent roster is part of the booking tool, so everyone
  // below super admin is limited to the OOO surfaces until scheduling goes live
  // (the scheduling tool isn't ready). Super admins keep the roster/config.
  if (oooOnlyFor(me.role)) {
    redirect("/admin/ooo");
  }
  // Managers manage the agent roster; only admins see org/app config and can
  // move the org-wide default working hours.
  const isAdmin = canEditOrgSettings(me.role);
  const canEditDefaults = canEditOrgDefaults(me.role);

  const db = supabaseAdmin();
  const [usersRes, eventTypesRes, bucketsRes, membersRes, webhookRes, orgRes, calsRes, recentRes] =
    await Promise.all([
      // Exclude the synthetic smoke-test agent (#396) from the roster, the
      // bookable count, and the bucket member / fallback pickers fed by it.
      db.from("users").select("*").eq("org_id", me.org_id).eq("is_test", false),
      db.from("event_types").select("*").eq("org_id", me.org_id),
      db.from("buckets").select("*").eq("org_id", me.org_id),
      db.from("bucket_members").select("*"),
      db
        .from("webhook_endpoints")
        .select("*")
        .eq("org_id", me.org_id)
        .limit(1)
        .maybeSingle(),
      db.from("organizations").select("*").eq("id", me.org_id).single(),
      db
        .from("agent_calendars")
        .select(
          "user_id, watch_expiration, consecutive_failures, last_success_at, last_sync_error",
        ),
      db
        .from("bookings")
        .select(
          "id, attendee_name, attendee_email, attendee_phone, starts_at, assigned_user_id, status, routing_trace",
        )
        .eq("org_id", me.org_id)
        .order("created_at", { ascending: false })
        .limit(25),
    ]);

  const org = orgRes.data as Organization;
  const users = (usersRes.data ?? []) as User[];
  const eventTypes = (eventTypesRes.data ?? []) as EventType[];
  const buckets = (bucketsRes.data ?? []) as Bucket[];
  const members = (membersRes.data ?? []) as BucketMember[];
  // Routing editor offers only attribute keys/values that exist on agents.
  const attrCatalog = deriveAttributeCatalog(users.map((u) => u.attributes));
  // Bookable-agent depth per bucket, from the shared staffing-depth helper (#584)
  // so this count matches the booker's pool exactly (bookable + not deactivated,
  // active members only) instead of an ad-hoc recompute that could drift.
  const depthByBucketCode = bucketDepthByCode(buckets, users, members);
  const webhook = webhookRes.data as WebhookEndpoint | null;

  // Routing trace viewer: recent bookings + how each one routed.
  const recent = (recentRes.data ?? []) as RecentRoutingRow[];
  const agentName = new Map(users.map((u) => [u.id, u.name ?? u.email]));
  const nameOf = (id: string | null) =>
    id ? (agentName.get(id) ?? id.slice(0, 8)) : "unassigned";

  // Webhook delivery log (admin only): recent attempts across the org's endpoints.
  let deliveries: DeliveryRow[] = [];
  const endpointUrl = new Map<string, string>();
  if (isAdmin) {
    const { data: eps } = await db
      .from("webhook_endpoints")
      .select("id, url")
      .eq("org_id", me.org_id);
    const epList = (eps ?? []) as { id: string; url: string }[];
    for (const e of epList) endpointUrl.set(e.id, e.url);
    if (epList.length) {
      const { data: dels } = await db
        .from("webhook_deliveries")
        .select(
          "id, endpoint_id, event, status, attempts, last_response, created_at, suppressed",
        )
        .in(
          "endpoint_id",
          epList.map((e) => e.id),
        )
        .order("created_at", { ascending: false })
        .limit(25);
      deliveries = (dels ?? []) as DeliveryRow[];
    }
  }

  // Audit log (admin only): recent privileged actions.
  let auditEntries: AuditEntry[] = [];
  if (isAdmin) {
    const { data } = await db
      .from("audit_log")
      .select("*")
      .eq("org_id", me.org_id)
      .order("created_at", { ascending: false })
      .limit(25);
    auditEntries = (data ?? []) as AuditEntry[];
  }

  // Push health: how many bookable agents have at least one live Google watch
  // channel across their calendars. A shortfall means external calendar edits
  // for those agents only reach the cache via the cron backstop, not push.
  const watchedUserIds = liveWatchedUserIds(
    (calsRes.data ?? []) as { user_id: string; watch_expiration: string | null }[],
  );
  const bookableAgents = users.filter((u) => u.bookable && isActive(u));
  const watchedCount = bookableAgents.filter((u) => watchedUserIds.has(u.id)).length;
  const pushHealthy =
    bookableAgents.length > 0 && watchedCount === bookableAgents.length;

  // Per-lane cron health strip (#288): reuse the dead-man's-switch heartbeats so a
  // silently-wedged lane is visible in-app. readAllHeartbeatMs THROWS on a read
  // error by design (an empty map would read as "all lanes dead"); catch it and
  // show an explicit "unavailable" strip rather than a misleading all-fine one.
  const { rows: laneHealth, unavailable: laneHealthUnavailable } =
    await loadLaneHealthNow(readAllHeartbeatMs);

  // Per-agent sync health (#273 Phase 1.3): which agents have a calendar in a
  // failure streak, deduped to one entry per agent (worst calendar kept) so the
  // operator can act without hand-querying the DB. Same logic as the named alert.
  const calDiag = (calsRes.data ?? []) as {
    user_id: string;
    consecutive_failures: number | null;
    last_success_at: string | null;
    last_sync_error: string | null;
  }[];
  const userById = new Map(users.map((u) => [u.id, u]));
  const nameByEmail = new Map(users.map((u) => [u.email, u.name]));
  const failingRows: FailingCalendarRow[] = calDiag
    .filter((c) => (c.consecutive_failures ?? 0) > 0)
    .map((c) => {
      const u = userById.get(c.user_id);
      return {
        consecutive_failures: c.consecutive_failures ?? 0,
        last_success_at: c.last_success_at,
        last_sync_error: c.last_sync_error,
        email: u?.email ?? null,
        bookable: u?.bookable ?? false,
        deactivated_at: u?.deactivated_at ?? null,
      };
    });
  const syncHealthRows: SyncHealthRow[] = dedupeFailingAgents(failingRows).map((a) => ({
    email: a.email,
    name: nameByEmail.get(a.email) ?? null,
    consecutiveFailures: a.consecutiveFailures,
    lastSuccessAt: a.lastSuccessAt,
    error: a.error,
  }));

  // Debt team(s) an agent belongs to (the attribute is a string or string[]).
  const teamsOf = (u: User): string[] => {
    const t = u.attributes?.debt_team;
    return Array.isArray(t) ? t.map(String) : t != null ? [String(t)] : [];
  };
  // Sort key: surname (last whitespace-separated token of the display name),
  // falling back to the email when there's no name.
  const lastNameKey = (u: User): string => {
    const name = (u.name ?? "").trim();
    if (!name) return (u.email ?? "").toLowerCase();
    const parts = name.split(/\s+/);
    return parts[parts.length - 1].toLowerCase();
  };

  const filterCtl =
    "h-11 rounded-sm border border-border bg-surface px-2.5 text-sm text-fg";
  // Filter option lists, derived from the roster so they only offer real values.
  const rolesPresent = ROLES.filter((r) => users.some((u) => u.role === r));
  const teamOptions = [...new Set(users.flatMap(teamsOf))].sort();
  const managerOptions = [
    ...new Map(
      users
        .filter((u) => u.manager_id)
        .map((u) => [u.manager_id as string, users.find((x) => x.id === u.manager_id)] as const)
        // Admins/super admins are operators, not real managers — keep them out
        // of the manager filter even if they're set as someone's manager_id.
        .filter(([, m]) => m && !atLeast(m.role, "admin"))
        .map(([id, m]) => [id, m ? (m.name ?? m.email) : "Unknown"] as [string, string]),
    ),
  ].sort((a, b) => a[1].localeCompare(b[1]));

  const visibleAgents = users
    .filter((u) => {
      if (!isActive(u)) return false; // hide offboarded users from the roster
      if (roleFilter && u.role !== roleFilter) return false;
      if (bookableFilter === "yes" && !u.bookable) return false;
      if (bookableFilter === "no" && u.bookable) return false;
      if (teamFilter && !teamsOf(u).includes(teamFilter)) return false;
      if (managerFilter && u.manager_id !== managerFilter) return false;
      if (query) {
        const hay = `${u.name ?? ""} ${u.email}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        lastNameKey(a).localeCompare(lastNameKey(b)) ||
        (a.name ?? a.email).localeCompare(b.name ?? b.email),
    );

  // Render the roster a page at a time so the DOM stays bounded as the roster
  // grows (#94). The full `users` load stays whole (the bucket/depth/filter
  // editors above need it); only the table's rendered rows are paged.
  const AGENTS_PER_PAGE = 50;
  const agentsPage = paginateRows(visibleAgents, requestedPage, AGENTS_PER_PAGE);
  // A link to another agents page that preserves the active filters and jumps to
  // the table anchor so the viewport doesn't reset to the top of the page.
  const agentsPageHref = (page: number) => {
    const params = new URLSearchParams();
    if (sp.q) params.set("q", sp.q);
    if (roleFilter) params.set("role", roleFilter);
    if (teamFilter) params.set("team", teamFilter);
    if (managerFilter) params.set("manager", managerFilter);
    if (bookableFilter) params.set("bookable", bookableFilter);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    return `/admin${qs ? `?${qs}` : ""}#agents`;
  };

  return (
    <>
    <AppHeader
      email={me.email}
      role={me.role}
      active="admin"
      themePreference={me.theme_preference}
      userId={me.id}
      orgId={me.org_id}
      bookable={me.bookable}
        avatarUrl={me.avatar_url}
    />
    <main className="mx-auto w-full min-w-0 max-w-4xl space-y-8 px-6 py-10 sm:px-8">
      <section className="rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface">
        <p className="pn-eyebrow text-pennie-sky">Admin</p>
        <h1 className="pn-h3 mt-2 text-pennie-beige">Slate admin</h1>
        <p className="mt-2 text-pennie-beige/75">
          <span className="font-semibold tabular-nums text-pennie-beige">
            {bookableAgents.length}
          </span>{" "}
          bookable of{" "}
          <span className="tabular-nums">{users.length}</span> agents ·{" "}
          <span className="tabular-nums">
            {watchedCount}/{bookableAgents.length}
          </span>{" "}
          calendars syncing
        </p>
      </section>

      {sp.synced && (
        <div className="rounded-md bg-[var(--pennie-green-wash)] px-5 py-4 text-sm text-fg">
          Salesforce sync complete. {sp.synced}.
        </div>
      )}
      {sp.sync_error && (
        <div
          role="alert"
          className="rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
        >
          Salesforce sync failed: {sp.sync_error}
        </div>
      )}

      {/* View as another user (admin only) */}
      {isAdmin && (
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">View as another user</h2>
        <p className="mb-3 text-xs text-fg-muted">
          See the app exactly as someone else does. While viewing as them, what
          you do happens as them, so be careful. A banner stays up the whole time
          with a way back to yourself.
        </p>
        {sp.imp_error && (
          <p role="alert" className="mb-3 text-sm text-error">
            {sp.imp_error}
          </p>
        )}
        <form action={startImpersonation} className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>Their email</label>
            <input
              name="email"
              type="email"
              required
              // #141: repopulate the typed email when a "view as" attempt failed,
              // so the admin doesn't have to retype it.
              defaultValue={sp.imp_email ?? ""}
              aria-label="Email of the user to view as"
              placeholder="agent@trypennie.com"
              className={`${inputCls} w-72`}
            />
          </div>
          <SubmitButton className={btnCls} pendingLabel="Switching…">
            View as them
          </SubmitButton>
        </form>
      </section>
      )}

      {/* Org default working hours (super admin only) */}
      {canEditDefaults && (
      <section className={cardCls}>
        <h2 className="mb-2 text-sm font-semibold">Default working hours</h2>
        <p className="mb-3 text-xs text-fg-muted">
          Applied when you click <strong>Use default hours</strong> on an agent.
          Each agent keeps their own home timezone; leads always see times in
          their own timezone.
        </p>
        <form action={setOrgDefaultHours} className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>Timezone</label>
            <input
              name="default_timezone"
              aria-label="Timezone"
              defaultValue={org.default_timezone}
              className={`${inputCls} w-44`}
            />
          </div>
          <div>
            <span className={labelCls}>Days</span>
            <div className="mt-1">
              <DayToggles
                namePrefix="dday_"
                isOn={(d) => org.default_weekdays.includes(d)}
              />
            </div>
          </div>
          <div>
            <label className={labelCls}>Start</label>
            <TimeField
              name="default_start"
              ariaLabel="Start"
              defaultValue={minutesToTime(org.default_start_minute)}
              className="mt-1"
            />
          </div>
          <div>
            <label className={labelCls}>End</label>
            <TimeField
              name="default_end"
              ariaLabel="End"
              round="up"
              defaultValue={minutesToTime(org.default_end_minute)}
              className="mt-1"
            />
          </div>
          <SubmitButton className={btnCls} pendingLabel="Saving…">
            Save default
          </SubmitButton>
        </form>
      </section>
      )}

      {/* Booker calendar layout (super admin only) */}
      {canEditDefaults && (
      <section className={cardCls}>
        <h2 className="mb-2 text-sm font-semibold">Booker calendar layout</h2>
        <p className="mb-3 text-xs text-fg-muted">
          Controls which calendar view leads see in the booker.
        </p>
        <form action={setOrgBookerLayout} className="flex flex-wrap items-end gap-4">
          <fieldset className="flex flex-wrap gap-4">
            <legend className={`${labelCls} mb-1`}>Booker calendar layout</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="booker_layout"
                value="strip"
                defaultChecked={normalizeBookerLayout(org.booker_layout) === "strip"}
                className="accent-pennie-sky"
              />
              Compact strip (next few days)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="booker_layout"
                value="month"
                defaultChecked={normalizeBookerLayout(org.booker_layout) === "month"}
                className="accent-pennie-sky"
              />
              Month grid
            </label>
          </fieldset>
          <SubmitButton className={btnCls} pendingLabel="Saving…">
            Save layout
          </SubmitButton>
        </form>
      </section>
      )}

      {/* Monitor alert settings (admin only) */}
      {isAdmin && (
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Alert settings</h2>
        <p className="mb-3 text-xs text-fg-muted">
          Tune how often the monitor alerts fire and which Slack channel they post
          to, without a deploy.
        </p>
        <a href="/admin/settings" className={btnSecondaryCls}>
          Open alert settings
        </a>
      </section>
      )}

      {/* Agents + working hours */}
      <section id="agents" className={cardCls}>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">
              Agents{" "}
              <span className="font-normal text-fg-muted tabular-nums">
                ({bookableAgents.length} bookable / {users.length})
              </span>
            </h2>
            <span
              className="inline-flex items-center gap-1.5 text-xs text-fg-muted tabular-nums"
              title="Bookable agents with a live Google Calendar push watch channel. A shortfall means those agents rely on the backup cron sync instead of push."
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  pushHealthy
                    ? "bg-pennie-green"
                    : watchedCount > 0
                      ? "bg-pennie-yellow"
                      : "bg-[var(--pennie-mercury)]"
                }`}
              />
              push {watchedCount}/{bookableAgents.length} watched
            </span>
          </div>
          {isAdmin && (
            <form action={syncSalesforceNow}>
              <SyncButton />
            </form>
          )}
        </div>
        {/* Per-lane cron liveness (#288), beside the push-health pill above. */}
        <div className="mb-4">
          <CronLaneHealth rows={laneHealth} unavailable={laneHealthUnavailable} />
        </div>
        {syncHealthRows.length > 0 && (
          <div className="mb-4">
            <SyncHealthPanel agents={syncHealthRows} />
          </div>
        )}
        <FilterForm action="/admin" className="mb-4 flex flex-wrap items-center gap-2">
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search name or email…"
            aria-label="Search by name or email"
            className={`${inputCls} w-56`}
          />
          <button className={btnSecondaryCls}>Search</button>

          <AutoSubmitSelect
            name="role"
            defaultValue={roleFilter}
            ariaLabel="Filter by role"
            className={filterCtl}
          >
            <option value="">All roles</option>
            {rolesPresent.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </AutoSubmitSelect>

          {teamOptions.length > 0 && (
            <AutoSubmitSelect
              name="team"
              defaultValue={teamFilter}
              ariaLabel="Filter by team"
              className={filterCtl}
            >
              <option value="">All teams</option>
              {teamOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </AutoSubmitSelect>
          )}

          {managerOptions.length > 0 && (
            <AutoSubmitSelect
              name="manager"
              defaultValue={managerFilter}
              ariaLabel="Filter by manager"
              className={filterCtl}
            >
              <option value="">All managers</option>
              {managerOptions.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </AutoSubmitSelect>
          )}

          <AutoSubmitSelect
            name="bookable"
            defaultValue={bookableFilter}
            ariaLabel="Filter by bookable"
            className={filterCtl}
          >
            <option value="">Any status</option>
            <option value="yes">Bookable</option>
            <option value="no">Not bookable</option>
          </AutoSubmitSelect>

          {hasFilter && (
            <InPlaceLink
              href="/admin"
              replace
              className="text-xs text-pennie-blue underline dark:text-pennie-sky"
            >
              clear
            </InPlaceLink>
          )}
          <span className="ml-auto text-xs text-fg-muted tabular-nums">
            {agentsPage.total === 0
              ? `showing 0 of ${users.length}`
              : `showing ${agentsPage.start}-${agentsPage.end} of ${agentsPage.total}${
                  agentsPage.total !== users.length ? ` (of ${users.length})` : ""
                }`}
          </span>
        </FilterForm>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border bg-[var(--bg-alt)] text-left text-xs text-fg-muted">
                <th className="px-4 py-2.5 font-semibold">Member</th>
                <th className="px-3 py-2.5 font-semibold">Role</th>
                <th className="px-3 py-2.5 font-semibold">Team</th>
                <th className="px-3 py-2.5 font-semibold">Manager</th>
                <th className="px-3 py-2.5 font-semibold">Bookable</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {agentsPage.items.map((u) => {
                const mgr = u.manager_id
                  ? users.find((x) => x.id === u.manager_id)
                  : null;
                return (
                  <tr key={u.id} className="transition-colors hover:bg-[var(--bg-alt)]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {u.avatar_url ? (
                          // eslint-disable-next-line @next/next/no-img-element -- external Google avatar; OpenNext/CF has no image loader
                          <img
                            src={u.avatar_url}
                            alt=""
                            referrerPolicy="no-referrer"
                            className="h-8 w-8 shrink-0 rounded-full object-cover"
                          />
                        ) : (
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pennie-navy text-[11px] font-semibold text-pennie-beige">
                            {(u.name ?? u.email).slice(0, 2).toUpperCase()}
                          </span>
                        )}
                        <div className="min-w-0">
                          <a
                            href={`/admin/agents/${u.id}`}
                            className="font-semibold text-fg hover:underline"
                          >
                            {u.name ?? u.email}
                          </a>
                          <p className="truncate text-xs text-fg-muted">
                            {u.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Pill variant={`role-${u.role}`}>{roleLabel(u.role)}</Pill>
                    </td>
                    <td className="px-3 py-3 text-fg-muted">
                      {attrToText(u.attributes?.debt_team) || "-"}
                    </td>
                    <td className="px-3 py-3 text-fg-muted">
                      {mgr ? (mgr.name ?? mgr.email) : "-"}
                    </td>
                    <td className="px-3 py-3">
                      {u.bookable ? (
                        <Pill variant="status-ok">Bookable</Pill>
                      ) : (
                        <span className="text-fg-muted">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <a
                        href={`/admin/agents/${u.id}`}
                        className="text-sm text-pennie-blue underline dark:text-pennie-sky"
                      >
                        Manage
                      </a>
                    </td>
                  </tr>
                );
              })}
              {agentsPage.items.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-sm text-fg-muted"
                  >
                    {users.length === 0
                      ? "No agents yet. Sync from Salesforce or sign in."
                      : "No agents match your search."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {agentsPage.pageCount > 1 && (
          <nav
            aria-label="Agent roster pages"
            className="mt-3 flex items-center justify-between text-sm"
          >
            {agentsPage.page > 1 ? (
              <InPlaceLink href={agentsPageHref(agentsPage.page - 1)} className={btnSecondaryCls}>
                Previous
              </InPlaceLink>
            ) : (
              <span className={`${btnSecondaryCls} pointer-events-none opacity-40`} aria-disabled="true">
                Previous
              </span>
            )}
            <span className="text-xs text-fg-muted tabular-nums">
              Page {agentsPage.page} of {agentsPage.pageCount}
            </span>
            {agentsPage.page < agentsPage.pageCount ? (
              <InPlaceLink href={agentsPageHref(agentsPage.page + 1)} className={btnSecondaryCls}>
                Next
              </InPlaceLink>
            ) : (
              <span className={`${btnSecondaryCls} pointer-events-none opacity-40`} aria-disabled="true">
                Next
              </span>
            )}
          </nav>
        )}
      </section>

      {/* Event types (admin only) */}
      {isAdmin && (
      <section className={cardCls}>
        <h2 className="mb-4 text-sm font-semibold">Event types</h2>
        <ul className="mb-4 space-y-1 text-sm">
          {eventTypes.map((e) => (
            <li key={e.id} className="text-fg tabular-nums">
              {e.name} · {e.duration_min}m · {e.min_notice_min}m notice ·{" "}
              {e.slot_interval_min}m grid
              {e.daily_cap ? ` · cap ${e.daily_cap}/day` : ""}
            </li>
          ))}
          {eventTypes.length === 0 && (
            <li className="text-fg-muted">None yet.</li>
          )}
        </ul>
        <form action={createEventType} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field name="name" label="Title (eventTitle)" defaultValue="Senior Loan Advisor Call" />
            <Field name="regal_type" label="Regal type slug" defaultValue="call" small />
            <Field name="duration_min" label="Duration (m)" defaultValue="30" small />
            <Field name="slot_interval_min" label="Grid (m)" defaultValue="15" small />
            <Field name="min_notice_min" label="Notice (m)" defaultValue="120" small />
            <Field name="buffer_after_min" label="Buffer after (m)" defaultValue="0" small />
            <Field name="daily_cap" label="Daily cap" defaultValue="" small />
          </div>
          <div>
            <label className={labelCls}>Description (shown to lead + sent to Regal)</label>
            <textarea
              name="description"
              rows={2}
              className={inputCls}
              placeholder="Twenty minutes with a senior advisor to confirm your income…"
            />
          </div>
          <SubmitButton className={btnCls} pendingLabel="Adding…">
            Add event type
          </SubmitButton>
        </form>
      </section>
      )}

      {/* Staffing depth (thin-tier early warning, #584) */}
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Staffing depth</h2>
        <p className="mb-3 text-xs text-fg-muted">
          See how many bookable agents can take each tier&rsquo;s bookings, so a tier
          resting on a single person is visible before it runs out of times.
        </p>
        <a href="/admin/tiers" className={btnSecondaryCls}>
          View staffing depth
        </a>
      </section>

      {/* Buckets (admin only) */}
      {isAdmin && (
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Buckets (round-robin pools)</h2>
        <p className="mb-4 text-xs text-fg-muted">
          Edit routing live. Changes apply without a deploy. Routing matches
          agents by attribute; leave all groups empty to pick members manually.
        </p>
        <div className="space-y-4">
          {buckets.map((b) => (
            <BucketForm
              key={b.id}
              bucket={b}
              eventTypes={eventTypes}
              users={users}
              memberIds={
                new Set(
                  members.filter((m) => m.bucket_id === b.id).map((m) => m.user_id),
                )
              }
              catalog={attrCatalog}
              eligibleCount={depthByBucketCode.get(b.code) ?? 0}
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
            users={users}
            memberIds={new Set()}
            catalog={attrCatalog}
          />
        </div>
      </section>
      )}

      {/* Look up any booking's history (beyond the recent list, #901) */}
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Look up a booking</h2>
        <p className="mb-3 text-xs text-fg-muted">
          Find any booking by attendee email, name, phone, or booking id to see
          its reschedule, cancel, and reassign history, including bookings older
          than the recent list below.
        </p>
        <BookingLookup />
      </section>

      {/* Recent routing (trace viewer) */}
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Recent routing</h2>
        <p className="mb-3 text-xs text-fg-muted">
          How the last {recent.length} bookings routed: agents considered, who
          was chosen, whether the fallback fired, and any manual reassignments.
        </p>
        <RecentRoutingTable rows={recent} users={users} />
      </section>

      {/* Reassign API key (admin only) */}
      {isAdmin && (
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Reassign API</h2>
        <p className="mb-3 text-xs text-fg-muted">
          Force a booking onto a specific owning advisor (the contact owner
          override). Send <code className="break-all">POST {appUrl()}/api/bookings/reassign</code> with
          a bearer token and a JSON body of <code>bookingId</code> and{" "}
          <code>agentEmail</code>.
        </p>
        <label className={labelCls}>Authorization key (Bearer)</label>
        <code className="mt-1 block break-all rounded-sm bg-[var(--pennie-wild-sand)] px-3 py-2 text-xs dark:bg-fg/10">
          {reassignApiKey() ||
            "not configured (set REASSIGN_API_KEY on the worker)"}
        </code>
      </section>
      )}

      {/* Webhooks (admin only) */}
      {isAdmin && (
      <section className={cardCls}>
        <h2 className="mb-2 text-sm font-semibold">Webhook endpoint</h2>
        <p className="mb-3 text-xs text-fg-muted">
          Slate POSTs booking.* events here. <strong>Regal</strong> format sends
          the Regal event shape with your API key as the Authorization header;{" "}
          <strong>Generic</strong> sends a signed <code>{"{event,data}"}</code>{" "}
          body (good for webhook.site).
        </p>
        {webhook && (
          <p className="mb-3 text-xs text-fg-muted">
            Current: <code className="break-all">{webhook.url}</code> · {webhook.format} ·{" "}
            {webhook.format === "regal"
              ? webhook.auth_header
                ? "API key stored"
                : "no API key set"
              : "signing secret stored"}
          </p>
        )}
        <form action={setWebhookEndpoint} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <label className={labelCls}>URL</label>
              <input
                name="url"
                defaultValue={webhook?.url ?? "https://events.regalvoice.com/events"}
                placeholder="https://events.regalvoice.com/events"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Format</label>
              <select
                name="format"
                aria-label="Format"
                defaultValue={webhook?.format ?? "regal"}
                className={inputCls}
              >
                <option value="regal">Regal</option>
                <option value="generic">Generic (signed)</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>
              Authorization header (Regal API key)
            </label>
            {/* #600: never render the stored key. It used to come down as this input's
                defaultValue, which put the live secret in the page HTML and on screen in
                plain text. Write only: blank leaves the saved key untouched. */}
            <input
              name="auth_header"
              type="password"
              autoComplete="off"
              defaultValue=""
              placeholder={
                webhook?.auth_header ? "Leave blank to keep the current key" : "Regal API key"
              }
              className={inputCls}
            />
            <p className="mt-1 text-xs text-fg-muted">
              {webhook?.auth_header
                ? "A key is saved. Leave this blank to keep it, or type a new one to replace it."
                : "No key saved yet. Regal deliveries will fail until one is set."}
            </p>
          </div>
          <SubmitButton className={btnCls} pendingLabel="Saving…">
            Save
          </SubmitButton>
        </form>
      </section>
      )}

      {/* Webhook deliveries (admin only) */}
      {isAdmin && (
        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Webhook deliveries</h2>
          <p className="mb-3 text-xs text-fg-muted">
            The last {deliveries.length} delivery attempts. Resend re-fires one
            immediately. Test bucket bookings are recorded as &ldquo;not sent&rdquo;:
            they never reach a downstream system, so they cannot be resent.
          </p>
          <form
            action={replayFailedWebhooks}
            className="mb-3 flex flex-wrap items-center gap-2"
          >
            <label htmlFor="replay-hours" className="text-xs text-fg-muted">
              Replay every failed delivery from the last
            </label>
            <select
              id="replay-hours"
              name="hours"
              defaultValue="24"
              className={`${inputCls} w-auto`}
            >
              <option value="2">2 hours</option>
              <option value="6">6 hours</option>
              <option value="24">24 hours</option>
              <option value="72">3 days</option>
              <option value="168">7 days</option>
            </select>
            <SubmitButton className={btnSecondaryCls} pendingLabel="Replaying…">
              Replay failed deliveries
            </SubmitButton>
          </form>
          {deliveries.length === 0 ? (
            <p className="text-sm text-fg-muted">No deliveries yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-fg-muted">
                  <tr>
                    <th className="py-1 pr-3 font-semibold">When</th>
                    <th className="py-1 pr-3 font-semibold">Event</th>
                    <th className="py-1 pr-3 font-semibold">Endpoint</th>
                    <th className="py-1 pr-3 font-semibold">Status</th>
                    <th className="py-1 pr-3 font-semibold">Tries</th>
                    <th className="py-1 font-semibold" />
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((d) => {
                    const view = deliveryDisplay(d);
                    return (
                      <tr key={d.id} className="border-t border-border align-top">
                        <td className="whitespace-nowrap py-1.5 pr-3 text-fg-muted tabular-nums">
                          {new Date(d.created_at).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="py-1.5 pr-3">{d.event}</td>
                        <td
                          className="max-w-[160px] truncate py-1.5 pr-3 text-fg-muted"
                          title={endpointUrl.get(d.endpoint_id) ?? ""}
                        >
                          {endpointUrl.get(d.endpoint_id) ?? "?"}
                        </td>
                        <td className="py-1.5 pr-3">
                          <Pill
                            title={view.hint ?? d.last_response ?? ""}
                            variant={view.variant}
                          >
                            {view.label}
                          </Pill>
                        </td>
                        <td className="py-1.5 pr-3 text-fg-muted tabular-nums">{d.attempts}</td>
                        <td className="py-1.5">
                          {view.resendable ? (
                            <form action={resendWebhookDelivery}>
                              <input type="hidden" name="delivery_id" value={d.id} />
                              <SubmitButton className={btnSecondaryCls} pendingLabel="Resending…">
                                Resend
                              </SubmitButton>
                            </form>
                          ) : (
                            // resendDelivery() refuses a suppressed row, so a button
                            // here would be a no-op that looks like an action.
                            <span className="text-xs text-fg-muted">Not resendable</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Audit log (admin only) */}
      {isAdmin && (
        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Audit log</h2>
          <p className="mb-3 text-xs text-fg-muted">
            The last {auditEntries.length} privileged actions (role changes and
            agent edits).
          </p>
          {auditEntries.length === 0 ? (
            <p className="text-sm text-fg-muted">No activity yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-fg-muted">
                  <tr>
                    <th className="py-1 pr-3 font-semibold">When</th>
                    <th className="py-1 pr-3 font-semibold">Who</th>
                    <th className="py-1 pr-3 font-semibold">Action</th>
                    <th className="py-1 pr-3 font-semibold">Target</th>
                    <th className="py-1 font-semibold">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map((a) => (
                    <tr key={a.id} className="border-t border-border align-top">
                      <td className="whitespace-nowrap py-1.5 pr-3 text-fg-muted tabular-nums">
                        {new Date(a.created_at).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="py-1.5 pr-3">{nameOf(a.actor_id)}</td>
                      <td className="py-1.5 pr-3">{AUDIT_LABEL[a.action] ?? a.action}</td>
                      <td className="py-1.5 pr-3">{nameOf(a.target_id)}</td>
                      <td className="py-1.5 text-fg-muted">
                        {a.action === "role.set"
                          ? `${String(a.details.from)} → ${String(a.details.to)}`
                          : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
    </>
  );
}

function attrToText(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v === undefined || v === null) return "";
  return String(v);
}

function minutesToTime(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function Field({
  name,
  label,
  defaultValue,
  small,
}: {
  name: string;
  label: string;
  defaultValue: string;
  small?: boolean;
}) {
  return (
    <div>
      <label className={labelCls}>
        {label}
      </label>
      <input
        name={name}
        aria-label={label}
        defaultValue={defaultValue}
        className={`${inputCls} ${small ? "w-24" : "w-48"}`}
      />
    </div>
  );
}
