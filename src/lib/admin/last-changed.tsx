/**
 * "Last changed by X on Y" for a settings panel (#1748). Local helpers on the old
 * single /admin/settings page; those settings are three routes now, so they moved
 * out rather than being copied into each one.
 */
export function shortStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "at an unknown time";
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric" });
}

export function lastChangedLine(
  latest: { updated_at: string; updated_by: string | null } | null,
  nameById: Map<string, string>,
): string {
  if (!latest) return "Never changed; using built-in defaults.";
  const who = latest.updated_by ? (nameById.get(latest.updated_by) ?? "someone") : "someone";
  const when = new Date(latest.updated_at).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `Last changed by ${who} at ${when}.`;
}
