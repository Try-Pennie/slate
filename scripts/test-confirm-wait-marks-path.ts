// #3354: the booking path stamps the points of the wait before a confirm's profile
// where they really happen, so the spans `wait-marks.ts` derives describe the
// request rather than a guess about it. Final run 1's split was wrong because the
// line's time was assumed to be inside the profile, and it is not: a direct booking
// API confirm enters its line BEFORE the person decision and before the profile
// starts (`bookViaApi`, #3257). These pin where each point is taken.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-wait-marks-path.ts
import { bookViaApi, type ApiBookingInput } from "../src/lib/booking/orchestration.ts";
import type { WaitPoint } from "../src/lib/booking/wait-marks.ts";
import { createAsserter, makeDeps, input } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

async function run() {
  // --- a led confirm passes every point once, in the order it really runs ----------
  {
    const apiInput: ApiBookingInput = { ...input, externalId: "ext-marks", confirmReschedule: false };
    const { deps } = makeDeps({ personBookings: [] });
    const points: WaitPoint[] = [];
    deps.mark = (p) => void points.push(p);
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "created", `a led confirm books (got ${res.outcome})`);
    assert(
      points.join(",") === "line_start,line_turn,decided,profile",
      `the line is entered, then its turn is handed back, then the person decision, then the profile (got ${points.join(",")})`,
    );
  }

  // --- the line's span covers the line's whole entry, not only its enter ---------
  // The API path always passes the replay check, so the line is first asked through
  // `lookahead`, which is where the switch read and the first round trip to the line
  // happen. The first mark must come before that call, or the span would miss them.
  {
    const apiInput: ApiBookingInput = { ...input, externalId: "ext-marks-order", confirmReschedule: false };
    const { deps } = makeDeps({ personBookings: [] });
    const seen: string[] = [];
    const line = deps.confirmQueue;
    deps.confirmQueue = {
      ...line,
      lookahead: async (...a) => {
        seen.push("lookahead");
        return line.lookahead(...a);
      },
      enter: async (...a) => {
        seen.push("enter");
        const turn = await line.enter(...a);
        seen.push("entered");
        return turn;
      },
    };
    deps.mark = (p) => void seen.push(p);
    await bookViaApi(apiInput, deps);
    const order = seen.join(",");
    assert(
      order.startsWith("line_start,lookahead,enter,entered,line_turn"),
      `line_start is stamped before the lookahead and line_turn after the enter answers (got ${order})`,
    );
  }

  // --- a deployment that carries no marks books exactly as before ---------------
  {
    const apiInput: ApiBookingInput = { ...input, externalId: "ext-no-marks", confirmReschedule: false };
    const { deps } = makeDeps({ personBookings: [] });
    assert(deps.mark === undefined, "the fake starts with no marks, as production does without SLATE_LOADTEST");
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "created", "and the confirm still books with no marks at all");
  }

  finish();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
