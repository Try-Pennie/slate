import { createBucket, updateBucket } from "@/app/admin/actions";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnCls, inputCls, labelCls } from "@/components/ui/styles";
import type { Bucket, Criteria, EventType, User } from "@/lib/db/types";

/**
 * The routing pool editor (#1748). Both of these were local helpers on the old
 * single page /admin; Buckets is its own route now, so they moved out with it
 * rather than being copied.
 */
/** Checkbox grid of routable attribute keys/values, derived from live agents. */
export function CriteriaEditor({
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

export function BucketForm({
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
