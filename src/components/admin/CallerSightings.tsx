import ViewerTime from "@/components/ViewerTime";
import { cardCls } from "@/components/ui/styles";
import { BOOKING_API_CALLERS, type BookingApiCaller } from "@/lib/booking/api-auth";
import {
  CALLER_HOST_KINDS,
  PARTNER_KEY_MAX_AGE_DAYS,
  judgePartnerKey,
  probeCallerName,
  type CallerHostKind,
  type CallerSeenRow,
} from "@/lib/booking/caller-seen";

const CALLER_LABEL: Record<BookingApiCaller, string> = {
  regal: "Regal",
  trypennie: "trypennie",
  canary: "Smoke canary",
};

const HOST_LABEL: Record<CallerHostKind, string> = {
  production: "Production site",
  localhost: "Localhost",
  "other-host": "Another host",
  unstated: "No host named",
};

/** The partner whose key the flip morning gate requires (#2717). */
const GATED_CALLER: BookingApiCaller = "trypennie";

/** One key's sightings as table rows: its label once, then a row per host kind. */
function sightingRows(key: string, label: string, mine: CallerSeenRow[]) {
  const sorted = [...mine].sort((a, b) => CALLER_HOST_KINDS.indexOf(a.host_kind) - CALLER_HOST_KINDS.indexOf(b.host_kind));
  if (sorted.length === 0) {
    return [
      <tr key={key}>
        <th scope="row" className="px-4 py-2.5 text-left font-semibold text-fg">{label}</th>
        <td className="px-3 py-2.5 text-fg-muted" colSpan={2}>Never</td>
      </tr>,
    ];
  }
  return sorted.map((r, i) => (
    <tr key={`${key}:${r.host_kind}`}>
      {i === 0 && (
        <th scope="row" rowSpan={sorted.length} className="px-4 py-2.5 text-left align-top font-semibold text-fg">
          {label}
        </th>
      )}
      <td className="px-3 py-2.5">
        {r.origin ? <span className="font-mono text-xs">{r.origin}</span> : <span className="text-fg-muted">{HOST_LABEL[r.host_kind]}</span>}
      </td>
      <td className="px-4 py-2.5 tabular-nums text-fg-muted">
        <ViewerTime iso={r.last_seen_at} />
      </td>
    </tr>
  ));
}

/**
 * Which host each booking API key has authenticated from, and when (#2717). The
 * partner line is `judgePartnerKey`, the judge `pnpm verify:parallel-run-readiness`
 * exits on, so the page and the gate say the same thing about the same rows.
 */
export function CallerSightings({ rows, now }: { rows: CallerSeenRow[]; now: number }) {
  const verdict = judgePartnerKey(GATED_CALLER, rows, now, PARTNER_KEY_MAX_AGE_DAYS * 86_400_000);
  // The judge's own sentence in every state, so a pass says which sighting it
  // passed on (a production host or a server call) in the words the gate prints.
  const partnerLine = `${verdict.detail}.`;
  // #2868: rows recorded under probe:<caller> are Slate's own marked probes, listed
  // apart under their own heading. The judge reads only the real caller's rows.
  const probed = BOOKING_API_CALLERS.filter((caller) => rows.some((r) => r.caller === probeCallerName(caller)));
  return (
    <section className={cardCls}>
      <h2 className="text-sm font-semibold">Keys seen authenticating</h2>
      <p className={`mt-1 text-sm ${verdict.status === "proven" ? "text-fg" : "text-error"}`}>{partnerLine}</p>
      <div className="mt-3 overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-border bg-[var(--bg-alt)] text-left text-xs text-fg-muted">
              <th scope="col" className="px-4 py-2.5 font-semibold">Key</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">From</th>
              <th scope="col" className="px-4 py-2.5 font-semibold">Last success</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {BOOKING_API_CALLERS.flatMap((caller) =>
              sightingRows(caller, CALLER_LABEL[caller], rows.filter((r) => r.caller === caller)),
            )}
          </tbody>
          {probed.length > 0 && (
            <tbody className="divide-y divide-border border-t border-border">
              <tr className="bg-[var(--bg-alt)]">
                <th scope="colgroup" colSpan={3} className="px-4 py-2.5 text-left text-xs font-semibold text-fg-muted">
                  Slate&apos;s own probes, sent with the X-Slate-Probe header, never counted as the partner
                </th>
              </tr>
              {probed.flatMap((caller) =>
                sightingRows(
                  probeCallerName(caller),
                  `${CALLER_LABEL[caller]}'s key, probed by Slate`,
                  rows.filter((r) => r.caller === probeCallerName(caller)),
                ),
              )}
            </tbody>
          )}
        </table>
      </div>
    </section>
  );
}
