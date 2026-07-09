"use client";

import { useEffect, useState } from "react";

interface SettingsSaveNoticeProps {
  /** Set when the save action redirected back with ?ok=1. */
  ok: boolean;
  /** The ?error= message when the save action rejected, else undefined. */
  error?: string;
}

/**
 * #636: the save outcome arrives as a ?ok=/?error= query param (post-redirect-get
 * from setMonitorSettings). Rendering the banner straight off the param gave it
 * no role=status (so screen-reader admins heard nothing after a save) and left
 * the param in the URL, so a reload or a copied/bookmarked link re-showed a
 * stale "saved" without anything having been saved.
 *
 * This captures the outcome once into state (so the banner stays visible), then
 * strips the param from the URL on mount via history.replaceState. A reload or
 * copied URL then carries no param and shows no banner.
 */
export function SettingsSaveNotice({ ok, error }: SettingsSaveNoticeProps) {
  const [notice] = useState<{ kind: "ok" | "error"; message: string } | null>(
    error
      ? { kind: "error", message: error }
      : ok
        ? { kind: "ok", message: "Alert settings saved." }
        : null,
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("ok") || url.searchParams.has("error")) {
      url.searchParams.delete("ok");
      url.searchParams.delete("error");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  }, []);

  if (!notice) return null;

  if (notice.kind === "error") {
    return (
      <div
        role="alert"
        className="rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
      >
        {notice.message}
      </div>
    );
  }

  return (
    <div
      role="status"
      className="rounded-md bg-[var(--pennie-green-wash)] px-5 py-4 text-sm text-fg"
    >
      {notice.message}
    </div>
  );
}
