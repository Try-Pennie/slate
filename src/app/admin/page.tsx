import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { deriveAttributeCatalog } from "@/lib/availability/catalog";
import { matchesCriteria } from "@/lib/availability/match";
import { appUrl, reassignApiKey } from "@/lib/env";
import {
  createBucket,
  createEventType,
  replayFailedWebhooks,
  resendWebhookDelivery,
  setAgentAttributes,
  setBookable,
  setOrgDefaultHours,
  setUserRole,
  setWebhookEndpoint,
  setWorkingHours,
  syncSalesforceNow,
  updateBucket,
  useDefaultHours,
} from "@/app/admin/actions";
import { canManageAgents, canEditOrgSettings, ROLES } from "@/lib/auth/roles";
import { AppHeader } from "@/components/AppHeader";
import { labelCls, inputCls, cardCls, btnCls, btnSecondaryCls } from "@/components/ui/styles";
import { Pill } from "@/components/ui/Pill";
import type {
  AuditEntry,
  Booking,
  Bucket,
  BucketMember,
  Criteria,
  EventType,
  Organization,
  RoutingTrace,
  User,
  WebhookDelivery,
  WebhookEndpoint,
} from "@/lib/db/types";

type DeliveryRow = Pick<
  WebhookDelivery,
  "id" | "endpoint_id" | "event" | "status" | "attempts" | "last_response" | "created_at"
>;

const AUDIT_LABEL: Record<string, string> = {
  "role.set": "changed role",
  "agent.hours": "set hours",
  "agent.use_default_hours": "applied default hours",
  "agent.bookable": "set bookable",
  "agent.attributes": "set attributes",
};

type TraceRow = Pick<
  Booking,
  | "id"
  | "attendee_name"
  | "attendee_email"
  | "attendee_phone"
  | "starts_at"
  | "assigned_user_id"
> & { routing_trace: RoutingTrace | null };

export const dynamic = "force-dynamic";

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

