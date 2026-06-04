import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { liveWatchCount } from "@/lib/google/watch-health";
import {
  createBucket,
  createEventType,
  setAgentAttributes,
  setBookable,
  setOrgDefaultHours,
  setWebhookEndpoint,
  setWorkingHours,
  syncSalesforceNow,
  useDefaultHours,
} from "@/app/admin/actions";
import type {
  Bucket,
  BucketMember,
  EventType,
  Organization,
  User,
  WebhookEndpoint,
} from "@/lib/db/types";

export const dynamic = "force-dynamic";

// Wraps the pure counter with the current clock at module scope — calling
// Date.now() directly in the component render trips react-hooks/purity.
function watchedNow(agents: User[]): number {
  return liveWatchCount(agents, Date.now());
}

const labelCls = "block text-xs font-medium text-neutral-500";
const inputCls =
  "mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm";
const cardCls = "rounded-lg border border-neutral-200 p-5";
const btnCls =
  "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800";

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
  const [usersRes, eventTypesRes, bucketsRes, membersRes, webhookRes, orgRes] =
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
    ]);

  const org = orgRes.data as Organization;
  const users = (usersRes.data ?? []) as User[];
  const eventTypes = (eventTypesRes.data ?? []) as EventType[];
  const buckets = (bucketsRes.data ?? []) as Bucket[];
  const members = (membersRes.data ?? []) as BucketMember[];
  const webhook = webhookRes.data as WebhookEndpoint | null;

  // Push health: how many bookable agents have a live (non-expired) Google
  // watch channel. A shortfall means external calendar edits for those agents
  // only reach the cache via the 1-min cron backstop, not push.
  const bookableAgents = users.filter((u) => u.bookable);
  const watchedCount = watchedNow(bookableAgents);
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
        <h2 className="mb-4 text-sm font-semibold">Buckets (round-robin pools)</h2>
        <ul className="mb-4 space-y-1 text-sm">
          {buckets.map((b) => {
            const count = members.filter((m) => m.bucket_id === b.id).length;
            const et = eventTypes.find((e) => e.id === b.event_type_id);
            return (
              <li key={b.id} className="text-neutral-700">
                <code className="rounded bg-neutral-100 px-1">{b.code}</code>{" "}
                {b.name} · {et?.name ?? "?"} · {count} manual
                {Object.keys(b.criteria ?? {}).length
                  ? ` · routes: ${Object.entries(b.criteria)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(", ")}`
                  : ""}
              </li>
            );
          })}
          {buckets.length === 0 && <li className="text-neutral-400">None yet.</li>}
        </ul>
        <form action={createBucket} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field name="code" label="Code (xbc)" defaultValue="411" small />
            <Field name="name" label="Name" defaultValue="Debt consolidation" />
            <div>
              <label className={labelCls}>Event type</label>
              <select name="event_type_id" className={inputCls} required>
                {eventTypes.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field name="crit_debt_team" label="Route: debt team" defaultValue="" small />
            <Field name="crit_backend_service" label="Route: backend" defaultValue="" small />
            <Field name="crit_role" label="Route: role" defaultValue="" small />
            <div>
              <label className={labelCls}>Route: legal elig.</label>
              <select name="crit_legal_eligible" defaultValue="" className={inputCls}>
                <option value="">any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-neutral-400">
            Routing matches agents by attribute (e.g. debt team{" "}
            <code>ultra_high</code>). Leave blank to pick members manually below.
          </p>
          <div>
            <label className={labelCls}>Members (optional manual additions)</label>
            <div className="mt-1 flex flex-wrap gap-3">
              {users.map((u) => (
                <label key={u.id} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" name="members" value={u.id} />
                  {u.name ?? u.email}
                </label>
              ))}
            </div>
          </div>
          <button className={btnCls}>Create bucket</button>
        </form>
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
