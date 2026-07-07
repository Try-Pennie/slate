"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  RESCHEDULE_REASONS,
  CANCEL_REASONS,
  REASSIGN_REASONS,
  validateReason,
  type ReasonAction,
} from "@/lib/booking/core";
import { rankReassignAgents, type ReassignAgent } from "@/lib/booking/reassign-agents";
import ReasonPicker from "@/components/ReasonPicker";
import { AsyncListStates, useFetchList } from "@/components/AsyncList";
import { postJson, REQUEST_TIMEOUT_MS } from "@/lib/http";
import { useStalledAfter } from "@/lib/useStalledAfter";
import { formatSlotTime, groupSlotsByDay } from "@/lib/booking/slot-label";

type Mode = null | "cancel" | "reschedule" | "reassign";

const extractSlots = (json: unknown): string[] =>
  (json as { slots?: string[] } | null)?.slots ?? [];
const extractAgents = (json: unknown): ReassignAgent[] =>
  (json as { agents?: ReassignAgent[] } | null)?.agents ?? [];

/**
 * Internal admin reschedule / cancel / reassign for a single booking (#326, #546).
 * Staff act on a booking from the recent-bookings list; every action REQUIRES a
 * reason (recorded with initiator='admin' and the acting user, #549). Reuses the
 * same mandatory ReasonPicker + server-side validation as the customer manage-link.
 */
