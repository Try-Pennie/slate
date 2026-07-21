// Behavior lock for selfHealDataAnomalies (#573): when the availability monitor
// classifies a bucket as a DATA ANOMALY (cache shows no times but a live recompute
// finds some), it self-heals by rewriting the fresh row, but only ONCE per bucket
// per window (a persistent fault must keep paging, not be silently masked) and it
// must fail loud per bucket without aborting the rest.
//
// Driven through hand-written fakes (claim/heal/onError), no DB or cron. Run:
//   node --experimental-strip-types scripts/test-anomaly-selfheal.ts
import { selfHealDataAnomalies } from "@/lib/monitor/anomaly-selfheal";
import { assert, finish } from "./lib/harness.ts";

async function main() {
  // 1. A claimable anomaly bucket is healed.
  {
    const healedCalls: string[] = [];
    const r = await selfHealDataAnomalies(["311"], {
      claim: async () => true,
      heal: async (c) => {
        healedCalls.push(c);
      },
    });
    assert(r.healed.join() === "311", `heals a claimable bucket (got ${JSON.stringify(r)})`);
    assert(healedCalls.join() === "311", "calls heal exactly for the claimed bucket");
    assert(r.skipped.length === 0 && r.failed.length === 0, "no skips or failures on the happy path");
  }

  // 2. Already-healed-this-window bucket is skipped and heal is NOT called (the
  //    once-per-window guard, so a persistent fault is not silently re-masked).
  {
    let healCalls = 0;
    const r = await selfHealDataAnomalies(["311"], {
      claim: async () => false, // lock already held this window
      heal: async () => {
        healCalls++;
      },
    });
    assert(r.skipped.join() === "311", `skips when the window lock is held (got ${JSON.stringify(r)})`);
    assert(healCalls === 0, "does NOT heal a bucket already healed this window");
    assert(r.healed.length === 0, "nothing reported healed when skipped");
  }

  // 3. FAILURE PATH: a heal that throws is reported failed and surfaced via onError,
  //    and it does NOT abort the remaining buckets (fail loud, keep going).
  {
    const errors: string[] = [];
    const healed: string[] = [];
    const r = await selfHealDataAnomalies(["a", "boom", "c"], {
      claim: async () => true,
      heal: async (c) => {
        if (c === "boom") throw new Error("recompute blew up");
        healed.push(c);
      },
      onError: (code) => errors.push(code),
    });
    assert(r.failed.join() === "boom", `surfaces the failed bucket (got ${JSON.stringify(r)})`);
    assert(errors.join() === "boom", "reports the failure via onError (fail loud, not silent)");
    assert(r.healed.join() === "a,c", "keeps healing the other buckets after one throws");
  }

  // 4. Mixed set: heal + skip + fail partition cleanly.
  {
    const r = await selfHealDataAnomalies(["heal", "held", "err"], {
      claim: async (c) => c !== "held",
      heal: async (c) => {
        if (c === "err") throw new Error("x");
      },
    });
    assert(r.healed.join() === "heal", `mixed: healed set (got ${JSON.stringify(r)})`);
    assert(r.skipped.join() === "held", "mixed: skipped set");
    assert(r.failed.join() === "err", "mixed: failed set");
  }

  // 5. Empty input is a clean no-op.
  {
    const r = await selfHealDataAnomalies([], { claim: async () => true, heal: async () => {} });
    assert(r.healed.length === 0 && r.skipped.length === 0 && r.failed.length === 0, "empty input yields empty result");
  }

  finish();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
