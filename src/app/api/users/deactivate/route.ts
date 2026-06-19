import { makeLifecycleHandler } from "@/lib/offboarding/route-handler";

export const dynamic = "force-dynamic";

// Offboarding deactivate (#264/#265): the existing offboarding automation POSTs
// here when someone leaves. Deactivate-not-delete — keeps history; reversible
// via /api/users/reactivate.
export const POST = makeLifecycleHandler("deactivate");