export default function AdminBookingActions({
  bookingId,
  bucketCode,
  status,
  currentAgentId,
}: {
  bookingId: string;
  bucketCode: string | null;
  status: string;
  /** The booking's current agent, excluded from the reassign picker (#546). */
  currentAgentId?: string | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  // Still-alive cue if an admin action POST hasn't returned by ~10s; the
  // REQUEST_TIMEOUT_MS abort converts a true hang into the error below (#626).
  const stalled = useStalledAfter(busy);
  const [error, setError] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState("");
  const [reasonDetail, setReasonDetail] = useState("");
  // Reschedule + reassign lists share one fetch+state hook (#627): loading and
  // error are distinct from empty, so neither panel shows "no times"/"no agents"
  // while its fetch is still in flight or after it failed.
  const {
    items: slots,
    loading: slotsLoading,
    error: slotsError,
    retry: retrySlots,
  } = useFetchList(
    bucketCode ? `/api/availability?bucket=${encodeURIComponent(bucketCode)}` : null,
    mode === "reschedule",
    extractSlots,
  );
  const {
    items: agents,
    loading: agentsLoading,
    error: agentsError,
    retry: retryAgents,
  } = useFetchList(`/api/admin/agents`, mode === "reassign", extractAgents);
  // Reassign search box.
  const [agentQuery, setAgentQuery] = useState("");
  // Set when the chosen target is at their daily cap: drives the two-step override.
  const [capWarn, setCapWarn] = useState<{ email: string; day: string } | null>(null);

  // Only confirmed/rescheduled bookings can be changed.
  if (status === "cancelled" || status === "completed") {
    return <span className="text-fg-muted capitalize">{status}</span>;
  }

  const action: ReasonAction =
    mode === "reschedule" ? "reschedule" : mode === "reassign" ? "reassign" : "cancel";
  const reasonValid = validateReason(action, { code: reasonCode, detail: reasonDetail }).ok;

  function reset() {
    setMode(null);
    setError(null);
    setReasonCode("");
    setReasonDetail("");
    setAgentQuery("");
    setCapWarn(null);
  }

  // Opening a panel just switches mode; the two useFetchList hooks fetch the
  // slot / agent lists declaratively off `mode` (with loading + error states).
  function openReschedule() {
    setMode("reschedule");
    setError(null);
    setReasonCode("");
    setReasonDetail("");
  }

  function openReassign() {
    setMode("reassign");
    setError(null);
    setReasonCode("");
    setReasonDetail("");
    setCapWarn(null);
    setAgentQuery("");
  }

  async function doCancel() {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await postJson<{ error?: string }>(
        `/api/admin/bookings/${bookingId}/cancel`,
        { reason: reasonCode, reasonDetail: reasonDetail || undefined },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (ok) {
        reset();
        router.refresh();
      } else {
        setError(data.error ?? "Could not cancel. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function doReschedule(start: string) {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await postJson<{ error?: string }>(
        `/api/admin/bookings/${bookingId}/reschedule`,
        { start, reason: reasonCode, reasonDetail: reasonDetail || undefined },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (ok) {
        reset();
        router.refresh();
      } else {
        setError(data.error ?? "Could not reschedule. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  // overrideCap=true is the manager's second confirm after an at-cap warning (#546).
  async function doReassign(agentEmail: string, overrideCap: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await postJson<{ error?: string; code?: string; day?: string }>(
        `/api/admin/bookings/${bookingId}/reassign`,
        {
          agentEmail,
          reason: reasonCode,
          reasonDetail: reasonDetail || undefined,
          overrideCap,
        },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (ok) {
        reset();
        router.refresh();
      } else if (data.code === "DAILY_CAP_EXCEEDED") {
        // First attempt declined: surface the warning + offer the two-step override.
        setCapWarn({ email: agentEmail, day: data.day ?? "" });
      } else {
        setError(data.error ?? "Could not reassign. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (mode === null) {
    return (
      <div className="flex gap-2">
        <button
          onClick={openReschedule}
          className="min-h-9 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg hover:border-fg/45"
        >
          Reschedule
        </button>
        <button
          onClick={openReassign}
          className="min-h-9 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg hover:border-fg/45"
        >
          Reassign
        </button>
        <button
          onClick={() => setMode("cancel")}
          className="min-h-9 rounded-md border border-[var(--error)] px-2 py-1 text-xs font-semibold text-[var(--error)] hover:bg-[rgba(196,61,61,0.06)]"
        >
          Cancel
        </button>
      </div>
    );
  }

  const reasonOptions =
    mode === "cancel" ? CANCEL_REASONS : mode === "reassign" ? REASSIGN_REASONS : RESCHEDULE_REASONS;
  const reasonLegend =
    mode === "cancel"
      ? "Why are you cancelling?"
      : mode === "reassign"
        ? "Why are you reassigning?"
        : "Why are you rescheduling?";

  const rankedAgents = rankReassignAgents(agents, agentQuery, currentAgentId);

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <ReasonPicker
        legend={reasonLegend}
        options={reasonOptions}
        code={reasonCode}
        detail={reasonDetail}
        onCode={setReasonCode}
        onDetail={setReasonDetail}
        idPrefix={`admin-${mode}-${bookingId}`}
      />

      {mode === "cancel" && (
        <div className="mt-3 flex gap-2">
          <button
            onClick={doCancel}
            disabled={busy || !reasonValid}
            className="min-h-9 rounded-md bg-[var(--error)] px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
          >
            {busy ? "Cancelling…" : "Confirm cancel"}
          </button>
          <button onClick={reset} disabled={busy} className="min-h-9 rounded-md border border-border px-3 py-1 text-xs text-fg">
            Back
          </button>
        </div>
      )}

      {mode === "reschedule" && (
        <div className="mt-3">
          <p className="mb-2 text-xs font-semibold text-fg">
            {reasonValid ? "Pick a new time" : "Choose a reason above, then pick a new time"}
          </p>
          <AsyncListStates
            loading={slotsLoading}
            error={slotsError}
            isEmpty={slots.length === 0}
            onRetry={retrySlots}
            loadingLabel="Loading available times"
            resultLabel={`${slots.length} time${slots.length === 1 ? "" : "s"} available`}
            emptyLabel="No open times"
            skeletonCount={6}
            skeletonClassName="h-9"
            containerClassName="grid grid-cols-2 gap-1"
            emptyNode={<p className="text-xs text-fg-muted">No open times.</p>}
          >
            {/* Grouped by dated day heading (#635): times read unambiguously and
                the full horizon shows with no silent slice(0,12) cap. */}
            <div className="space-y-3">
              {groupSlotsByDay(slots).map((day) => (
                <div key={day.key}>
                  <p className="mb-1 text-xs font-semibold tabular-nums text-fg">
                    {day.heading}
                  </p>
                  <div className="grid grid-cols-2 gap-1">
                    {day.slots.map((iso) => (
                      <button
                        key={iso}
                        disabled={busy || !reasonValid}
                        onClick={() => doReschedule(iso)}
                        className="min-h-9 rounded-md border border-border bg-surface px-1 py-1 text-xs tabular-nums text-fg hover:border-fg/45 disabled:opacity-60"
                      >
                        {formatSlotTime(iso)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </AsyncListStates>
          <button onClick={reset} disabled={busy} className="mt-2 min-h-9 rounded-md border border-border px-3 py-1 text-xs text-fg">
            Back
          </button>
        </div>
      )}

      {mode === "reassign" && (
        <div className="mt-3">
          {capWarn ? (
            <div className="rounded-md border border-[var(--error)] bg-[rgba(196,61,61,0.06)] p-2">
              <p className="text-xs text-fg">
                {capWarn.email} is at their daily cap{capWarn.day ? ` on ${capWarn.day}` : ""}.
                Reassign anyway?
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => doReassign(capWarn.email, true)}
                  disabled={busy}
                  className="min-h-9 rounded-md bg-[var(--error)] px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {busy ? "Reassigning…" : "Reassign anyway"}
                </button>
                <button onClick={() => setCapWarn(null)} disabled={busy} className="min-h-9 rounded-md border border-border px-3 py-1 text-xs text-fg">
                  Back
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="mb-2 text-xs font-semibold text-fg">
                {reasonValid ? "Choose an agent to reassign to" : "Choose a reason above, then pick an agent"}
              </p>
              <input
                type="text"
                value={agentQuery}
                onChange={(e) => setAgentQuery(e.target.value)}
                placeholder="Search agents…"
                aria-label="Search agents"
                className="mb-2 min-h-9 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg"
              />
              <div className="max-h-48 overflow-y-auto rounded-md border border-border">
                <AsyncListStates
                  loading={agentsLoading}
                  error={agentsError}
                  isEmpty={rankedAgents.length === 0}
                  onRetry={retryAgents}
                  loadingLabel="Loading agents"
                  resultLabel={`${rankedAgents.length} agent${rankedAgents.length === 1 ? "" : "s"} available`}
                  emptyLabel="No matching agents"
                  skeletonCount={5}
                  skeletonClassName="mx-2 my-1 h-7"
                  emptyNode={<p className="px-2 py-2 text-xs text-fg-muted">No matching agents.</p>}
                >
                  {rankedAgents.slice(0, 30).map((a) => (
                    <button
                      key={a.id}
                      disabled={busy || !reasonValid}
                      onClick={() => doReassign(a.email, false)}
                      className={`flex min-h-9 w-full items-center justify-between px-2 py-1 text-left text-xs text-fg hover:bg-fg/[0.06] disabled:opacity-60 ${
                        a.bookable ? "bg-surface" : "bg-fg/[0.04]"
                      }`}
                    >
                      <span>{a.name ?? a.email}</span>
                      {!a.bookable && <span className="text-fg-muted">not in rotation</span>}
                    </button>
                  ))}
                </AsyncListStates>
              </div>
              <button onClick={reset} disabled={busy} className="mt-2 min-h-9 rounded-md border border-border px-3 py-1 text-xs text-fg">
                Back
              </button>
            </>
          )}
        </div>
      )}

      {busy && stalled && !error && (
        <p role="status" className="mt-2 text-xs text-fg-muted">
          Still working… this is taking longer than usual.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}
    </div>
  );
}
