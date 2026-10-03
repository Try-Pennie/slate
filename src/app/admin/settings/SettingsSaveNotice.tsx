"use client";

import { useEffect, useState } from "react";
import { OUTCOME_PARAMS } from "@/lib/admin/save-outcomes";

type Notice = { kind: "ok" | "error"; message: string };

interface SettingsSaveNoticeProps {
  /** Set when the save action redirected back with ?ok=1. */
  ok: boolean;
  /** The ?error= message when the save action rejected, else undefined. */
  error?: string;
  /**
   * What was saved, in this page's own words (#1922).
   *
   * REQUIRED, and that is the point. It used to be the hardcoded string "Alert
   * settings saved." for every page that mounted this, so saving a booking reason
   * confirmed that your ALERT settings had been saved. Measured on a running
   * server: `/admin/booking-reasons?ok=1` and `/admin/buckets?ok=1` both said it.
   *
   * No default, so a page cannot mount this and inherit somebody else's
   * sentence. `tsc` names every call site instead.
   */
  saved: string;
}

/**
 * #636: the save outcome arrives as a ?ok=/?error= query param (post-redirect-get
 * from setMonitorSettings). Rendering the banner straight off the param gave it
 * no role=status (so screen-reader admins heard nothing after a save) and left
 * the param in the URL, so a reload or a copied/bookmarked link re-showed a
 * stale "saved" without anything having been saved.
 *
 * This captures each outcome into state (so the banner stays visible), then
 * strips the param from the URL via history.replaceState. A reload or
 * copied URL then carries no param and shows no banner.
 */
export function SettingsSaveNotice({ ok, error, saved }: SettingsSaveNoticeProps) {
  const incoming: Notice | null = error
    ? { kind: "error", message: error }
    : ok
      ? { kind: "ok", message: saved }
      : null;
  const [notice, setNotice] = useState<Notice | null>(incoming);

  // #3100: a SECOND save on the same page re-renders this in place rather than
  // mounting it again, so the state captured on mount has to give way to a new
  // outcome. Found by the first browser run: stopping online booking and then
  // starting it again left the notice reading "stopped" beside a switch saying
  // leads can book (L646). An outcome that goes ABSENT keeps the notice, because
  // that is the server re-rendering after the param below was stripped, not a
  // new save.
  const incomingKey = incoming ? `${incoming.kind}:${incoming.message}` : null;
  const shownKey = notice ? `${notice.kind}:${notice.message}` : null;
  if (incoming && incomingKey !== shownKey) setNotice(incoming);

  // #2384: every outcome parameter, from the one list, not the two this knew
  // about. The webhooks page carries its action results in `?resend=` and
  // `?replay=`, and a parameter left in the address bar re-shows the notice on a
  // reload or a copied link, which is the stale confirmation this effect exists
  // to prevent, wearing a different parameter name. Re-run per outcome, so the
  // second save's parameter is stripped as well as the first's.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (OUTCOME_PARAMS.some((p) => url.searchParams.has(p))) {
      for (const p of OUTCOME_PARAMS) url.searchParams.delete(p);
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  }, [incomingKey]);

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
      // #1997: `text-pennie-graphite`, NOT `text-fg`.
      //
      // The green wash is a RAW token: it is the same pale green in both themes,
      // deliberately, because a status colour that flipped would stop meaning
      // "this went well". `--fg` is not raw, and in dark it is a near white. So
      // this drew near white text on a pale green panel: present in the DOM,
      // correctly announced to a screen reader, and invisible on screen (L213).
      //
      // Found by screenshotting both themes at a real week, which #1997 asked
      // for. It had shipped on every save confirmation on every admin page.
      //
      // Graphite on this wash is 11.58:1 and is asserted by name in
      // scripts/test-contrast.ts, so the pair cannot drift apart again.
      className="rounded-md bg-[var(--pennie-green-wash)] px-5 py-4 text-sm text-pennie-graphite"
    >
      {notice.message}
    </div>
  );
}
