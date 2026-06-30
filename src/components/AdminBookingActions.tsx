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

type Mode = null | "cancel" | "reschedule" | "reassign";

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
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [reasonCode, setReasonCode] = useState("");
  const [reasonDetail, setReasonDetail] = useState("");
  // Reassign state.
  const [agents, setAgents] = useState<ReassignAgent[]>([]);
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
    setSlots([]);
    setAgents([]);
    setAgentQuery("");
    setCapWarn(null);
  }

  async function openReschedule() {
    setMode("reschedule");
    setError(null);
    setReasonCode("");
    setReasonDetail("");
    if (!bucketCode) return;
    const r = await fetch(`/api/availability?bucket=${encodeURIComponent(bucketCode)}`, {
      cache: "no-store",
    });
    const d = r.ok ? await r.json() : { slots: [] };
    setSlots(d.slots ?? []);
  }

  async function openReassign() {
    setMode("reassign");
    setError(null);
    setReasonCode("");
    setReasonDetail("");
    setCapWarn(null);
    setAgentQuery("");
    // Load the agent list on open (minimal fields), not into every row up front.
    const r = await fetch(`/api/admin/agents`, { cache: "no-store" });
    const d = r.ok ? await r.json() : { agents: [] };
    setAgents(d.agents ?? []);
  }

  async function doCancel() {
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/admin/bookings/${bookingId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: reasonCode, reasonDetail: reasonDetail || undefined }),
    });
    if (r.ok) {
      reset();
      router.refresh();
    } else {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "Could not cancel. Please try again.");
    }
    setBusy(false);
  }

  async function doReschedule(start: string) {
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/admin/bookings/${bookingId}/reschedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start, reason: reasonCode, reasonDetail: reasonDetail || undefined }),
    });
    if (r.ok) {
      reset();
      router.refresh();
    } else {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "Could not reschedule. Please try again.");
    }
    setBusy(false);
  }

  // overrideCap=true is the manager's second confirm after an at-cap warning (#546).
  async function doReassign(agentEmail: string, overrideCap: boolean) {
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/admin/bookings/${bookingId}/reassign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentEmail,
        reason: reasonCode,
        reasonDetail: reasonDetail || undefined,
        overrideCap,
      }),
    });
    if (r.ok) {
      reset();
      router.refresh();
    } else {
      const d = await r.json().catch(() => ({}));
      if (d.code === "DAILY_CAP_EXCEEDED") {
        // First attempt declined: surface the warning + offer the two-step override.
        setCapWarn({ email: agentEmail, day: d.day ?? "" });
      } else {
        setError(d.error ?? "Could not reassign. Please try again.");
      }
    }
    setBusy(false);
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
          <div className="grid grid-cols-2 gap-1">
            {slots.slice(0, 12).map((iso) => (
              <button
                key={iso}
                disabled={busy || !reasonValid}
                onClick={() => doReschedule(iso)}
                className="min-h-9 rounded-md border border-border bg-surface px-1 py-1 text-xs tabular-nums text-fg hover:border-fg/45 disabled:opacity-60"
              >
                {new Date(iso).toLocaleString("en-US", {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </button>
            ))}
            {slots.length === 0 && <p className="col-span-2 text-xs text-fg-muted">No open times.</p>}
          </div>
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
                {rankedAgents.length === 0 && (
                  <p className="px-2 py-2 text-xs text-fg-muted">No matching agents.</p>
                )}
              </div>
              <button onClick={reset} disabled={busy} className="mt-2 min-h-9 rounded-md border border-border px-3 py-1 text-xs text-fg">
                Back
              </button>
            </>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}
    </div>
  );
}
