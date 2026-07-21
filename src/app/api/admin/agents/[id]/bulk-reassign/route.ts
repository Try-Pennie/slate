import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireBookingActor } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import { parseBulkReassignRange } from "@/lib/booking/bulk-reassign";
import { validateReason } from "@/lib/booking/core";
import {
  getBulkReassignProgress,
  previewBulkReassign,
  startBulkReassign,
} from "@/lib/booking/service";
import { internalErrorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const startSchema = z.object({
  from: z.string().optional(),
  to: z.string().nullable().optional(),
  reason: z.string().optional(),
  reasonDetail: z.string().optional(),
});

/**
 * Start a bulk coverage reassign for one out agent over a date range (#974).
 * Manager+ gated (requireBookingActor), matching the single-reassign route and
 * the agent-detail page's own canManageAgents gate: whoever can reassign one
 * booking can reassign this agent's upcoming bookings in bulk. The accountable
 * actor is recorded on the job (created_by / acting_as_user_id, #549).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let actor: Awaited<ReturnType<typeof requireBookingActor>>;
  try {
    actor = await requireBookingActor();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const { id } = await params;
  const parsed = startSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const range = parseBulkReassignRange(parsed.data.from, parsed.data.to, new Date().toISOString());
  if (!range.ok) {
    return NextResponse.json({ error: range.error }, { status: 400 });
  }
  const reason = validateReason("reassign", {
    code: parsed.data.reason,
    detail: parsed.data.reasonDetail,
  });
  if (!reason.ok) {
    return NextResponse.json({ error: reason.error }, { status: 400 });
  }

  try {
    const { jobId, itemCount } = await startBulkReassign({
      outUserId: id,
      rangeStartIso: range.rangeStart,
      rangeEndIso: range.rangeEnd,
      reason: reason.reason,
      actor,
    });
    return NextResponse.json({ jobId, itemCount });
  } catch (err) {
    return internalErrorResponse(err, "admin/agents/[id]/bulk-reassign:start");
  }
}

/**
 * Read either a preview count (no jobId: `?from&to`) or a running job's progress
 * (`?jobId`). Manager+ gated. Progress carries the per-status counts and the
 * actionable "couldn't place" list the UI links to the single-reassign override.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireBookingActor();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const { id } = await params;
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");

  try {
    if (jobId) {
      const progress = await getBulkReassignProgress(jobId);
      if (!progress || progress.job.out_user_id !== id) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json(progress);
    }
    const range = parseBulkReassignRange(
      url.searchParams.get("from"),
      url.searchParams.get("to"),
      new Date().toISOString(),
    );
    if (!range.ok) {
      return NextResponse.json({ error: range.error }, { status: 400 });
    }
    const count = await previewBulkReassign(id, range.rangeStart, range.rangeEnd);
    return NextResponse.json({ count });
  } catch (err) {
    return internalErrorResponse(err, "admin/agents/[id]/bulk-reassign:read");
  }
}
