import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { readFrameLockSetting } from "@/lib/embed/frame-guard";
import {
  FRAME_ANCESTOR_ALLOW_LIST,
  summarizeFrameOrigins,
  type FrameOriginRow,
  type FrameOriginSummary,
} from "@/lib/embed/frame-policy";
import { FrameLockSwitch } from "@/components/admin/FrameLockSwitch";
import { readEmbedPrerenderSetting } from "@/lib/embed/prerender-switch";
import { EmbedPrerenderSwitch } from "@/components/admin/EmbedPrerenderSwitch";
import ViewerTime from "@/components/ViewerTime";
import { FRAME_DAY_ZONE } from "@/lib/embed/frame-observe";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import { cardCls, proseCls } from "@/components/ui/styles";

export const metadata = { title: "Embedding" };

export const dynamic = "force-dynamic";

/** How far back the record is read. Long enough to catch a partner who embeds weekly. */
const WINDOW_DAYS = 14;

// Module scope so the clock read does not trip react-hooks/purity in render. The window
// starts on the business zone's day boundary, which is the one `record_frame_origins`
// keys its rows by (migration 0162).
function sinceIso(): string {
  return DateTime.now().setZone(FRAME_DAY_ZONE).minus({ days: WINDOW_DAYS - 1 }).toISODate() ?? "";
}

const SURFACE_LABEL: Record<string, string> = {
  book: "booker",
  "advisor-link": "advisor link",
  confirmation: "confirmation",
  manage: "manage",
  rebook: "rebook",
  other: "other",
};

/** What each row names, in words a reader can act on. */
function originLabel(s: FrameOriginSummary): string {
  if (s.kind === "self") return "Inside the booker's own frame";
  if (s.origin === "(other)") return "Other sites, past the daily limit";
  if (s.kind === "unnamed") return "No site named";
  return s.origin;
}

const KIND_LABEL: Record<FrameOriginSummary["kind"], string> = {
  refused: "Not on the allow list",
  allowed: "On the allow list",
  self: "",
  unnamed: "",
};

/**
 * Who frames the booker, and the lock (#3137).
 *
 * The record is the OBSERVE half: every framed load of the booker or a page it moves
 * to, counted per day by framing site and page. The switch is the LOCK half, off by
 * default, and the record is on the same page as the switch so nobody locks without
 * seeing who it would turn away.
 */
export default async function EmbeddingPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const saved = savedSentence(savedOutcome(sp.ok));
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;

  const db = supabaseAdmin();
  const [locked, prerenderOn, rowsRead] = await Promise.all([
    readFrameLockSetting(),
    // #3706: fresh, never the endpoint's cache, and null when unreadable.
    readEmbedPrerenderSetting(),
    // Up to 200 sites a day for 14 days can pass one page, so this pages. A failed
    // read is its own state, never an empty table, which would read as nobody framing
    // the booker (L10).
    selectAllPages<FrameOriginRow>("frame_origin_daily", ["day", "origin", "surface"], () =>
      db
        .from("frame_origin_daily")
        .select("day, origin, surface, loads, last_seen")
        .gte("day", sinceIso()),
    ).then(
      (rows) => ({ ok: true as const, rows }),
      (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }),
    ),
  ]);

  const summary = rowsRead.ok ? summarizeFrameOrigins(rowsRead.rows) : null;
  const refusedSites = summary ? summary.filter((s) => s.kind === "refused").length : null;
  // Days the per day limit on sites outside the allow list was reached, so the
  // "(other)" row reads as a limit having been hit rather than as one more site.
  const cappedDays = rowsRead.ok
    ? new Set(rowsRead.rows.filter((r) => r.origin === "(other)").map((r) => r.day)).size
    : 0;

  return (
    <>
      <AdminPageHeader title="Embedding">
        The booker runs inside other sites&apos; pages. Locking framing means only Slate and the
        sites on the allow list can show it, so nobody else can put a live booker, or a
        lead&apos;s manage page, inside a page of their own.
      </AdminPageHeader>

      {saved && <SettingsSaveNotice ok saved={saved} error={sp.error} />}
      {sp.error && !saved && <SettingsSaveNotice ok={false} error={sp.error} saved="" />}

      <section className={cardCls}>
        <h2 className="mb-3 text-sm font-semibold">Framing lock</h2>
        <FrameLockSwitch
          locked={locked}
          refusedSites={refusedSites}
          foldedSites={cappedDays > 0}
          windowDays={WINDOW_DAYS}
        />
        <p className={`mt-4 ${proseCls} text-xs text-fg-muted`}>
          Allow list: {FRAME_ANCESTOR_ALLOW_LIST.join(", ")}.
        </p>
      </section>

      <section className={cardCls} data-section="prerender">
        <h2 className="mb-3 text-sm font-semibold">Booker on page load</h2>
        <EmbedPrerenderSwitch on={prerenderOn} />
      </section>

      <section className={cardCls}>
        <h2 className="text-sm font-semibold">Who framed the booker, last {WINDOW_DAYS} days</h2>
        {!rowsRead.ok ? (
          <p role="alert" className="mt-2 text-sm text-error">
            Could not read who has framed the booker: {rowsRead.message}.
          </p>
        ) : summary!.length === 0 ? (
          <p className="mt-2 text-sm text-fg-muted">
            No framed booker loads recorded in the last {WINDOW_DAYS} days.
          </p>
        ) : (
          <>
          {cappedDays > 0 && (
            <p data-notice="capped" className="mt-2 text-sm text-fg">
              On {cappedDays} {cappedDays === 1 ? "day" : "days"}, more sites outside the allow list
              framed the booker than are named one by one. The rest are counted together as other
              sites. Sites on the allow list are always named.
            </p>
          )}
          <div className="mt-3 overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border bg-[var(--bg-alt)] text-left text-xs text-fg-muted">
                  <th scope="col" className="px-4 py-2.5 font-semibold">Site</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-semibold">Loads</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Pages</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {summary!.map((s) => (
                  <tr key={s.origin} data-kind={s.kind}>
                    <td className="px-4 py-2.5">
                      <span className={s.kind === "refused" ? "font-semibold text-fg" : "text-fg"}>
                        {originLabel(s)}
                      </span>
                      {KIND_LABEL[s.kind] && (
                        <span className="block text-xs text-fg-muted">{KIND_LABEL[s.kind]}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{s.loads}</td>
                    <td className="px-3 py-2.5 text-xs text-fg-muted">
                      {Object.entries(s.surfaces)
                        .sort((a, b) => b[1] - a[1])
                        .map(([surface, n]) => `${SURFACE_LABEL[surface] ?? surface} ${n}`)
                        .join(", ")}
                    </td>
                    <td className="px-4 py-2.5 text-xs tabular-nums text-fg-muted">
                      <ViewerTime iso={s.lastSeen} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>
    </>
  );
}