/** Create/edit form for one bucket (shared between the list rows and "new"). */
function BucketForm({
  bucket,
  eventTypes,
  users,
  memberIds,
  catalog,
}: {
  bucket?: Bucket;
  eventTypes: EventType[];
  users: User[];
  memberIds: Set<string>;
  catalog: Record<string, string[]>;
}) {
  const editing = !!bucket;
  const eligibleCount = users.filter(
    (u) =>
      u.bookable &&
      (memberIds.has(u.id) || matchesCriteria(u.attributes, bucket?.criteria ?? {})),
  ).length;
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
      <button className={btnCls}>{editing ? "Save bucket" : "Create bucket"}</button>
    </form>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; bookable?: string }>;
}) {
  const sp = await searchParams;
  const query = (sp.q ?? "").trim().toLowerCase();
  const bookableOnly = sp.bookable === "1";
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canManageAgents(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need a manager or admin account to manage Slate.
      </main>
    );
  }
  // Managers manage the agent roster; only admins see org/app config.
  const isAdmin = canEditOrgSettings(me.role);

  const db = supabaseAdmin();
  const [usersRes, eventTypesRes, bucketsRes, membersRes, webhookRes, orgRes, calsRes, recentRes] =
    await Promise.all([
      db.from("users").select("*").eq("org_id", me.org_id),
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
      db.from("agent_calendars").select("user_id, watch_expiration"),
      db
        .from("bookings")
        .select(
          "id, attendee_name, attendee_email, attendee_phone, starts_at, assigned_user_id, routing_trace",
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
  const webhook = webhookRes.data as WebhookEndpoint | null;

  // Routing trace viewer: recent bookings + how each one routed.
  const recent = (recentRes.data ?? []) as TraceRow[];
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
        .select("id, endpoint_id, event, status, attempts, last_response, created_at")
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
  const bookableAgents = users.filter((u) => u.bookable);
  const watchedCount = bookableAgents.filter((u) => watchedUserIds.has(u.id)).length;
  const pushHealthy =
    bookableAgents.length > 0 && watchedCount === bookableAgents.length;

  const visibleAgents = users.filter((u) => {
    if (bookableOnly && !u.bookable) return false;
    if (!query) return true;
    const hay = `${u.name ?? ""} ${u.email} ${u.role} ${attrToText(
      u.attributes?.debt_team,
    )} ${attrToText(u.attributes?.role)} ${attrToText(
      u.attributes?.backend_service,
    )}`.toLowerCase();
    return hay.includes(query);
  });

  return (
    <>
    <AppHeader email={me.email} role={me.role} active="admin" />
    <main className="mx-auto w-full min-w-0 max-w-4xl space-y-8 p-8">
      <h1 className="text-xl font-semibold tracking-tight">Slate admin</h1>

      {/* Org default working hours (admin only) */}
      {isAdmin && (
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
          <div className="flex gap-1">
            {[
              [1, "M"],
              [2, "T"],
              [3, "W"],
              [4, "T"],
              [5, "F"],
              [6, "S"],
              [7, "S"],
            ].map(([d, lbl]) => (
              <label
                key={d}
                className="flex flex-col items-center text-xs text-fg-muted"
              >
                {lbl}
                <input
                  type="checkbox"
                  name={`dday_${d}`}
                  defaultChecked={org.default_weekdays.includes(Number(d))}
                  className="accent-pennie-sky"
                />
              </label>
            ))}
          </div>
          <div>
            <label className={labelCls}>Start</label>
            <input
              name="default_start"
              type="time"
              aria-label="Start"
              defaultValue={minutesToTime(org.default_start_minute)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>End</label>
            <input
              name="default_end"
              type="time"
              aria-label="End"
              defaultValue={minutesToTime(org.default_end_minute)}
              className={inputCls}
            />
          </div>
          <button className={btnCls}>Save default</button>
        </form>
      </section>
      )}

      {/* Agents + working hours */}
      <section className={cardCls}>
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
              <button className={btnSecondaryCls}>
                Sync from Salesforce
              </button>
            </form>
          )}
        </div>
        <form method="get" className="mb-4 flex items-center gap-3">
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search name, email, team…"
            className={`${inputCls} w-64`}
          />
          <label className="flex items-center gap-1 text-xs text-fg-muted">
            <input
              type="checkbox"
              name="bookable"
              value="1"
              defaultChecked={bookableOnly}
              className="accent-pennie-sky"
            />
            bookable only
          </label>
          <button className={btnSecondaryCls}>
            Search
          </button>
          {(query || bookableOnly) && (
            <a
              href="/admin"
              className="text-xs text-pennie-blue underline dark:text-pennie-sky"
            >
              clear
            </a>
          )}
          <span className="text-xs text-fg-muted tabular-nums">
            showing {visibleAgents.length} of {users.length}
          </span>
        </form>
        <div className="space-y-5">
          {visibleAgents.map((u) => (
            <div key={u.id} className="border-t border-border pt-4 first:border-0 first:pt-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold">{u.name ?? u.email}</span>
                  <Pill variant={`role-${u.role}`}>{u.role}</Pill>
                  <span className="text-xs text-fg-muted">
                    {[
                      attrToText(u.attributes?.role),
                      attrToText(u.attributes?.debt_team),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isAdmin && (
                    <form action={setUserRole} className="flex items-center gap-1">
                      <input type="hidden" name="user_id" value={u.id} />
                      <select
                        name="role"
                        aria-label={`Role for ${u.name ?? u.email}`}
                        defaultValue={u.role}
                        className="rounded-sm border border-border bg-surface px-1.5 py-1 text-xs text-fg"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <button className={btnSecondaryCls}>
                        Set role
                      </button>
                    </form>
                  )}
                  <form action={useDefaultHours}>
                    <input type="hidden" name="user_id" value={u.id} />
                    <button className={btnSecondaryCls}>
                      Use default hours
                    </button>
                  </form>
                  <form action={setBookable}>
                    <input type="hidden" name="user_id" value={u.id} />
                    <input
                      type="hidden"
                      name="bookable"
                      value={u.bookable ? "false" : "true"}
                    />
                    <button
                      className={`inline-flex h-6 items-center rounded-pill border px-2 text-[13px] font-semibold leading-none ${
                        u.bookable
                          ? "border-transparent bg-[var(--pennie-green-wash)] text-pennie-graphite"
                          : "border-[var(--pennie-mercury)] text-fg-muted"
                      }`}
                    >
                      {u.bookable ? "Bookable ✓" : "Not bookable"}
                    </button>
                  </form>
                </div>
              </div>
              {u.bookable && (
                <>
              <form
                action={setWorkingHours}
                className="mt-3 flex flex-wrap items-end gap-3"
              >
                <input type="hidden" name="user_id" value={u.id} />
                <div>
                  <label className={labelCls}>Timezone (agent home tz)</label>
                  <input
                    name="timezone"
                    aria-label="Timezone (agent home tz)"
                    defaultValue={org.default_timezone}
                    className={`${inputCls} w-44`}
                  />
                </div>
                <div className="flex gap-1">
                  {[
                    [1, "M"],
                    [2, "T"],
                    [3, "W"],
                    [4, "T"],
                    [5, "F"],
                    [6, "S"],
                    [7, "S"],
                  ].map(([d, lbl]) => (
                    <label
                      key={d}
                      className="flex flex-col items-center text-xs text-fg-muted"
                    >
                      {lbl}
                      <input
                        type="checkbox"
                        name={`day_${d}`}
                        defaultChecked={Number(d) <= 5}
                        className="accent-pennie-sky"
                      />
                    </label>
                  ))}
                </div>
                <div>
                  <label className={labelCls}>Start</label>
                  <input
                    name="start"
                    type="time"
                    aria-label="Start"
                    defaultValue="09:00"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>End</label>
                  <input
                    name="end"
                    type="time"
                    aria-label="End"
                    defaultValue="17:00"
                    className={inputCls}
                  />
                </div>
                <button className={btnCls}>Save hours</button>
              </form>
              <form
                action={setAgentAttributes}
                className="mt-2 flex flex-wrap items-end gap-3"
              >
                <input type="hidden" name="user_id" value={u.id} />
                <div>
                  <label className={labelCls}>Debt team(s)</label>
                  <input
                    name="debt_team"
                    defaultValue={attrToText(u.attributes?.debt_team)}
                    placeholder="ultra_high, very_high"
                    className={`${inputCls} w-44`}
                  />
                </div>
                <div>
                  <label className={labelCls}>Backend</label>
                  <input
                    name="backend_service"
                    defaultValue={attrToText(u.attributes?.backend_service)}
                    placeholder="achieve"
                    className={`${inputCls} w-28`}
                  />
                </div>
                <div>
                  <label className={labelCls}>Role</label>
                  <input
                    name="agent_role"
                    defaultValue={attrToText(u.attributes?.role)}
                    placeholder="sales_agent"
                    className={`${inputCls} w-32`}
                  />
                </div>
                <div>
                  <label className={labelCls}>Legal eligible</label>
                  <select
                    name="legal_eligible"
                    aria-label="Legal eligible"
                    defaultValue={
                      u.attributes?.legal_eligible === true
                        ? "true"
                        : u.attributes?.legal_eligible === false
                          ? "false"
                          : ""
                    }
                    className={inputCls}
                  >
                    <option value="">Not set</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </div>
                <button className={btnCls}>Save attributes</button>
              </form>
                </>
              )}
            </div>
          ))}
          {visibleAgents.length === 0 && (
            <p className="text-sm text-fg-muted">
              {users.length === 0
                ? "No agents yet. Sync from Salesforce or sign in."
                : "No agents match your search."}
            </p>
          )}
        </div>
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
          <button className={btnCls}>Add event type</button>
        </form>
      </section>
      )}

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

      {/* Recent routing (trace viewer) */}
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Recent routing</h2>
        <p className="mb-3 text-xs text-fg-muted">
          How the last {recent.length} bookings routed: agents considered, who
          was chosen, whether the fallback fired, and any manual reassignments.
        </p>
        {recent.length === 0 ? (
          <p className="text-sm text-fg-muted">No bookings yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-fg-muted">
                <tr>
                  <th className="py-1 pr-3 font-semibold">When</th>
                  <th className="py-1 pr-3 font-semibold">Lead</th>
                  <th className="py-1 pr-3 font-semibold">Bucket</th>
                  <th className="py-1 pr-3 font-semibold">Routed to</th>
                  <th className="py-1 font-semibold">Trace</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((b) => {
                  const t = b.routing_trace;
                  const lead =
                    b.attendee_name || b.attendee_email || b.attendee_phone || "(none)";
                  return (
                    <tr key={b.id} className="border-t border-border align-top">
                      <td className="whitespace-nowrap py-1.5 pr-3 text-fg-muted tabular-nums">
                        {new Date(b.starts_at).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="py-1.5 pr-3">{lead}</td>
                      <td className="py-1.5 pr-3 text-fg-muted">{t?.bucket_code ?? "?"}</td>
                      <td className="py-1.5 pr-3 font-semibold">{nameOf(b.assigned_user_id)}</td>
                      <td className="py-1.5 text-fg-muted">
                        {t ? (
                          <div className="space-y-0.5">
                            <div>
                              {t.considered.length} considered
                              {t.fallback_applied ? " · fallback used" : ""}
                            </div>
                            {(t.reassignments ?? []).map((r, i) => (
                              <div key={i} className="text-pennie-blue dark:text-pennie-sky">
                                reassigned {nameOf(r.from)} → {nameOf(r.to)}
                              </div>
                            ))}
                          </div>
                        ) : (
                          "no trace"
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
            <input
              name="auth_header"
              defaultValue={webhook?.auth_header ?? ""}
              placeholder="Regal API key"
              className={inputCls}
            />
          </div>
          <button className={btnCls}>Save</button>
        </form>
      </section>
      )}

      {/* Webhook deliveries (admin only) */}
      {isAdmin && (
        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Webhook deliveries</h2>
          <p className="mb-3 text-xs text-fg-muted">
            The last {deliveries.length} delivery attempts. Resend re-fires one
            immediately.
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
            <button className={btnSecondaryCls}>Replay failed deliveries</button>
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
                  {deliveries.map((d) => (
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
                          title={d.last_response ?? ""}
                          variant={
                            d.status === "success"
                              ? "status-ok"
                              : d.status === "failed"
                                ? "status-error"
                                : "status-pending"
                          }
                        >
                          {d.status}
                        </Pill>
                      </td>
                      <td className="py-1.5 pr-3 text-fg-muted tabular-nums">{d.attempts}</td>
                      <td className="py-1.5">
                        <form action={resendWebhookDelivery}>
                          <input type="hidden" name="delivery_id" value={d.id} />
                          <button className={btnSecondaryCls}>
                            Resend
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
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
