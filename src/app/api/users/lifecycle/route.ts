import { makeLifecycleActionHandler } from "@/lib/offboarding/route-handler";

export const dynamic = "force-dynamic";

// Consolidated offboarding lifecycle endpoint (#282): one URL taking
// { email, action: "activate" | "deactivate" }. The offboarding automation
// integrates against this single endpoint; /api/users/deactivate and
// /api/users/reactivate stay working for callers not yet migrated.
export const POST = makeLifecycleActionHandler();
