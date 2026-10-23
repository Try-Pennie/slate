import { NextResponse, type NextRequest } from "next/server";
import { requireManager } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import { searchBookings } from "@/lib/booking/search";
import { internalErrorResponse } from "@/lib/api/errors";
import { crossOriginRefusal } from "@/lib/api/same-origin";
import { PUBLIC_JSON_MAX_BYTES, readJsonCapped } from "@/lib/http/read-json-capped";

export const dynamic = "force-dynamic";

/**
 * Booking lookup for the history viewer (#901): find bookings by attendee
 * email/name/phone or booking id. Manager+ gated (matches the other admin
 * booking routes) and tenant-scoped via the caller's org. A read fault surfaces
 * as 500, never an empty 200.
 *
 * #3399: the term is a lead's contact details, so it arrives in the request BODY,
 * `{ q }`, never the address. Cloudflare records every request's full address,
 * query string included, before any code here runs, so a term in the address
 * would sit in the Worker's logs whatever this route did with it (L752). The
 * embed's `/book` address is the deliberate exception (#3362); this is a staff
 * search box, and nothing is lost by keeping the term out of the logs.
 *
 * POST makes it a subject of the same-origin refusal (#1046), which a read does
 * not need but costs nothing.
 */
export async function POST(req: NextRequest) {
  const crossOrigin = crossOriginRefusal(req, "admin/bookings/search");
  if (crossOrigin) return crossOrigin;

  let me: Awaited<ReturnType<typeof requireManager>>;
  try {
    me = await requireManager();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const read = await readJsonCapped(req, PUBLIC_JSON_MAX_BYTES);
  if (read.tooLarge) {
    return NextResponse.json({ error: "That search is too long." }, { status: 413 });
  }
  if (read.value === null || typeof read.value !== "object") {
    return NextResponse.json({ error: "Send the search as JSON: { q }." }, { status: 400 });
  }
  const raw = (read.value as { q?: unknown }).q;
  const q = typeof raw === "string" ? raw : "";
  try {
    const { rows, truncated } = await searchBookings(me.org_id, q);
    return NextResponse.json({ bookings: rows, truncated });
  } catch (err) {
    return internalErrorResponse(err, "admin/bookings/search");
  }
}

/**
 * The old address form, refused BY NAME (#3399), so a caller still building
 * `?q=` learns where the term goes instead of meeting a bare 405. It reads
 * nothing from the request: the term is already in the platform's log by the
 * time this runs, and repeating it anywhere would only add a second copy.
 */
export async function GET() {
  return NextResponse.json(
    { error: "Booking search takes its term in the request body: POST { q }, never ?q= in the address." },
    { status: 405, headers: { Allow: "POST" } },
  );
}
