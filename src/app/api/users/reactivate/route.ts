import { makeLifecycleHandler } from "@/lib/offboarding/route-handler";

export const dynamic = "force-dynamic";

// Offboarding reactivate (#264/#265): restore a boomerang rehire by clearing
// deactivated_at. Symmetric with /api/users/deactivate; no data loss.
//
// Appointments that MOVED while they were gone stay moved (#1241, matching
// #1219's decision for time off). Reactivating puts them back in the routing pool
// for new bookings; it is not an undo. The customers whose appointments were
// covered have already been told who they are now meeting, and moving them a
// second time to unwind an absence is a worse outcome than the reassignment they
// accepted. `planOffboardingCoverageSweep` is where that is enforced and tested.
export const POST = makeLifecycleHandler("reactivate");
