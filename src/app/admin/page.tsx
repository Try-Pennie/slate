import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { deriveAttributeCatalog } from "@/lib/availability/catalog";
import { matchesCriteria } from "@/lib/availability/match";
import { appUrl, reassignApiKey } from "@/lib/env";
import {
  createBucket,
  createEventType,
  setAgentAttributes,
  setBookable,
  setOrgDefaultHours,
  setWebhookEndpoint,
  setWorkingHours,
  syncSalesforceNow,
  updateBucket,
  useDefaultHours,
} from "@/app/admin/actions";
import type {
  Bucket,
  BucketMember,
  Criteria,
  EventType,
  Organization,
  User,
  WebhookEndpoint,
} from "@/lib/db/types";

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

const labelCls = "block text-xs font-medium text-neutral-500";
const inputCls =
  "mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm";
const cardCls = "rounded-lg border border-neutral-200 p-5";
const btnCls =
  "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800";

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
      <p className="mt-1 text-xs text-neutral-400">
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
            <code className="rounded bg-neutral-100 px-1 text-xs">{key}</code>
            {catalog[key].map((v) => (
              <label key={v} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  name={`crit_${key}`}
                  value={v}
                  defaultChecked={selected.has(v)}
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
      className="space-y-3 rounded-md border border-neutral-200 p-3"
    >
      {editing && <input type="hidden" name="bucket_id" value={bucket.id} />}
      {editing && (
        <p
          className={`text-xs ${eligibleCount === 0 ? "text-amber-600" : "text-neutral-400"}`}
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
          <input name="code" defaultValue={bucket?.code ?? ""} className={`${inputCls} w-28`} required />
        </div>
        <div>
          <label className={labelCls}>Name</label>
          <input name="name" defaultValue={bucket?.name ?? ""} className={inputCls} required />
        </div>
        <div>
          <label className={labelCls}>Event type</label>
          <select
            name="event_type_id"
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
            defaultValue={bucket?.routing_form_id ?? ""}
            className={`${inputCls} w-44`}
          />
        </div>
        <div>
          <label className={labelCls}>Fallback agent (when none match)</label>
          <select
            name="fallback_user_id"
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
  if (me.role !== "admin") {
    return (
      <main className="p-8 text-sm text-neutral-500">
        You need an admin account to manage Slate.
      </main>
    );
  }

  const db = supabaseAdmin();
  const [usersRes, eventTypesRes, bucketsRes, membersRes, webhookRes, orgRes, calsRes] =
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
    ]);

  const org = orgRes.data as Organization;
  const users = (usersRes.data ?? []) as User[];
  const eventTypes = (eventTypesRes.data ?? []) as EventType[];
  const buckets = (bucketsRes.data ?? []) as Bucket[];
  const members = (membersRes.data ?? []) as BucketMember[];
  // Routing editor offers only attribute keys/values that exist on agents.
  const attrCatalog = deriveAttributeCatalog(users.map((u) => u.attributes));
  const webhook = webhookRes.data as WebhookEndpoint | null;

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
    <main className="mx-auto max-w-4xl space-y-8 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Slate admin</h1>
          <p className="text-sm text-neutral-500">{me.email}</p>
        </div>
        <a href="/login" className={btnCls}>
          Connect / reconnect Google
        </a>
      </header>

      {/* Org default working hours */}
      <section className={cardCls}>
        <h2 className="mb-2 text-sm font-semibold">Default working hours</h2>
        <p className="mb-3 text-xs text-neutral-500">
          Applied when you click <strong>Use default hours</strong> on an agent.
          Each agent keeps their own home timezone; leads always see times in
          their own timezone.
        </p>
        <form action={setOrgDefaultHours} className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>Timezone</label>
            <input
              name="default_timezone"
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
                className="flex flex-col items-center text-[10px] text-neutral-500"
              >
                {lbl}
                <input
                  type="checkbox"
                  name={`dday_${d}`}
                  defaultChecked={org.default_weekdays.includes(Number(d))}
                />
              </label>
            ))}
          </div>
          <div>
            <label className={labelCls}>Start</label>
            <input
              name="default_start"
              type="time"
              defaultValue={minutesToTime(org.default_start_minute)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>End</label>
            <input
              name="default_end"
              type="time"
              defaultValue={minutesToTime(org.default_end_minute)}
              className={inputCls}
            />
          </div>
          <button className={btnCls}>Save default</button>
        </form>
      </section>

      {/* Agents + working hours */}
      <section className={cardCls}>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">
              Agents{" "}
              <span className="font-normal text-neutral-400">
                ({bookableAgents.length} bookable / {users.length})
              </span>
            </h2>
            <span
              className="inline-flex items-center gap-1.5 text-xs text-neutral-500"
              title="Bookable agents with a live Google Calendar push watch channel. A shortfall means those agents rely on the backup cron sync instead of push."
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  pushHealthy
                    ? "bg-green-500"
                    : watchedCount > 0
                      ? "bg-amber-500"
                      : "bg-neutral-300"
                }`}
              />
              push {watchedCount}/{bookableAgents.length} watched
            </span>
          </div>
          <form action={syncSalesforceNow}>
            <button className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:border-neutral-500">
              Sync from Salesforce
            </button>
          </form>
        </div>
        <form method="get" className="mb-4 flex items-center gap-3">
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search name, email, team…"
            className={`${inputCls} w-64`}
          />
          <label className="flex items-center gap-1 text-xs text-neutral-500">
            <input
              type="checkbox"
              name="bookable"
              value="1"
              defaultChecked={bookableOnly}
            />
            bookable only
          </label>
          <button className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:border-neutral-500">
            Search
          </button>
          {(query || bookableOnly) && (
            <a href="/admin" className="text-xs text-neutral-400 underline">
              clear
            </a>
          )}
          <span className="text-xs text-neutral-400">
            showing {visibleAgents.length} of {users.length}
          </span>
        </form>
        <div className="space-y-5">
          {visibleAgents.map((u) => (
            <div key={u.id} className="border-t border-neutral-100 pt-4 first:border-0 first:pt-0">
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <span className="font-medium">{u.name ?? u.email}</span>{" "}
                  <span className="text-neutral-400">
                    · {attrToText(u.attributes?.role) || u.role}
                    {attrToText(u.attributes?.debt_team)
                      ? ` · ${attrToText(u.attributes?.debt_team)}`
                      : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <form action={useDefaultHours}>
                    <input type="hidden" name="user_id" value={u.id} />
                    <button className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-600 hover:border-neutral-400">
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
                      className={`rounded-md border px-2 py-1 text-xs ${
                        u.bookable
                          ? "border-green-300 text-green-700"
                          : "border-neutral-300 text-neutral-500"
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
                      className="flex flex-col items-center text-[10px] text-neutral-500"
                    >
                      {lbl}
                      <input
                        type="checkbox"
                        name={`day_${d}`}
                        defaultChecked={Number(d) <= 5}
                      />
                    </label>
                  ))}
                </div>
                <div>
                  <label className={labelCls}>Start</label>
                  <input
                    name="start"
                    type="time"
                    defaultValue="09:00"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>End</label>
                  <input
                    name="end"
                    type="time"
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
            <p className="text-sm text-neutral-400">
              {users.length === 0
                ? "No agents yet. Sync from Salesforce or sign in."
                : "No agents match your search."}
            </p>
          )}
        </div>
      </section>

      {/* Event types */}
      <section className={cardCls}>
        <h2 className="mb-4 text-sm font-semibold">Event types</h2>
        <ul className="mb-4 space-y-1 text-sm">
          {eventTypes.map((e) => (
            <li key={e.id} className="text-neutral-700">
              {e.name} · {e.duration_min}m · {e.min_notice_min}m notice ·{" "}
              {e.slot_interval_min}m grid
              {e.daily_cap ? ` · cap ${e.daily_cap}/day` : ""}
            </li>
          ))}
          {eventTypes.length === 0 && (
            <li className="text-neutral-400">None yet.</li>
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

      {/* Buckets */}
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Buckets (round-robin pools)</h2>
        <p className="mb-4 text-xs text-neutral-400">
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
            <p className="text-sm text-neutral-400">None yet.</p>
          )}
        </div>
        <div className="mt-6">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
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

      {/* Reassign API key */}
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Reassign API</h2>
        <p className="mb-3 text-xs text-neutral-500">
          Force a booking onto a specific owning advisor (the contact owner
          override). Send <code>POST {appUrl()}/api/bookings/reassign</code> with
          a bearer token and a JSON body of <code>bookingId</code> and{" "}
          <code>agentEmail</code>.
        </p>
        <label className={labelCls}>Authorization key (Bearer)</label>
        <code className="mt-1 block overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs">
          {reassignApiKey() ||
            "not configured (set REASSIGN_API_KEY on the worker)"}
        </code>
      </section>

      {/* Webhooks */}
      <section className={cardCls}>
        <h2 className="mb-2 text-sm font-semibold">Webhook endpoint</h2>
        <p className="mb-3 text-xs text-neutral-500">
          Slate POSTs booking.* events here. <strong>Regal</strong> format sends
          the Regal event shape with your API key as the Authorization header;{" "}
          <strong>Generic</strong> sends a signed <code>{"{event,data}"}</code>{" "}
          body (good for webhook.site).
        </p>
        {webhook && (
          <p className="mb-3 text-xs text-neutral-600">
            Current: <code>{webhook.url}</code> · {webhook.format} ·{" "}
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
    </main>
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
      <label className="block text-xs font-medium text-neutral-500">
        {label}
      </label>
      <input
        name={name}
        defaultValue={defaultValue}
        className={`mt-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm ${
          small ? "w-24" : "w-48"
        }`}
      />
    </div>
  );
}
