import ViewerTime from "@/components/ViewerTime";
import { cardCls } from "@/components/ui/styles";
import { BOOKING_API_CALLERS, type BookingApiCaller } from "@/lib/booking/api-auth";
import {
  CALLER_HOST_KINDS,
  PARTNER_KEY_MAX_AGE_DAYS,
  judgePartnerKey,
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

/**
 * Which host each booking API key has authenticated from, and when (#2717). The
 * partner line is `judgePartnerKey`, the judge `pnpm verify:parallel-run-readiness`
 * exits on, so the page and the gate say the same thing about the same rows.
 */
export function CallerSightings({ rows, now }: { rows: CallerSeenRow[]; now: number }) {
  const verdict = judgePartnerKey(GATED_CALLER, rows, now, PARTNER_KEY_MAX_AGE_DAYS * 86_400_000);
  // The judge's own sentence in every state, in the words the gate prints. Only a
  // production host passes; a call that named no host is reported, not proof (#2868).
  const partnerLine = `${verdict.detail}.`;
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
            {BOOKING_API_CALLERS.flatMap((caller) => {
              const mine = rows
                .filter((r) => r.caller === caller)
                .sort((a, b) => CALLER_HOST_KINDS.indexOf(a.host_kind) - CALLER_HOST_KINDS.indexOf(b.host_kind));
              if (mine.length === 0) {
                return [
                  <tr key={caller}>
                    <th scope="row" className="px-4 py-2.5 text-left font-semibold text-fg">{CALLER_LABEL[caller]}</th>
                    <td className="px-3 py-2.5 text-fg-muted" colSpan={2}>Never</td>
                  </tr>,
                ];
              }
              return mine.map((r, i) => (
                <tr key={`${caller}:${r.host_kind}`}>
                  {i === 0 && (
                    <th scope="row" rowSpan={mine.length} className="px-4 py-2.5 text-left align-top font-semibold text-fg">
                      {CALLER_LABEL[caller]}
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
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
