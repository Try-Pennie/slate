import { makeLifecycleHandler } from "@/lib/offboarding/route-handler";

export const dynamic = "force-dynamic";

// Offboarding reactivate (#264/#265): restore a boomerang rehire by clearing
// deactivated_at. Symmetric with /api/users/deactivate; no data loss.
export const POST = makeLifecycleHandler("reactivate");
